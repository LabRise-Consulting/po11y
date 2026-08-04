#!/bin/sh
# One-shot bring-up of the Po11y stack. Idempotent — re-run after .env or
# workflow changes.
#
#   ./bootstrap.sh [--no-examples] [--pack <dir-or-git-url>]...
#
#   --no-examples   skip workflows/examples/ (demo feeds like HN news)
#   --pack X        import an n8n workflows repo/dir (standard n8n export
#                   format: one JSON per workflow). Git URLs are cloned into
#                   packs/<name>. NOTE: on a re-run against an already-claimed
#                   instance, CLI-imported workflows are NOT claimed by the
#                   owner — import packs on the first run, or import via the UI.
#
# Requires: docker, python3, curl (host side).
set -eu

cd "$(dirname "$0")"
ENV_FILE="${ENV_FILE:-.env}"
command -v python3 >/dev/null || { echo "bootstrap: python3 required"; exit 1; }
command -v docker  >/dev/null || { echo "bootstrap: docker required"; exit 1; }

EXAMPLES=yes
PACKS=""

# Retired core workflows, by id. Each entry is a dated liability: n8n owns this
# schema, so this raw delete is coupled to it. Drop entries once no supported
# upgrade path still carries them.
#   po11yaimap000000  retired 2026-07 (ai-map + workflow-map merged into maps.json)
# REMOVE AFTER 2026-12
RETIRED_IDS="po11yaimap000000"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-examples) EXAMPLES=no ;;
    --pack) shift; PACKS="$PACKS $1" ;;
    *) echo "bootstrap: unknown arg '$1'"; exit 64 ;;
  esac
  shift
done

# ---- 1. env file --------------------------------------------------------------
[ -f "$ENV_FILE" ] || { cp .env.example "$ENV_FILE"; echo "bootstrap: created $ENV_FILE"; }

set_env() { # set_env KEY VALUE
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    # A hand-edited .env may lack a trailing newline; appending onto that
    # last line would silently corrupt both variables.
    [ ! -s "$ENV_FILE" ] || [ -z "$(tail -c1 "$ENV_FILE")" ] || echo >> "$ENV_FILE"
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
get_env() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//'; }

# Generated secrets (kept if already set). N8N_OWNER_PASSWORD gets an 'A1'
# prefix so it always satisfies n8n's policy (>=8 chars, number, capital).
[ -n "$(get_env DB_POSTGRESDB_PASSWORD)" ] || set_env DB_POSTGRESDB_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(get_env GRAFANA_ADMIN_PASSWORD)" ] || set_env GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 16)"
[ -n "$(get_env N8N_OWNER_PASSWORD)" ]     || set_env N8N_OWNER_PASSWORD "A1$(openssl rand -hex 16)"

# Bundled OmniRoute gateway overlay — included unless OMNIROUTE_ENABLED=false.
# Its secrets (session signing, at-rest key encryption, first-boot dashboard
# password) are generated like the ones above.
OMNIROUTE="$(get_env OMNIROUTE_ENABLED)"; OMNIROUTE="${OMNIROUTE:-true}"
COMPOSE_FILES="-f docker-compose.yml"
if [ "$OMNIROUTE" != "false" ]; then
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.omniroute.yml"
  [ -n "$(get_env OMNIROUTE_JWT_SECRET)" ]     || set_env OMNIROUTE_JWT_SECRET "$(openssl rand -hex 32)"
  [ -n "$(get_env OMNIROUTE_API_KEY_SECRET)" ] || set_env OMNIROUTE_API_KEY_SECRET "$(openssl rand -hex 32)"
  [ -n "$(get_env OMNIROUTE_ADMIN_PASSWORD)" ] || set_env OMNIROUTE_ADMIN_PASSWORD "$(openssl rand -hex 16)"
fi
# Every compose call goes through this so the overlay list stays consistent.
# shellcheck disable=SC2086  # COMPOSE_FILES word-splits into -f arguments
compose() { docker compose --env-file "$ENV_FILE" $COMPOSE_FILES "$@"; }

# The read-only docker-socket-proxy (not n8n) mounts the host socket; without
# it the dashboard's containers section is simply empty.
[ -S /var/run/docker.sock ] || echo "bootstrap: warning — /var/run/docker.sock not found; containers section will be empty"

# Instance config: live copy is git-ignored, seeded from the example.
[ -f config.json ] || { cp config.example.json config.json; echo "bootstrap: created config.json from config.example.json — edit it to taste"; }
mkdir -p packs site secrets

# Optional AI-map config → a non-served file the ai-map workflow reads (env
# access is blocked inside n8n Code nodes, so config cannot come from the
# container environment). Empty values just mean the heuristic (no-LLM) map.
# Rendered before 'compose up' so the bind mount is a file, not a directory.
AI_BASE="$(get_env AI_MAP_BASE_URL)"; AI_KEY="$(get_env AI_MAP_API_KEY)"
AI_MODEL="$(get_env AI_MAP_MODEL)"
if [ "$OMNIROUTE" != "false" ] && [ -z "$AI_BASE" ]; then
  # Auto-wire to the bundled gateway. The key is a placeholder: OmniRoute's
  # /v1 needs none by default (REQUIRE_API_KEY=false), but the ai-map
  # workflow reads an empty key as "LLM off". The default model is
  # OmniRoute's free-tier auto-route, so a clean bootstrap gets LLM prose
  # with zero provider keys. Explicit AI_MAP_* always wins; set
  # OMNIROUTE_ENABLED=false (or any AI_MAP_BASE_URL) to opt out entirely.
  AI_BASE="http://omniroute:20128/v1"
  [ -n "$AI_KEY" ]   || AI_KEY="omniroute-local"
  [ -n "$AI_MODEL" ] || AI_MODEL="auto/best-free"
fi
python3 -c 'import json,sys; json.dump({"base_url":sys.argv[1],"api_key":sys.argv[2],"model":sys.argv[3]}, open("secrets/ai-map.json","w"))' \
  "$AI_BASE" "$AI_KEY" "$AI_MODEL"

BIND="$(get_env BIND_ADDR)"; BIND="${BIND:-127.0.0.1}"
# Exposure interlock: a non-loopback bind with no auth gate means the anonymous
# Grafana Viewer and every feed are readable by anything that can route to this
# box. Refuse loudly (a warning would scroll past) and BEFORE 'compose up'
# publishes any port. PO11Y_ALLOW_OPEN_BIND=1 (environment, not .env) overrides.
if [ "$BIND" != "127.0.0.1" ] && [ "$BIND" != "localhost" ] \
   && [ -z "$(get_env DASHBOARD_BASIC_AUTH)" ] \
   && [ "${PO11Y_ALLOW_OPEN_BIND:-}" != "1" ]; then
  echo "bootstrap: REFUSING — BIND_ADDR=$BIND is not loopback and"
  echo "  DASHBOARD_BASIC_AUTH is empty. Set it, or set PO11Y_ALLOW_OPEN_BIND=1."
  exit 78
fi

# ---- 2. stack up ----------------------------------------------------------------
compose up -d --build

# Host this script uses to reach n8n (readiness polls + /rest/ owner setup).
# Defaults to $BIND, but 0.0.0.0 is a bind address, not a connectable one, so
# map it to 127.0.0.1. PO11Y_CONNECT_HOST (environment only — a CI/runtime
# concern, never instance config in .env) overrides it: in CI the compose
# stack lives on a docker-in-docker daemon reachable as `docker`, not on this
# job container's localhost, so bootstrap must connect there while the stack
# still binds 0.0.0.0 to publish its ports.
CONNECT_HOST="$BIND"; [ "$CONNECT_HOST" = "0.0.0.0" ] && CONNECT_HOST="127.0.0.1"
CONNECT_HOST="${PO11Y_CONNECT_HOST:-$CONNECT_HOST}"
BASE="http://$CONNECT_HOST:5678"
# Readiness (NOT liveness): /healthz answers while first-boot DB migrations
# are still running, and a CLI import started then runs its own migration
# pass and races the server's ('duplicate key ... pg_type_typname_nsp_index').
# /healthz/readiness only turns 200 once the DB is connected and migrated.
printf 'bootstrap: waiting for n8n (db migrations on first boot) at %s ' "$BASE"
i=0
while [ $i -lt 150 ]; do
  curl -sf -o /dev/null "$BASE/healthz/readiness" && break
  printf '.'; sleep 2; i=$((i+1))
done
curl -sf -o /dev/null "$BASE/healthz/readiness" || { echo " n8n did not become ready — docker compose logs n8n"; exit 1; }
echo " up"

# ---- 3. import + publish workflows -------------------------------------------
# Order matters: import BEFORE owner setup, so the owner setup CLAIMS these
# workflows into the Personal project. n8n's CLI import does NOT assign
# ownership to an already-existing owner — owner-first leaves the workflows
# active but invisible in the UI list.
IMPORT_DIRS="/workflows/core"
[ "$EXAMPLES" = "yes" ] && IMPORT_DIRS="$IMPORT_DIRS /workflows/examples"
for p in $PACKS; do
  case "$p" in
    http*://*|git@*)
      name="$(basename "$p" .git)"
      [ -d "packs/$name" ] || git clone --quiet "$p" "packs/$name"
      IMPORT_DIRS="$IMPORT_DIRS /packs/$name" ;;
    /packs/*|/workflows/*)
      IMPORT_DIRS="$IMPORT_DIRS $p" ;;
    *)
      # host dir → copy under packs/ so the container sees it
      name="$(basename "$p")"
      [ -d "packs/$name" ] || cp -R "$p" "packs/$name"
      IMPORT_DIRS="$IMPORT_DIRS /packs/$name" ;;
  esac
done

IDS=""
for d in $IMPORT_DIRS; do
  compose exec -T n8n n8n import:workflow --separate --input="$d"
  # host path of the container dir (both live in this repo checkout)
  hostdir=".$d"
  IDS="$IDS $(python3 -c '
import json, glob, sys
for f in sorted(glob.glob(sys.argv[1] + "/*.json")):
    print(json.load(open(f)).get("id", ""))' "$hostdir")"
done
n=0
for id in $IDS; do
  [ -n "$id" ] || continue
  compose exec -T n8n n8n publish:workflow --id="$id" >/dev/null
  n=$((n+1))
done
echo "bootstrap: imported + published $n workflows"

# Retired core workflows (merged into others) — drop leftovers from earlier
# installs. See RETIRED_IDS at the top for the dated inventory.
for rid in $RETIRED_IDS; do
  compose exec -T postgres psql -U "${DB_POSTGRESDB_USER:-n8n}" \
    -d "${DB_POSTGRESDB_DATABASE:-n8n}" \
    -c "delete from workflow_entity where id='$rid';" >/dev/null 2>&1 || true
done

# Grafana's execution-analytics panels range-filter on "startedAt"; n8n ships
# composite indexes with other leading columns but no bare one, so those
# queries degrade to sequential scans as history grows. Idempotent, cheap on
# a fresh install, and n8n migrations leave foreign indexes alone.
compose exec -T postgres psql -U "${DB_POSTGRESDB_USER:-n8n}" \
  -d "${DB_POSTGRESDB_DATABASE:-n8n}" \
  -c 'CREATE INDEX IF NOT EXISTS idx_execution_entity_started_at ON execution_entity ("startedAt");' \
  >/dev/null 2>&1 || true

# Unconditional: a running instance is not guaranteed to pick up CLI-imported
# active workflows; the restart is cheap.
compose restart n8n >/dev/null
printf 'bootstrap: waiting for n8n restart '
i=0
while [ $i -lt 60 ]; do
  curl -sf -o /dev/null "$BASE/healthz/readiness" && break
  printf '.'; sleep 2; i=$((i+1))
done
echo " up"

# ---- 4. owner account (claims the imported workflows) -------------------------
NEEDS_SETUP=unknown
i=0
while [ $i -lt 15 ]; do
  NEEDS_SETUP="$(curl -sf "$BASE/rest/settings" | python3 -c \
    'import sys,json; s=json.load(sys.stdin)["data"]; print(str(s["userManagement"]["showSetupOnFirstLoad"]).lower())' \
    2>/dev/null || echo unknown)"
  [ "$NEEDS_SETUP" != "unknown" ] && break
  sleep 2; i=$((i+1))
done
if [ "$NEEDS_SETUP" = "true" ]; then
  EMAIL="$(get_env N8N_OWNER_EMAIL)"; PASS="$(get_env N8N_OWNER_PASSWORD)"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/rest/owner/setup" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"firstName":"Po11y","lastName":"Owner","password":sys.argv[2]}))' "$EMAIL" "$PASS")")"
  if [ "$CODE" = "200" ]; then
    echo "bootstrap: n8n owner created ($EMAIL) — password in $ENV_FILE"
  elif [ "$CODE" = "400" ]; then
    # 400 = owner already exists. On an idempotent re-run /rest/settings can
    # still report showSetupOnFirstLoad=true for a window; the POST is the
    # authority. Not a failure — say so instead of the manual-setup warning.
    echo "bootstrap: n8n owner already configured — nothing to do"
  else
    # Internal REST API, no semver guarantee — degrade, don't fail.
    echo "bootstrap: headless owner setup failed (HTTP $CODE) — open $BASE and finish setup manually"
  fi
elif [ "$NEEDS_SETUP" = "false" ]; then
  echo "bootstrap: n8n owner already set up"
  [ -z "$PACKS" ] || echo "bootstrap: NOTE — packs imported after the first run are not claimed by the owner; if they don't show in the UI, re-import them there"
else
  echo "bootstrap: could not read $BASE/rest/settings — open $BASE and check manually"
fi

# ---- 5. report -----------------------------------------------------------------
DP="$(get_env DASHBOARD_PORT)"; DP="${DP:-8080}"
echo
echo "== po11y =="
echo "  dashboard:  http://$BIND:$DP/"
echo "  n8n editor: $BASE/   (login: N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD in $ENV_FILE)"
echo "  grafana:    http://$BIND:$DP/grafana/ (admin password in $ENV_FILE)"
echo "  status.json appears within ~2 min (first schedule tick)"

#!/bin/sh
# One-shot bring-up of the Po11y stack. Idempotent — re-run after .env or
# workflow changes.
#
#   ./bootstrap.sh [--no-examples] [--pack <dir-or-git-url>]...
#
#   --no-examples   skip workflows/examples/ (the HN news demo workflow)
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
#
# This list is the ONLY thing that removes a retired workflow from a live n8n.
# A fresh install never imports them, but the cutover that actually happens is
# an upgrade of an existing deployment, and bootstrap is re-runnable by design.
# Left off this list, maps kept making scheduled LLM calls alongside the
# server's own ai-map builder, and status-publish kept writing status.json into
# a volume that is no longer mounted.
#
# Deleting an EXAMPLE workflow counts too, and is easier to forget because
# examples are optional: hn-notify's Code node throws outright. A leftover copy
# on a live instance is still called by hn-tech-news every 30 minutes, so it
# turns into a red workflow, a `failing` alert and a webhook push rather than a
# no-op.
#   po11yaimap000000  retired 2026-07 (ai-map + workflow-map merged into maps.json)
#   po11yworkflowmap  retired 2026-08 (maps.json — the server builds the map now)
#   po11ystatuspub00  retired 2026-08 (status-publish — the server owns the feeds)
#   po11yhnnotify000  retired 2026-08 (HN notify example — wrote the removed feed volume)
# REMOVE AFTER 2026-12
RETIRED_IDS="po11yaimap000000 po11yworkflowmap po11ystatuspub00 po11yhnnotify000"

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
[ -n "$(get_env PO11Y_RO_PASSWORD)" ]      || set_env PO11Y_RO_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(get_env GRAFANA_ADMIN_PASSWORD)" ] || set_env GRAFANA_ADMIN_PASSWORD "$(openssl rand -hex 16)"
[ -n "$(get_env N8N_OWNER_PASSWORD)" ]     || set_env N8N_OWNER_PASSWORD "A1$(openssl rand -hex 16)"
# Not a secret, but seeded on the same terms: .env.example carries it, and an
# .env written by hand (or by CI) need not. Owner setup POSTs whatever this
# returns, and n8n rejects an empty email with the same 400 it uses for "owner
# already exists" — indistinguishable from success, so it gets a default too.
[ -n "$(get_env N8N_OWNER_EMAIL)" ]        || set_env N8N_OWNER_EMAIL "admin@example.com"

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

# Instance config: live copy is git-ignored, seeded from the example.
[ -f config.json ] || { cp config.example.json config.json; echo "bootstrap: created config.json from config.example.json — edit it to taste"; }
mkdir -p packs site secrets

# Optional AI-map config. The server builds the AI map now, and it reads
# AI_MAP_* straight from its environment (docker-compose.yml passes the three
# through from .env), so the auto-wired values are written back into .env
# rather than rendered into secrets/ai-map.json. That file was read only by
# the retired maps workflow — an n8n Code node, which could not read the
# container environment — and nothing reads it any more. Empty values still
# just mean the heuristic (no-LLM) map.
#
# The three values the auto-wire writes, named once so the write-back below and
# the clear-back after it cannot drift onto different literals. Recognising
# them again is what makes OMNIROUTE_ENABLED=false a real off-switch.
OMNIROUTE_AI_BASE="http://omniroute:20128/v1"
OMNIROUTE_AI_KEY="omniroute-local"
OMNIROUTE_AI_MODEL="auto/best-free"

AI_BASE="$(get_env AI_MAP_BASE_URL)"; AI_KEY="$(get_env AI_MAP_API_KEY)"
AI_MODEL="$(get_env AI_MAP_MODEL)"
if [ "$OMNIROUTE" != "false" ] && [ -z "$AI_BASE" ]; then
  # Auto-wire to the bundled gateway. The key is a placeholder: OmniRoute's
  # /v1 needs none by default (REQUIRE_API_KEY=false), but the server reads an
  # empty key as "LLM off". The default model is OmniRoute's free-tier
  # auto-route, so a clean bootstrap gets LLM prose with zero provider keys.
  # Explicit AI_MAP_* always wins; set OMNIROUTE_ENABLED=false (or any
  # AI_MAP_BASE_URL) to opt out entirely.
  AI_BASE="$OMNIROUTE_AI_BASE"
  [ -n "$AI_KEY" ]   || AI_KEY="$OMNIROUTE_AI_KEY"
  [ -n "$AI_MODEL" ] || AI_MODEL="$OMNIROUTE_AI_MODEL"
  set_env AI_MAP_BASE_URL "$AI_BASE"
  set_env AI_MAP_API_KEY  "$AI_KEY"
  set_env AI_MAP_MODEL    "$AI_MODEL"
elif [ "$OMNIROUTE" = "false" ] && [ "$AI_BASE" = "$OMNIROUTE_AI_BASE" ]; then
  # OMNIROUTE_ENABLED=false is documented as THE privacy off-switch (.env.example,
  # docs/security.md, docs/ai-map.md): heuristic map, no digest leaves the box.
  # Since the auto-wire persists into .env, dropping the overlay alone no longer
  # achieves that — the values survive, aiConfigured stays true, and the server
  # keeps POSTing workflow digests to a gateway that is not even running. So the
  # off-switch has to undo the auto-wire, not just skip it.
  #
  # Keyed on the base URL, because that is the one value only this auto-wire
  # writes on the bundled stack: it is the overlay's compose-internal address,
  # unreachable once the overlay is gone, so clearing it is right whether
  # bootstrap or a human put it there. The key and model are cleared only while
  # they still hold the placeholders, so an operator who pinned their own model
  # or set a real gateway key keeps it — clearing the base is already enough to
  # turn the LLM off (the server needs all three; see server/index.mjs).
  AI_BASE=""
  set_env AI_MAP_BASE_URL ""
  if [ "$AI_KEY" = "$OMNIROUTE_AI_KEY" ]; then AI_KEY=""; set_env AI_MAP_API_KEY ""; fi
  if [ "$AI_MODEL" = "$OMNIROUTE_AI_MODEL" ]; then AI_MODEL=""; set_env AI_MAP_MODEL ""; fi
  echo "bootstrap: OMNIROUTE_ENABLED=false — cleared the auto-wired AI_MAP_* gateway settings; the map stays heuristic"
fi

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
# DASHBOARD_BASIC_AUTH gates only nginx on :8080. A non-loopback bind also
# publishes three ports that auth does not touch — say so every run, because
# the interlock passing reads as "auth covers me" when it does not.
if [ "$BIND" != "127.0.0.1" ] && [ "$BIND" != "localhost" ]; then
  echo "bootstrap: WARNING — BIND_ADDR=$BIND also publishes ports DASHBOARD_BASIC_AUTH does NOT gate:"
  echo "  $BIND:5678  n8n editor (own login) + unauthenticated /metrics"
  echo "  $BIND:3000  Grafana (anonymous Viewer unless DASHBOARD_GRAFANA_EMBED=false)"
  echo "  $BIND:9090  Prometheus (no auth)"
  echo "  Restrict these at a firewall, or keep BIND_ADDR loopback behind your own proxy."
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
IMPORT_DIRS=""
[ "$EXAMPLES" = "yes" ] && IMPORT_DIRS="/workflows/examples"
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

if [ -z "$IMPORT_DIRS" ]; then
  echo "bootstrap: no --pack given and examples skipped — nothing to import"
else
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
fi

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

# Read-only role for Grafana's n8n-postgres datasource (and so for the MCP
# po11y_sql tool, which queries through it). SELECT-only — no sequence or
# signal grants, so SELECT setval(...) / pg_terminate_backend(...) fail at the
# database, and credentials_entity / execution_data are denied outright.
# Deny-by-default: no ALTER DEFAULT PRIVILEGES, so tables added by future n8n
# migrations stay unreadable until this block re-runs on the next bootstrap.
# Loud on failure — if the role is wrong, Grafana panels and alert rules break.
PO11Y_RO_PW="$(get_env PO11Y_RO_PASSWORD)"
compose exec -T postgres psql -U "${DB_POSTGRESDB_USER:-n8n}" \
  -d "${DB_POSTGRESDB_DATABASE:-n8n}" \
  -v ON_ERROR_STOP=1 -v pw="$PO11Y_RO_PW" >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'po11y_ro') THEN
    CREATE ROLE po11y_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE po11y_ro PASSWORD :'pw';
GRANT USAGE ON SCHEMA public TO po11y_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO po11y_ro;
REVOKE ALL ON TABLE credentials_entity, execution_data FROM po11y_ro;
SQL
echo "bootstrap: po11y_ro role granted (read-only, credentials/execution payloads denied)"

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
  # Body as well as status: n8n answers 400 both for "owner already exists" and
  # for a request it could not validate, and only the message tells them apart.
  # Reading every 400 as "already exists" reported a silent failure as success —
  # a bootstrap with an empty N8N_OWNER_EMAIL said the owner was configured and
  # left the instance with no owner at all.
  SETUP_BODY="$(curl -s -w '\n%{http_code}' -X POST "$BASE/rest/owner/setup" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"firstName":"Po11y","lastName":"Owner","password":sys.argv[2]}))' "$EMAIL" "$PASS")" || true)"
  CODE="$(printf '%s' "$SETUP_BODY" | tail -n1)"
  if [ "$CODE" = "200" ]; then
    echo "bootstrap: n8n owner created ($EMAIL) — password in $ENV_FILE"
  elif [ "$CODE" = "400" ] && printf '%s' "$SETUP_BODY" | grep -qiE 'already set ?up'; then
    # On an idempotent re-run /rest/settings can still report
    # showSetupOnFirstLoad=true for a window; the POST is the authority. Not a
    # failure — say so instead of the manual-setup warning.
    echo "bootstrap: n8n owner already configured — nothing to do"
  else
    # Internal REST API, no semver guarantee — degrade, don't fail. Carry n8n's
    # own message: on a validation failure it names the field it rejected, which
    # is the whole difference between "n8n changed" and "your .env is wrong".
    echo "bootstrap: headless owner setup failed (HTTP $CODE) — open $BASE and finish setup manually"
    echo "  n8n said: $(printf '%s' "$SETUP_BODY" | sed '$d' | head -c 300)"
  fi
  unset SETUP_BODY
elif [ "$NEEDS_SETUP" = "false" ]; then
  echo "bootstrap: n8n owner already set up"
  [ -z "$PACKS" ] || echo "bootstrap: NOTE — packs imported after the first run are not claimed by the owner; if they don't show in the UI, re-import them there"
else
  echo "bootstrap: could not read $BASE/rest/settings — open $BASE and check manually"
fi

# ---- 4b. ops API key -----------------------------------------------------------
# The server reads n8n over the public API, and that API accepts nothing but a
# key. Without one a default stack comes up correct but empty: serving-only, no
# sync, no build, `status.json` reporting generated_at null forever. Minting the
# key here is what keeps "run bootstrap, get a dashboard" true.
#
# Only when MCP_N8N_API_KEY is empty: an operator's own key — including a key
# for a DIFFERENT n8n — always wins, and a re-run never rotates a working one.
#
# Read-only scopes only. workflow:* and execution:* are what sync and poll-fill
# need; the dataTable ones are for the opt-in PO11Y_DATATABLES sampler and the
# /n8n-table proxy, granted now because they are still read-only and because a
# key that silently 403s the day an operator enables a documented feature is
# worse than a key with three unused read scopes.
#
# Internal REST API, no semver guarantee — degrade, never fail, exactly as the
# owner setup above does. A stack without a key still starts and still says so.
if [ -z "$(get_env MCP_N8N_API_KEY)" ]; then
  KEY_EMAIL="$(get_env N8N_OWNER_EMAIL)"; KEY_PASS="$(get_env N8N_OWNER_PASSWORD)"
  KEY_JAR="$(mktemp)"
  # shellcheck disable=SC2064  # expand KEY_JAR now: the trap must survive the unset below.
  trap "rm -f '$KEY_JAR'" EXIT
  # `|| echo 000`: set -e would abort the whole run on a transient curl failure,
  # and this step is explicitly allowed to fail without taking the stack with it.
  KEY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -c "$KEY_JAR" -X POST "$BASE/rest/login" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"emailOrLdapLoginId":sys.argv[1],"password":sys.argv[2]}))' "$KEY_EMAIL" "$KEY_PASS")" || echo 000)"
  if [ "$KEY_CODE" = "200" ]; then
    # rawApiKey is the only field carrying the usable token; `apiKey` is masked.
    NEW_KEY="$(curl -s -b "$KEY_JAR" -X POST "$BASE/rest/api-keys" \
      -H 'Content-Type: application/json' \
      -d '{"label":"po11y server (read-only)","scopes":["workflow:read","workflow:list","execution:read","execution:list","dataTable:read","dataTable:list","dataTableRow:read"],"expiresAt":null}' \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["rawApiKey"])' 2>/dev/null || true)"
    if [ -n "$NEW_KEY" ]; then
      set_env MCP_N8N_API_KEY "$NEW_KEY"
      # The server read its environment at `compose up` above, before this key
      # existed. `restart` would replay the old environment; only a recreate
      # picks up the new .env, and compose re-reads --env-file per invocation.
      compose up -d server >/dev/null 2>&1 || true
      echo "bootstrap: minted a read-only n8n API key for the server (MCP_N8N_API_KEY in $ENV_FILE)"
    else
      echo "bootstrap: could not mint an n8n API key — the dashboard will be empty until you"
      echo "  create one in $BASE (Settings > n8n API) and set MCP_N8N_API_KEY in $ENV_FILE"
    fi
  else
    echo "bootstrap: could not sign in to n8n to mint an API key (HTTP $KEY_CODE) — the dashboard"
    echo "  will be empty until you create one in $BASE (Settings > n8n API) and set"
    echo "  MCP_N8N_API_KEY in $ENV_FILE"
  fi
  rm -f "$KEY_JAR"; trap - EXIT
  unset KEY_EMAIL KEY_PASS KEY_JAR KEY_CODE NEW_KEY
fi

# ---- 5. report -----------------------------------------------------------------
DP="$(get_env DASHBOARD_PORT)"; DP="${DP:-8080}"
echo
echo "== po11y =="
echo "  dashboard:  http://$BIND:$DP/"
echo "  n8n editor: $BASE/   (login: N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD in $ENV_FILE)"
echo "  grafana:    http://$BIND:$DP/grafana/ (admin password in $ENV_FILE)"
echo "  the server builds the feeds on its first sync, moments after it starts"

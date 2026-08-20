#!/bin/sh
# Preflight for the read-only topology: check the remote n8n, report which
# upstream N8N_METRICS_INCLUDE_* flags are missing, and seed the .env secrets
# that only bootstrap.sh generates today.
#
#   ./scripts/readonly-preflight.sh [--check] [--metrics-file FILE]
#
#   --check              report only; never write to .env
#   --metrics-file FILE  read the metrics exposition from FILE instead of
#                        scraping N8N_METRICS_TARGET (offline tests)
#
# Idempotent. Re-run it after changing .env, or after the remote's admin sets
# the flags it asks for. The read-only stack has no bootstrap.sh, so this is
# the one script that stands between `cp .env.example .env` and a stack whose
# optional overlays start.
#
# Requires: curl for the probes, and openssl or /dev/urandom to seed secrets.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
# curl is only needed for the two network probes: with --metrics-file the
# exposition comes off disk, so a host without curl can still lint a fixture.
HAVE_CURL=yes
command -v curl >/dev/null || HAVE_CURL=no

WRITE=yes
METRICS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) WRITE=no ;;
    --metrics-file) shift; METRICS_FILE="${1:-}" ;;
    *) echo "preflight: unknown argument '$1'"; exit 2 ;;
  esac
  shift
done

[ -f "$ENV_FILE" ] || { echo "preflight: $ENV_FILE not found — cp .env.example .env first"; exit 1; }

get_env() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//'; }
set_env() { # set_env KEY VALUE
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    # A hand-edited .env may lack a trailing newline; appending onto that last
    # line would silently corrupt both variables.
    [ ! -s "$ENV_FILE" ] || [ -z "$(tail -c1 "$ENV_FILE")" ] || echo >> "$ENV_FILE"
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

MISSING_FLAGS=""   # required-for-a-po11y-surface flags the remote has off
FAIL=0             # non-zero exit: po11y cannot work at all as configured

note()  { printf '  %s\n' "$1"; }
ok()    { printf '  [ok]      %s\n' "$1"; }
miss()  { printf '  [MISSING] %s\n' "$1"; printf '            -> %s\n' "$2"
          MISSING_FLAGS="$MISSING_FLAGS $1"; }
opt()   { printf '  [off]     %s\n' "$1"; printf '            -> %s\n' "$2"; }
# A verdict the exposition cannot settle either way. Never counted as missing:
# telling an operator to go ask another team for a flag that is already set
# costs more than saying nothing.
dunno() { printf '  [?]       %s\n' "$1"; printf '            -> %s\n' "$2"; }

# ---- n8n public API ---------------------------------------------------------
N8N_API_URL="$(get_env N8N_API_URL)"
N8N_API_KEY="$(get_env N8N_API_KEY)"
printf '\nn8n API   %s\n' "${N8N_API_URL:-(unset)}"
if [ "$HAVE_CURL" = no ]; then
  note "curl not installed — skipping the API probe"
elif [ -z "$N8N_API_URL" ] || [ -z "$N8N_API_KEY" ]; then
  note "N8N_API_URL and N8N_API_KEY must both be set in $ENV_FILE"
  FAIL=1
else
  api_body="$(curl -s -m 10 -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "${N8N_API_URL%/}/api/v1/workflows?limit=1" 2>/dev/null || true)"
  case "$api_body" in
    *'"data"'*)
      # Counting needs a real parser: a workflow's nodes and connections carry
      # their own "id" keys, so grepping the listing overcounts wildly. python3
      # is already a po11y prerequisite; without it the probe still passes, it
      # just reports no number.
      count=""
      if command -v python3 >/dev/null; then
        count="$(curl -s -m 20 -H "X-N8N-API-KEY: $N8N_API_KEY" \
          "${N8N_API_URL%/}/api/v1/workflows?limit=250" 2>/dev/null \
          | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data", [])))' 2>/dev/null || true)"
      fi
      [ -z "$count" ] || count=" ($count workflows visible)"
      ok "public API reachable, key accepted$count" ;;
    *unauthorized*|*'"message"'*)
      note "API rejected the key — needs workflow:list, workflow:read, execution:list, execution:read"
      FAIL=1 ;;
    *)
      note "no response — is $N8N_API_URL reachable from this host?"
      FAIL=1 ;;
  esac
fi

# ---- n8n /metrics -----------------------------------------------------------
TARGET="$(get_env N8N_METRICS_TARGET)"
printf '\nmetrics   %s\n' "${METRICS_FILE:-${TARGET:-(unset)}}"
metrics=""
if [ -n "$METRICS_FILE" ]; then
  metrics="$(cat "$METRICS_FILE")"
elif [ "$HAVE_CURL" = no ]; then
  note "curl not installed — skipping the metrics scrape"
elif [ -n "$TARGET" ]; then
  metrics="$(curl -s -m 10 "http://$TARGET/metrics" 2>/dev/null || true)"
fi

if [ -z "$metrics" ] && [ "$HAVE_CURL" = no ] && [ -z "$METRICS_FILE" ]; then
  : # nothing scraped because curl is absent; already reported above
elif [ -z "$metrics" ]; then
  note "no metrics scraped — set N8N_METRICS_TARGET, and N8N_METRICS=true on the remote n8n"
  note "without it: every Grafana panel and the Metrics row stay empty"
  MISSING_FLAGS="$MISSING_FLAGS N8N_METRICS"
else
  series="$(printf '%s\n' "$metrics" | grep -c '^n8n_' || true)"
  note "$series n8n_* samples exposed"

  has() { printf '%s\n' "$metrics" | grep -q "$1"; }

  # Probe the TYPE declaration, never the samples. n8n registers a metric with
  # prom-client when its flag is on, which emits the HELP/TYPE header
  # immediately, but a histogram carries no series until the first request it
  # measures. An instance with webhook metrics enabled and no webhook traffic
  # yet exposes the header and nothing else — read as samples, that is
  # indistinguishable from the flag being off, and the operator gets sent to
  # another team to ask for a flag already set.
  #
  # flag FAMILY FLAG CONSEQUENCE
  flag() {
    if has "^# TYPE $1"; then
      if has "^$1"; then ok "$2"; else
        ok "$2"
        printf '            (declared, no samples yet — needs traffic to plot)\n'
      fi
    else
      miss "$2" "$3"
    fi
  }

  flag n8n_workflow_execution_duration_seconds N8N_METRICS \
       "no execution metrics at all — the Metrics row stays empty"
  flag n8n_workflow_info N8N_METRICS_INCLUDE_WORKFLOW_INFO \
       "both execution dashboards join on this gauge for workflow names"
  flag n8n_form_submission_duration_seconds N8N_METRICS_INCLUDE_FORM_METRICS \
       "the Form Executions dashboard stays empty"
  flag n8n_webhook_request_duration_seconds N8N_METRICS_INCLUDE_WEBHOOK_METRICS \
       "the Webhook Executions dashboard stays empty"

  # The one verdict that can only come from samples: the label rides on the
  # series, not on the declaration. With no executions recorded yet there is
  # nothing to read it off, so say so rather than guess.
  if has '^n8n_workflow_execution_duration_seconds_count'; then
    if has 'workflow_id="'; then
      ok N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL
    else
      miss N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL "per-workflow panels cannot split by workflow"
    fi
  else
    dunno N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL \
      "no executions recorded yet — re-run once a workflow has run"
  fi

  # Optional: nothing po11y ships reads these, but they are the metrics an
  # operator reaches for next, and they cost one env var upstream.
  has '^n8n_cache_' || opt "N8N_METRICS_INCLUDE_CACHE_METRICS" "cache hit/miss counters"
  has '^n8n_api_'   || opt "N8N_METRICS_INCLUDE_API_ENDPOINTS" "per-endpoint REST API timings"
  has '^n8n_queue_' || opt "N8N_METRICS_INCLUDE_QUEUE_METRICS" "queue depth (scaling mode only)"
fi

# ---- .env seeding -----------------------------------------------------------
# The read-only quickstart never runs bootstrap.sh, so these are unset — and
# docker-compose.omniroute.yml refuses to start without them (`:?`). Generated
# on the same terms bootstrap uses: only when empty, never overwritten.
printf '\nsecrets   %s\n' "$ENV_FILE"
if [ "$WRITE" = no ]; then
  note "--check: not writing"
else
  # openssl is bootstrap.sh's generator, but this script runs on hosts that
  # never install one — a minimal container, a locked-down box — and refusing
  # to seed there would leave compose unable to start over a missing random
  # number. /dev/urandom is the same entropy source openssl reads anyway.
  rand_hex() { # rand_hex BYTES
    if command -v openssl >/dev/null; then
      openssl rand -hex "$1"
    else
      od -An -vtx1 -N "$1" /dev/urandom | tr -d ' \n'
    fi
  }
  seeded=""
  seed() { # seed KEY VALUE
    [ -n "$(get_env "$1")" ] || { set_env "$1" "$2"; seeded="$seeded $1"; }
  }
  seed GRAFANA_ADMIN_PASSWORD   "$(rand_hex 16)"
  seed OMNIROUTE_JWT_SECRET     "$(rand_hex 32)"
  seed OMNIROUTE_API_KEY_SECRET "$(rand_hex 32)"
  seed OMNIROUTE_ADMIN_PASSWORD "$(rand_hex 16)"
  if [ -n "$seeded" ]; then
    note "generated:$seeded"
  else
    note "already set — nothing generated"
  fi
fi

# ---- verdict ----------------------------------------------------------------
if [ -n "$MISSING_FLAGS" ]; then
  printf '\nAsk the admin of that n8n to set, then restart it:\n\n'
  for f in $MISSING_FLAGS; do printf '  %s=true\n' "$f"; done
  printf '\nOn a public-facing n8n, restrict /metrics to this host at the reverse\nproxy — see docs/security.md.\n'
else
  printf '\nAll metrics po11y reads are exposed. Nothing to ask upstream for.\n'
fi
printf '\n'
exit "$FAIL"

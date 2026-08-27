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
CONFIG_FILE="${CONFIG_FILE:-config.json}"
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

# Inline comments require whitespace before '#', exactly as compose reads the
# same file — a bare '#' inside a value (a hand-set password) is the value.
get_env() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/[[:space:]]\{1,\}#.*//'; }
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
  # The Grafana admin password and the three OmniRoute secrets land in this
  # file. `cp .env.example .env` inherits the umask, which on most hosts leaves
  # it world-readable, so every account on the box reads them. Tighten it
  # before the first secret is written.
  chmod 600 "$ENV_FILE"
  note "mode 600 enforced on $ENV_FILE"
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

# ---- config.json seeding ----------------------------------------------------
# The dashboard's n8n links live in config.json, which nginx serves straight to
# the browser — no envsubst, no templating. Nothing connected it to .env, so a
# correct N8N_API_URL still left `"baseUrl": ""`, and {host} then resolved to
# the browser's own hostname: the box running the dashboard, not the n8n being
# watched. Same discipline as the secrets above — only when empty.
printf '\nconfig    %s\n' "$CONFIG_FILE"
LINK_URL="$(get_env N8N_PUBLIC_URL)"
[ -n "$LINK_URL" ] || LINK_URL="$(get_env N8N_API_URL)"
export CONFIG_FILE LINK_URL
if [ "$WRITE" = no ]; then
  note "--check: not writing"
elif [ ! -f "$CONFIG_FILE" ]; then
  note "not found — cp config.readonly.example.json config.json first"
elif [ -z "$LINK_URL" ]; then
  note "N8N_PUBLIC_URL and N8N_API_URL are both empty — no host to link to"
elif ! command -v python3 >/dev/null; then
  note "python3 not installed — set baseUrl in $CONFIG_FILE by hand"
else
  # Rewritten by regex, not by json.dump: the shipped config is hand-formatted
  # (one card per line) and reserialising it would bury a two-word change in a
  # whole-file diff. The result is parsed before it is written.
  python3 <<'SEED_CONFIG'
import json, os, re, sys
from urllib.parse import urlsplit

path, raw = os.environ['CONFIG_FILE'], os.environ['LINK_URL']


def say(msg):
    print('  %s' % msg)


url = urlsplit(raw)
host = url.hostname or ''
if not host:
    say('could not read a host out of %s — set baseUrl by hand' % raw)
    sys.exit(0)

text = open(path, encoding='utf-8').read()
try:
    cfg = json.loads(text)
except ValueError as e:
    say('not valid JSON (%s) — left alone' % e)
    sys.exit(0)

# The bundled config has no baseUrl: po11y owns that n8n and serves it from the
# same host the dashboard is on, so {host} is already right.
if 'baseUrl' not in cfg:
    say('no baseUrl key — bundled config, nothing to seed')
    sys.exit(0)
if cfg.get('baseUrl'):
    say('already set — nothing written')
    sys.exit(0)

# baseUrl carries the host alone; n8nUrl carries the shape around it. Splitting
# them is what lets {host} also address other services on that same box.
#
# The path is part of that shape. An n8n served under a prefix (N8N_PATH, or a
# reverse proxy mounting it at /n8n) has one, and dropping it built
# "https://{host}" from "https://example.com/n8n" — so every {n8n}-built card
# resolved to https://example.com/workflow/... and 404'd, which is the exact
# breakage {n8n} was added to fix. A trailing slash is stripped because
# app.lib.js's n8nBase joins with one.
bracketed = '[{host}]' if ':' in host else '{host}'
n8n_url = '%s://%s%s%s' % (url.scheme or 'http', bracketed,
                           ':%d' % url.port if url.port else '',
                           url.path.rstrip('/'))
# What this may overwrite: an empty value, or the shape config.readonly.example.json
# ships. Anything else is a hand-set n8nUrl, and the README promises a re-run
# writes only what is empty. baseUrl being empty is not evidence that n8nUrl is
# — an operator who set the prefix by hand and left the host to the script hit
# exactly that gap and lost the prefix on the next run.
SEEDABLE = ('', 'http://{host}:5678')

out, n = re.subn(r'("baseUrl"\s*:\s*)""',
                 lambda m: m.group(1) + json.dumps(host), text, count=1)
if not n:
    say('baseUrl is not empty in the file — left alone')
    sys.exit(0)

wrote = 'baseUrl=%s' % host
current_n8n_url = cfg.get('n8nUrl')
if 'n8nUrl' not in cfg or current_n8n_url == n8n_url:
    pass
elif current_n8n_url not in SEEDABLE:
    say('n8nUrl is hand-set (%s) — left alone' % current_n8n_url)
else:
    out, k = re.subn(r'("n8nUrl"\s*:\s*)"[^"]*"',
                     lambda m: m.group(1) + json.dumps(n8n_url), out, count=1)
    if k:
        wrote += ' n8nUrl=%s' % n8n_url

try:
    json.loads(out)
except ValueError as e:
    # exit 0, not 1. This script runs under `set -eu` and this heredoc is the
    # last command in its branch, so a non-zero status here aborted the whole
    # preflight: the exposure report and the final metrics verdict never
    # printed, on the one run where the operator most needs them. Nothing was
    # written, the message says so, and the config is one section of a report.
    say('rewrite would not parse (%s) — left alone' % e)
    sys.exit(0)

with open(path, 'w', encoding='utf-8') as fh:
    fh.write(out)
say('wrote: %s' % wrote)
SEED_CONFIG
fi

# ---- exposure ---------------------------------------------------------------
# Report only, deliberately: an open bind is a risk, not a reason po11y cannot
# run, so it must not change the exit code the metrics probes own. The
# enforcing copy of this guard lives in the dashboard entrypoint, because the
# read-only stack has no bootstrap.sh to stop `compose up` before it publishes
# a port. Saying it here as well means an operator meets the warning while
# reading this report, not through a container that refuses to serve.
printf '\nexposure  BIND_ADDR\n'
# shellcheck source=deploy/nginx/bind-guard.sh
. ./deploy/nginx/bind-guard.sh
PF_BIND="$(get_env BIND_ADDR)"; PF_BIND="${PF_BIND:-127.0.0.1}"
# The same lift bootstrap.sh does. The guard reads PO11Y_ALLOW_OPEN_BIND from
# the process environment; .env.example documents it as a .env variable,
# because that is where compose reads it for the container. Without this the
# report says the dashboard will refuse to start on a bind the container will
# in fact accept. An exported value still wins, as it does for compose.
if [ -z "${PO11Y_ALLOW_OPEN_BIND:-}" ]; then
  PO11Y_ALLOW_OPEN_BIND="$(get_env PO11Y_ALLOW_OPEN_BIND)"
  export PO11Y_ALLOW_OPEN_BIND
fi
PF_GATE=""
[ -z "$(get_env DASHBOARD_BASIC_AUTH)" ] || PF_GATE=DASHBOARD_BASIC_AUTH
# Forward auth is a compose OVERLAY: docker-compose.auth.yml sets
# FORWARD_AUTH=true on the dashboard service, never in .env, so this script
# cannot see the gate the entrypoint will apply. What it can see is whether the
# overlay is CONFIGURED — that file refuses to start without
# OAUTH2_PROXY_OIDC_ISSUER_URL (`:?`), and nothing else reads that variable.
# Configured is not the same as brought up, so this is reported rather than
# counted: an operator running the overlay must not be told the dashboard will
# refuse to start when it will not, and an operator who filled the variables in
# and then forgot the second -f must not be told the bind is gated when it is
# not. Both readings get said out loud.
PF_FORWARD_AUTH=no
[ "$(get_env FORWARD_AUTH)" != true ] || PF_FORWARD_AUTH=yes
[ -z "$(get_env OAUTH2_PROXY_OIDC_ISSUER_URL)" ] || PF_FORWARD_AUTH=yes
if po11y_bind_is_loopback "$PF_BIND"; then
  ok "BIND_ADDR=$PF_BIND — the stack reaches this host only"
elif [ -z "$PF_GATE" ] && [ "$PF_FORWARD_AUTH" = yes ]; then
  po11y_bind_guard "$PF_BIND" readonly "the forward-auth overlay" report || true
  note "the overlay gates the dashboard only once it is brought up:"
  note "  docker compose -f docker-compose.readonly.yml -f docker-compose.auth.yml up -d"
  note "without that second -f there is no gate, and the dashboard exits 78"
else
  po11y_bind_guard "$PF_BIND" readonly "$PF_GATE" report || true
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

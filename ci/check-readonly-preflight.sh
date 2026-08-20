#!/bin/sh
# scripts/readonly-preflight.sh tells a read-only operator which upstream
# N8N_METRICS_INCLUDE_* flags their n8n has off. Wrong verdicts are worse than
# no script: a false [ok] sends them hunting through Grafana for data their n8n
# never exports, and a false [MISSING] sends them to another team's admin to
# ask for a flag that is already set.
#
# Both directions are asserted here against two fixture exposition files, with
# --check so no .env is written and --metrics-file so no n8n is needed.
#
# Usage: sh ci/check-readonly-preflight.sh   (from the repo root)
set -eu

fail() { echo "check-readonly-preflight: $1" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A read-only .env with no n8n behind it: the API probe fails (exit 1), which
# is why every run below tolerates a non-zero exit and asserts on output only.
cat > "$TMP/env" <<'EOF'
N8N_API_URL=http://127.0.0.1:1
N8N_API_KEY=fixture
N8N_METRICS_TARGET=127.0.0.1:1
GRAFANA_ADMIN_PASSWORD=fixture
EOF

run() { # run FIXTURE
  ENV_FILE="$TMP/env" sh scripts/readonly-preflight.sh --check --metrics-file "$1" 2>&1 || true
}

# ---- every flag on ----------------------------------------------------------
out="$(run ci/fixtures/metrics-all-flags.txt)"
for flag in N8N_METRICS \
            N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL \
            N8N_METRICS_INCLUDE_WORKFLOW_INFO \
            N8N_METRICS_INCLUDE_FORM_METRICS \
            N8N_METRICS_INCLUDE_WEBHOOK_METRICS; do
  printf '%s\n' "$out" | grep -q "\[ok\]      $flag" \
    || fail "all-flags fixture: $flag not reported ok"
done
printf '%s\n' "$out" | grep -q 'MISSING' \
  && fail 'all-flags fixture: reported something missing'
printf '%s\n' "$out" | grep -q 'Nothing to ask upstream for' \
  || fail 'all-flags fixture: did not report a clean verdict'

# ---- the n8n default: metrics on, every INCLUDE_ flag off -------------------
out="$(run ci/fixtures/metrics-minimal.txt)"
printf '%s\n' "$out" | grep -q '\[ok\]      N8N_METRICS' \
  || fail 'minimal fixture: N8N_METRICS should be ok — the exposition is non-empty'
for flag in N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL \
            N8N_METRICS_INCLUDE_WORKFLOW_INFO \
            N8N_METRICS_INCLUDE_FORM_METRICS \
            N8N_METRICS_INCLUDE_WEBHOOK_METRICS; do
  printf '%s\n' "$out" | grep -q "\[MISSING\] $flag" \
    || fail "minimal fixture: $flag not reported missing"
  printf '%s\n' "$out" | grep -q "^  $flag=true\$" \
    || fail "minimal fixture: $flag missing from the copy-paste block"
done

# ---- flags on, no traffic yet -----------------------------------------------
# The regression this file exists for: an instance with every flag set but no
# webhook request, form submission or execution served yet declares each metric
# and carries no series. Probing samples reported the flags MISSING and sent the
# operator to another team to ask for flags that were already on.
out="$(run ci/fixtures/metrics-flags-on-no-traffic.txt)"
for flag in N8N_METRICS \
            N8N_METRICS_INCLUDE_WORKFLOW_INFO \
            N8N_METRICS_INCLUDE_FORM_METRICS \
            N8N_METRICS_INCLUDE_WEBHOOK_METRICS; do
  printf '%s\n' "$out" | grep -q "\[ok\]      $flag" \
    || fail "no-traffic fixture: $flag reported as anything but ok"
done
printf '%s\n' "$out" | grep -q 'MISSING' \
  && fail 'no-traffic fixture: reported a flag missing on a fully-configured instance'
printf '%s\n' "$out" | grep -q 'no samples yet' \
  || fail 'no-traffic fixture: did not explain why the dashboards are still empty'
# The workflow_id label rides on the series, so it cannot be read at all here.
printf '%s\n' "$out" | grep -q '\[?\]       N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL' \
  || fail 'no-traffic fixture: workflow_id label should be unknown, not asserted'

# ---- --check writes nothing -------------------------------------------------
before="$(cat "$TMP/env")"
run ci/fixtures/metrics-minimal.txt >/dev/null
[ "$before" = "$(cat "$TMP/env")" ] || fail '--check wrote to .env'
printf '%s\n' "$out" | grep -q 'not writing' || fail '--check did not say it was skipping writes'

# ---- seeding is idempotent and never overwrites ------------------------------
cp "$TMP/env" "$TMP/env.seed"
ENV_FILE="$TMP/env.seed" sh scripts/readonly-preflight.sh \
  --metrics-file ci/fixtures/metrics-minimal.txt >/dev/null 2>&1 || true
# Length is asserted, not just presence: the /dev/urandom fallback used where
# openssl is absent (the lint container, a minimal host) must produce the same
# 32/64 hex characters, not an empty string from a missing tool.
for key in OMNIROUTE_JWT_SECRET OMNIROUTE_API_KEY_SECRET; do
  val=$(grep "^$key=" "$TMP/env.seed" | cut -d= -f2-)
  [ ${#val} -eq 64 ] || fail "seeding did not set $key to 32 bytes of hex (got '${val}')"
done
val=$(grep '^OMNIROUTE_ADMIN_PASSWORD=' "$TMP/env.seed" | cut -d= -f2-)
[ ${#val} -eq 32 ] || fail "seeding did not set OMNIROUTE_ADMIN_PASSWORD to 16 bytes of hex (got '${val}')"
case "$val" in *[!0-9a-f]*) fail "generated secret is not hex: '$val'" ;; esac
grep -q '^GRAFANA_ADMIN_PASSWORD=fixture$' "$TMP/env.seed" \
  || fail 'seeding overwrote an already-set GRAFANA_ADMIN_PASSWORD'
first="$(cat "$TMP/env.seed")"
ENV_FILE="$TMP/env.seed" sh scripts/readonly-preflight.sh \
  --metrics-file ci/fixtures/metrics-minimal.txt >/dev/null 2>&1 || true
[ "$first" = "$(cat "$TMP/env.seed")" ] || fail 'a second run changed .env — not idempotent'

# ---- config.json seeding ----------------------------------------------------
# The dashboard's n8n links come from config.json, which nothing ever templated
# from .env: a correct N8N_API_URL still left `"baseUrl": ""`, and every n8n
# card then resolved {host} to the browser's own hostname — the box running the
# dashboard, not the n8n being watched. Seeded here on the same terms as the
# .env secrets: only when empty, never overwritten.

cfg_env() { # cfg_env PUBLIC_URL API_URL
  cat > "$TMP/env.cfg" <<EOF
N8N_API_URL=$2
N8N_API_KEY=fixture
N8N_METRICS_TARGET=127.0.0.1:1
N8N_PUBLIC_URL=$1
GRAFANA_ADMIN_PASSWORD=fixture
OMNIROUTE_JWT_SECRET=fixture
OMNIROUTE_API_KEY_SECRET=fixture
OMNIROUTE_ADMIN_PASSWORD=fixture
EOF
}

cfg_json() { # cfg_json BASEURL N8NURL
  cat > "$TMP/config.json" <<EOF
{
  "title": "Po11y",
  "baseUrl": "$1",
  "n8nUrl": "$2",
  "cards": { "Actions": [] }
}
EOF
}

runcfg() { # runcfg [EXTRA_ARGS...]
  ENV_FILE="$TMP/env.cfg" CONFIG_FILE="$TMP/config.json" \
    sh scripts/readonly-preflight.sh --metrics-file ci/fixtures/metrics-minimal.txt "$@" 2>&1 || true
}

has_cfg() { grep -q "$1" "$TMP/config.json"; }

# The common case: the remote is plain http on n8n's own port, so only the host
# is unknown and n8nUrl already has the right shape.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
cfg_json '' 'http://{host}:5678'
out="$(runcfg)"
has_cfg '"baseUrl": "100.66.166.57"' || fail 'config seeding: baseUrl not written'
has_cfg '"n8nUrl": "http://{host}:5678"' || fail 'config seeding: n8nUrl should have been left alone'
printf '%s\n' "$out" | grep -q '100.66.166.57' \
  || fail 'config seeding: did not report the host it wrote'

# A TLS n8n on the default port: baseUrl alone cannot carry it, so n8nUrl has
# to lose the ":5678" and gain the scheme, or every card 404s on http.
cfg_env 'https://n8n.example.com' 'https://n8n.example.com'
cfg_json '' 'http://{host}:5678'
runcfg >/dev/null
has_cfg '"baseUrl": "n8n.example.com"' || fail 'config seeding: TLS host not written'
has_cfg '"n8nUrl": "https://{host}"' || fail 'config seeding: n8nUrl kept the wrong scheme/port'

# A non-default port survives verbatim.
cfg_env '' 'http://n8n.internal:8443'
cfg_json '' 'http://{host}:5678'
runcfg >/dev/null
has_cfg '"baseUrl": "n8n.internal"' || fail 'config seeding: did not fall back to N8N_API_URL'
has_cfg '"n8nUrl": "http://{host}:8443"' || fail 'config seeding: non-default port not carried over'

# N8N_PUBLIC_URL wins: it is the address a reader can open, which is the whole
# point of a link in a browser.
cfg_env 'https://n8n.public.example' 'http://10.0.0.9:5678'
cfg_json '' 'http://{host}:5678'
runcfg >/dev/null
has_cfg '"baseUrl": "n8n.public.example"' \
  || fail 'config seeding: N8N_API_URL beat N8N_PUBLIC_URL'

# Never overwrite a hand-set value.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
cfg_json 'n8n.hand.set' 'https://{host}'
out="$(runcfg)"
has_cfg '"baseUrl": "n8n.hand.set"' || fail 'config seeding: overwrote a hand-set baseUrl'
has_cfg '"n8nUrl": "https://{host}"' || fail 'config seeding: overwrote a hand-set n8nUrl'
printf '%s\n' "$out" | grep -q 'already set' \
  || fail 'config seeding: did not say the config was already configured'

# --check must not touch config.json any more than it touches .env.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
cfg_json '' 'http://{host}:5678'
before="$(cat "$TMP/config.json")"
runcfg --check >/dev/null
[ "$before" = "$(cat "$TMP/config.json")" ] || fail '--check wrote to config.json'

# Idempotent: a second run changes nothing.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
cfg_json '' 'http://{host}:5678'
runcfg >/dev/null
first="$(cat "$TMP/config.json")"
runcfg >/dev/null
[ "$first" = "$(cat "$TMP/config.json")" ] || fail 'a second run changed config.json — not idempotent'

# The bundled config.example.json declares no baseUrl at all: po11y owns that
# n8n and publishes it on the same host. Nothing to seed, and nothing to break.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
printf '{\n  "title": "Po11y",\n  "cards": {}\n}\n' > "$TMP/config.json"
before="$(cat "$TMP/config.json")"
runcfg >/dev/null
[ "$before" = "$(cat "$TMP/config.json")" ] || fail 'config seeding: touched a config with no baseUrl key'

# A missing config.json is the normal state before `cp config.readonly.example.json`.
# Say so; never create one.
cfg_env 'http://100.66.166.57:5678' 'http://100.66.166.57:5678'
rm -f "$TMP/config.json"
out="$(runcfg)"
[ -f "$TMP/config.json" ] && fail 'config seeding: created a config.json out of nowhere'
printf '%s\n' "$out" | grep -q 'config.readonly.example.json' \
  || fail 'config seeding: did not point at the example to copy'

echo 'check-readonly-preflight: ok'

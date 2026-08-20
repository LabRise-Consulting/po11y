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
for key in OMNIROUTE_JWT_SECRET OMNIROUTE_API_KEY_SECRET OMNIROUTE_ADMIN_PASSWORD; do
  grep -q "^$key=..*" "$TMP/env.seed" || fail "seeding did not set $key"
done
grep -q '^GRAFANA_ADMIN_PASSWORD=fixture$' "$TMP/env.seed" \
  || fail 'seeding overwrote an already-set GRAFANA_ADMIN_PASSWORD'
first="$(cat "$TMP/env.seed")"
ENV_FILE="$TMP/env.seed" sh scripts/readonly-preflight.sh \
  --metrics-file ci/fixtures/metrics-minimal.txt >/dev/null 2>&1 || true
[ "$first" = "$(cat "$TMP/env.seed")" ] || fail 'a second run changed .env — not idempotent'

echo 'check-readonly-preflight: ok'

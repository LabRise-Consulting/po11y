#!/bin/sh
# Guard against the A3 class of bug: compose REPLACES an entrypoint rather
# than merging it, so an overlay that re-declares grafana's entrypoint inline
# silently drops whatever the copy forgot — the otel overlay once lost all
# five Grafana alert rules exactly that way. Since the fix, the one true
# grafana entrypoint is the shared file observability/grafana/entrypoint.sh.
#
# Invariants asserted here, pure text, no docker daemon needed:
#   1. entrypoint.sh still contains the alerting-provisioning branch.
#   2. In every docker-compose*.yml, a grafana service either declares exactly
#      the canonical entrypoint (and mounts the shared file), or declares no
#      entrypoint at all (an overlay inheriting the base's).
#
# Usage: sh ci/check-grafana-entrypoint.sh   (from the repo root)
set -eu

fail() { echo "check-grafana-entrypoint: $1" >&2; exit 1; }

CANON='entrypoint: ["sh", "/etc/po11y-grafana-entrypoint.sh"]'

grep -q 'alerting-src' observability/grafana/entrypoint.sh \
  || fail 'observability/grafana/entrypoint.sh lost its alerting-src branch'

for f in docker-compose*.yml; do
  # The grafana service block: from '  grafana:' to the next 2-space-indented
  # service key. Nothing if the file has no grafana service.
  block=$(awk '/^  grafana:$/{on=1; next} on && /^  [a-zA-Z0-9_-]+:/{on=0} on' "$f")
  [ -n "$block" ] || continue
  eps=$(printf '%s\n' "$block" | grep -c '^    entrypoint:' || true)
  if [ "$eps" -gt 1 ]; then
    fail "$f: grafana declares $eps entrypoints"
  elif [ "$eps" -eq 1 ]; then
    printf '%s\n' "$block" | grep -qF "$CANON" \
      || fail "$f: grafana entrypoint is not the canonical shared one ($CANON)"
    printf '%s\n' "$block" | grep -qF 'observability/grafana/entrypoint.sh:/etc/po11y-grafana-entrypoint.sh' \
      || fail "$f: grafana declares the canonical entrypoint but does not mount observability/grafana/entrypoint.sh"
  fi
  # eps=0: overlay inherits the base entrypoint — exactly what the otel
  # overlay's comment promises. Nothing to check.
done

# 3. The k8s grafana Deployment runs the same shared script (mounted from the
#    grafana-entrypoint ConfigMap) rather than an inline copy that could lack
#    the alerting branch.
K8S=deploy/k8s/40-grafana.yaml
if [ -f "$K8S" ]; then
  grep -qF '"/etc/po11y-grafana-entrypoint.sh"' "$K8S" \
    || fail "$K8S: grafana does not run the shared entrypoint script"
  grep -qF 'name: grafana-entrypoint' "$K8S" \
    || fail "$K8S: grafana does not mount the grafana-entrypoint ConfigMap"
  grep -q 'cp -r /etc/grafana/provisioning-src' "$K8S" \
    && fail "$K8S: inline copy of the grafana entrypoint is back — use the shared script"
fi

echo 'check-grafana-entrypoint: ok'

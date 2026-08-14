#!/bin/sh
# Guard the dashboard-entrypoint invariant, exactly as check-grafana-entrypoint.sh
# guards grafana's: compose REPLACES entrypoints rather than merging them, so an
# overlay (or a base file) re-inlining the dashboard entrypoint silently drops
# whatever the copy forgot — auth rendering, the /form/ matrix, the feeds.conf
# switch. The one true entrypoint is the shared file
# deploy/nginx/dashboard-entrypoint.sh.
#
# Invariants, pure text, no docker daemon needed:
#   1. The shared script still renders the load-bearing includes.
#   2. In every docker-compose*.yml, a dashboard service either declares exactly
#      the canonical entrypoint (and mounts the shared file), or none at all.
#
# Usage: sh ci/check-dashboard-entrypoint.sh   (from the repo root)
set -eu

fail() { echo "check-dashboard-entrypoint: $1" >&2; exit 1; }

CANON='entrypoint: ["sh", "/etc/po11y-dashboard-entrypoint.sh"]'
SCRIPT=deploy/nginx/dashboard-entrypoint.sh

[ -f "$SCRIPT" ] || fail "$SCRIPT is missing"
for marker in '/etc/nginx/feeds.conf' '/etc/nginx/auth.conf' '/etc/nginx/form-proxy.conf' '/etc/nginx/forward-auth.conf' 'conf.d/form-authz.conf'; do
  grep -qF "$marker" "$SCRIPT" || fail "$SCRIPT no longer renders $marker"
done

for f in docker-compose*.yml; do
  block=$(awk '/^  dashboard:$/{on=1; next} on && /^  [a-zA-Z0-9_-]+:/{on=0} on' "$f")
  [ -n "$block" ] || continue
  eps=$(printf '%s\n' "$block" | grep -c '^    entrypoint:' || true)
  if [ "$eps" -gt 1 ]; then
    fail "$f: dashboard declares $eps entrypoints"
  elif [ "$eps" -eq 1 ]; then
    printf '%s\n' "$block" | grep -qF "$CANON" \
      || fail "$f: dashboard entrypoint is not the canonical shared one ($CANON)"
    printf '%s\n' "$block" | grep -qF 'deploy/nginx/dashboard-entrypoint.sh:/etc/po11y-dashboard-entrypoint.sh' \
      || fail "$f: dashboard declares the canonical entrypoint but does not mount $SCRIPT"
  fi
done

echo 'check-dashboard-entrypoint: ok'

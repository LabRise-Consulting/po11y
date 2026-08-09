#!/bin/sh
# Render Grafana's provisioning tree, then start Grafana.
#
# Grafana needs a writable provisioning directory (GF_PATHS_PROVISIONING points
# at /tmp/grafana-provisioning) but the sources are mounted read-only, so every
# start copies them into /tmp and patches the copy.
#
# ONE script, mounted by every compose file that runs Grafana. It used to be an
# inline `entrypoint:` block repeated in docker-compose.yml,
# docker-compose.readonly.yml and docker-compose.otel.yml. Compose REPLACES an
# entrypoint rather than merging it, so the otel overlay's copy silently
# dropped the alerting branch below and `-f docker-compose.yml -f
# docker-compose.otel.yml` — the command docs/deployment.md gives — booted with
# zero alert rules while the alerting volume sat mounted and unused.
#
# Everything mode-specific is driven by what is mounted, not by which file
# spelled the entrypoint:
#   /etc/grafana/provisioning-src     required, shared by both modes
#   /etc/grafana/alerting-src         Mode A only (four of the five rules query
#                                     a postgres Mode B does not have)
#   /etc/po11y-grafana-extras/        overlays drop extra datasources/dashboards
set -eu

SRC=/etc/grafana/provisioning-src
DST=/tmp/grafana-provisioning
EXTRAS=/etc/po11y-grafana-extras

rm -rf "$DST"
cp -r "$SRC" "$DST"

# Overlay extras (docker-compose.otel.yml mounts Tempo's datasource and the
# traces dashboard here). Copied BEFORE the seds below so an overlay dashboard
# gets the same __WEB_BIND_ADDR__ substitution the built-in ones get.
if [ -d "$EXTRAS/datasources" ]; then
  cp "$EXTRAS"/datasources/*.yml "$DST/datasources/"
fi
if [ -d "$EXTRAS/dashboards" ]; then
  cp "$EXTRAS"/dashboards/*.json "$DST/dashboards/json/"
fi

# Grafana interpolates ${VAR} in provisioning YAML but NOT in dashboard JSON,
# so the n8n deep-link host is sedded into the rendered copy.
sed -i "s|__WEB_BIND_ADDR__|${BIND_ADDR:-127.0.0.1}|g" "$DST"/dashboards/json/*.json
sed -i "s|/etc/grafana/provisioning/|$DST/|g" "$DST/dashboards/dashboards.yml"

# Alerting rules are Mode A only, so they are mounted from a directory OUTSIDE
# provisioning-src — docker-compose.readonly.yml shares provisioning-src.
if [ -d /etc/grafana/alerting-src ]; then
  cp -r /etc/grafana/alerting-src "$DST/alerting"
  # Grafana refuses to start on a webhook contact point with an empty url, and
  # a policy naming an absent contact point is equally fatal. With no
  # GRAFANA_ALERT_WEBHOOK_URL the rules stay active and visible; only delivery
  # is dropped. Both files go or neither does.
  if [ -z "${GRAFANA_ALERT_WEBHOOK_URL:-}" ]; then
    rm -f "$DST/alerting/contact-points.yml" "$DST/alerting/policies.yml"
  fi
fi

exec /run.sh

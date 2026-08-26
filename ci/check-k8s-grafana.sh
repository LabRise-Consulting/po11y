#!/bin/sh
# The k8s manifests carry their own copy of two things the compose stack also
# has: the Grafana datasource credentials, and the dashboard nginx's /grafana/
# proxy. Both copies had drifted, in the same direction — towards less.
#
# Grafana grants every anonymous visitor the Viewer role, and a Viewer can run
# arbitrary SQL against a datasource through /api/ds/query. Whatever that
# datasource can read is therefore readable by anyone who can reach Grafana,
# which through the dashboard's unauthenticated /grafana/ proxy is anyone who
# can reach the dashboard. Compose survives that because bootstrap.sh creates a
# SELECT-only role first; the manifests pointed the same datasource at n8n's own
# database user, and recorded it as a known divergence in a comment.
#
# The header scrubbing had gone the same way: nginx.conf clears Authorization
# and six identity headers before proxying to Grafana, and the k8s copy cleared
# none of them.
#
# A comment cannot hold either line. This can.
#
# Usage: sh ci/check-k8s-grafana.sh   (from the repo root)
set -eu

fail() { echo "check-k8s-grafana: $1" >&2; exit 1; }

CONFIGMAPS=deploy/k8s/02-configmaps.yaml
GRAFANA=deploy/k8s/40-grafana.yaml
SECRETS=deploy/k8s/01-secrets.yaml
NGINX=nginx.conf
BOOTSTRAP=bootstrap.sh

for f in "$CONFIGMAPS" "$GRAFANA" "$SECRETS" "$NGINX" "$BOOTSTRAP"; do
  [ -f "$f" ] || fail "$f not found — run from the repo root"
done

# ---- 1. the datasource authenticates as the read-only role ------------------
# Matched inside the datasource block only: DB_POSTGRESDB_DATABASE is still the
# right way to name the database, and the pod legitimately holds
# DB_POSTGRESDB_PASSWORD on the init container that creates the role.
ds="$(sed -n '/^  datasources.yml:/,/^  [a-z-]*\.yml:/p' "$CONFIGMAPS")"
[ -n "$ds" ] || fail "$CONFIGMAPS: could not find the datasources.yml block"

printf '%s\n' "$ds" | grep -q 'DB_POSTGRESDB_PASSWORD' \
  && fail "$CONFIGMAPS: the grafana datasource uses n8n's own DB password; an anonymous Viewer can read credentials_entity through it"
printf '%s\n' "$ds" | grep -q 'DB_POSTGRESDB_USER' \
  && fail "$CONFIGMAPS: the grafana datasource uses n8n's own DB user; it must authenticate as po11y_ro"
printf '%s\n' "$ds" | grep -q 'PO11Y_RO_PASSWORD' \
  || fail "$CONFIGMAPS: the grafana datasource does not authenticate as po11y_ro"

# ---- 2. the role is actually created, and its password has a home -----------
grep -q 'PO11Y_RO_PASSWORD' "$SECRETS" \
  || fail "$SECRETS: no PO11Y_RO_PASSWORD — the datasource has no credential to use"
grep -q 'initContainers' "$GRAFANA" \
  || fail "$GRAFANA: no init container, so nothing creates the po11y_ro role the datasource needs"
for stmt in 'CREATE ROLE po11y_ro' 'GRANT SELECT ON ALL TABLES' 'REVOKE ALL ON TABLE credentials_entity, execution_data'; do
  grep -q "$stmt" "$GRAFANA" \
    || fail "$GRAFANA: the init container does not run \"$stmt\" — the role would not match bootstrap.sh's"
done

# ---- 2b. the role's privileges are reasserted, not only created --------------
# CREATE ROLE runs only when the role is missing. A po11y_ro that already
# existed — created by hand, or by an earlier version — keeps whatever
# attributes and role memberships it had, and the table-level REVOKE removes
# none of them. The ALTER must therefore restate the restrictive attributes on
# every run.
grep -q 'ALTER ROLE po11y_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT' "$GRAFANA" \
  || fail "$GRAFANA: the init container does not reassert po11y_ro's restrictive attributes — a pre-existing role keeps SUPERUSER or BYPASSRLS"

# The same SQL runs in two places (bootstrap.sh for compose, the init container
# for k8s). Compare the heredoc bodies so a fix applied to one cannot silently
# miss the other — the drift that motivated this whole check.
sql_of() {
  awk "/<<'SQL'\$/ { in_sql = 1; next }
       in_sql && /^[[:space:]]*SQL\$/ { exit }
       in_sql { sub(/^[[:space:]]*/, \"\"); print }" "$1"
}
[ -n "$(sql_of "$BOOTSTRAP")" ] || fail "$BOOTSTRAP: could not find the po11y_ro SQL heredoc"
[ -n "$(sql_of "$GRAFANA")" ] || fail "$GRAFANA: could not find the po11y_ro SQL heredoc"
[ "$(sql_of "$BOOTSTRAP")" = "$(sql_of "$GRAFANA")" ] \
  || fail "the po11y_ro SQL drifted between $BOOTSTRAP and $GRAFANA — sync the fix into both"

# ---- 3. the /grafana/ proxy scrubs what the compose one scrubs ---------------
# The expected list is READ OUT OF nginx.conf rather than written here, so a
# header added there has to be added in k8s too, or this fails.
compose_block="$(sed -n '/^  location \/grafana\/ {/,/^  }/p' "$NGINX")"
[ -n "$compose_block" ] || fail "$NGINX: could not find the /grafana/ location block"
k8s_block="$(sed -n '/^      location \/grafana\/ {/,/^      }/p' "$CONFIGMAPS")"
[ -n "$k8s_block" ] || fail "$CONFIGMAPS: could not find the /grafana/ location block"

missing=''
for h in $(printf '%s\n' "$compose_block" \
  | sed -n 's/^[[:space:]]*proxy_set_header \([A-Za-z-]*\) "";$/\1/p'); do
  printf '%s\n' "$k8s_block" | grep -q "proxy_set_header $h \"\";" || missing="$missing $h"
done
[ -z "$missing" ] \
  || fail "$CONFIGMAPS: the /grafana/ proxy does not scrub what $NGINX scrubs:$missing"

echo 'check-k8s-grafana: ok'

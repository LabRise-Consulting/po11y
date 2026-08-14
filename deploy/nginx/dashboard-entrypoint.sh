#!/bin/sh
# The ONE dashboard entrypoint, shared by every compose file that runs the
# dashboard (grafana-entrypoint precedent: compose REPLACES an entrypoint
# rather than merging it, so inline copies drift — ci/check-dashboard-entrypoint.sh
# guards this file the way ci/check-grafana-entrypoint.sh guards grafana's).
set -eu
# The template carries no substitution placeholders anymore (the
# /n8n-table key moved into the server process), so rendering is a
# plain copy; every `$var` in the file is an nginx runtime variable. (The
# backticks are load-bearing: an unquoted $var here was interpolated away when
# this comment lived inline in a compose file.)
cp /etc/nginx/nginx.conf.template /etc/nginx/conf.d/default.conf
# Forward auth (oauth2-proxy overlay). FORWARD_AUTH=true renders the
# nginx auth_request include; else an empty file. Identity is lifted from
# oauth2-proxy's /oauth2/auth subrequest RESPONSE via auth_request_set
# ($upstream_http_*) — NEVER from client-supplied request headers, which
# are forgeable (see nginx.conf). The include is always written before
# `exec nginx`, so nginx never references a missing file.
if [ "$FORWARD_AUTH" = "true" ]; then
  {
    printf '%s\n' 'auth_request /oauth2/auth;'
    printf '%s\n' 'error_page 401 = /oauth2/sign_in;'
    # shellcheck disable=SC2016  # literal nginx $var syntax for forward-auth.conf, not shell expansion
    printf '%s\n' 'auth_request_set $auth_email $upstream_http_x_auth_request_email;'
    # shellcheck disable=SC2016  # literal nginx $var syntax for forward-auth.conf, not shell expansion
    printf '%s\n' 'auth_request_set $auth_groups $upstream_http_x_auth_request_groups;'
  } > /etc/nginx/forward-auth.conf
else
  : > /etc/nginx/forward-auth.conf
fi
# Basic Auth gate. Forward-auth WINS when both are set: a Basic prompt on
# top of the OIDC redirect is double auth / broken UX, so log a one-line
# notice and write an empty auth.conf (forward-auth is the identity source).
if [ "$FORWARD_AUTH" = "true" ] && [ -n "$DASHBOARD_BASIC_AUTH" ]; then
  echo "po11y: FORWARD_AUTH=true overrides DASHBOARD_BASIC_AUTH — Basic Auth disabled (identity via oauth2-proxy)." >&2
  : > /etc/nginx/auth.conf
elif [ -n "$DASHBOARD_BASIC_AUTH" ]; then
  user="${DASHBOARD_BASIC_AUTH%%:*}"
  pass="${DASHBOARD_BASIC_AUTH#*:}"
  printf '%s:%s\n' "$user" "$(cryptpw -m sha512 "$pass")" > /etc/nginx/.htpasswd
  printf 'auth_basic "po11y";\nauth_basic_user_file /etc/nginx/.htpasswd;\n' > /etc/nginx/auth.conf
else
  : > /etc/nginx/auth.conf
fi
# --- /form/ submit proxy + per-group authorization -------------------
# Rendering matrix (ENABLE_FORM_PROXY x FORWARD_AUTH x FORM_ALLOWED_GROUPS).
# ENABLE_FORM_PROXY default: true on the bundled stack, false on the read-only stack.
#   1) ENABLE_FORM_PROXY!=true             -> empty include, no /form/.
#   2) enabled, FORWARD_AUTH!=true         -> open proxy past the shared
#      gate (legacy). No verified identity exists to authorize against, so
#      FORM_ALLOWED_GROUPS cannot be enforced; if it is set we log a
#      fail-loud notice rather than imply an authz that isn't there.
#   3) enabled, FORWARD_AUTH=true, no groups -> DENY ALL (return 403):
#      deny by default; an authed user with no allowlisted group can't fire.
#   4) enabled, FORWARD_AUTH=true, groups set -> allow only when the
#      verified $auth_groups (set by auth_request_set from oauth2-proxy's
#      subrequest RESPONSE, NEVER the client-forgeable
#      $http_x_forwarded_groups) contains an allowlisted group.
# oauth2-proxy emits one X-Auth-Request-Groups response header per group
# (header.Add), which nginx joins into $auth_groups as ", "-separated, so
# the map matches each name as a whole comma-delimited token (a bare space
# is NOT a separator, so a multi-word group name can't match a shorter one).
# The `map` lives in its own http-scope conf.d file (map is invalid in the
# server-scope form-proxy.conf); always (re)written so a stale allowlist
# never survives a config change across a container restart.
scrub_hdrs='X-Auth-Request-User X-Auth-Request-Email X-Auth-Request-Groups X-Forwarded-User X-Forwarded-Email X-Forwarded-Groups'
: > /etc/nginx/conf.d/form-authz.conf
if [ "$ENABLE_FORM_PROXY" = "true" ]; then
  # Whitelist to scheme://host[:port] so no value escapes the directive;
  # the nginx runtime variable ($form_upstream) + resolver defer DNS.
  upstream="$(printf %s "$FORM_PROXY_UPSTREAM" | tr -cd 'A-Za-z0-9.:/-')"
  : "${upstream:=http://n8n:5678}"
  if [ "$FORWARD_AUTH" = "true" ]; then
    # Split on comma, whitelist each name to [A-Za-z0-9_-] (drops spaces,
    # semicolons, braces -> nothing escapes the generated regex), drop
    # empties, join with '|'. Empty after filtering == unset -> deny.
    alt="$(printf %s "$FORM_ALLOWED_GROUPS" | tr ',' '\n' | tr -cd 'A-Za-z0-9_\n-' | grep -v '^$' | paste -sd '|' -)"
    if [ -n "$alt" ]; then
      {
        # shellcheck disable=SC2016  # literal nginx map syntax for form-authz.conf, not shell expansion
        printf 'map $auth_groups $form_allowed {\n'
        printf '  default 0;\n'
        # Comma-anchored matcher. oauth2-proxy joins the per-group
        # headers with ", ", so comma is the ONLY group separator; \s*
        # merely trims whitespace adjacent to a comma. A bare space is NOT
        # a separator, so a multi-word group ("x admins") can never match
        # an allowlisted "admins". The regex is passed as the printf
        # ARGUMENT (not the format) so busybox printf can't mangle the \s;
        # quoted in the map so it stays one field despite the metachars.
        printf '  %s 1;\n' '"~(^|,)\s*('"$alt"')\s*(,|$)"'
        printf '}\n'
      } > /etc/nginx/conf.d/form-authz.conf
      {
        printf '%s\n' 'location /form/ {'
        printf '%s\n' '  limit_except POST { deny all; }'
        # `if` here is the sanctioned return-only form (no side effects).
        # shellcheck disable=SC2016  # literal nginx $var syntax for form-proxy.conf, not shell expansion
        printf '%s\n' '  if ($form_allowed = 0) { return 403; }'
        # shellcheck disable=SC2016  # literal nginx $var syntax for form-proxy.conf, not shell expansion
        printf '  set $form_upstream %s;\n' "$upstream"
        # shellcheck disable=SC2016  # literal nginx $var syntax for form-proxy.conf, not shell expansion
        printf '%s\n' '  proxy_pass $form_upstream;'
        # Scrub client-supplied identity headers so a forged
        # X-Auth-Request-* / X-Forwarded-* can never reach n8n.
        for h in $scrub_hdrs; do
          printf '  proxy_set_header %s "";\n' "$h"
        done
        printf '%s\n' '}'
      } > /etc/nginx/form-proxy.conf
    else
      {
        printf '%s\n' 'location /form/ {'
        printf '%s\n' '  # deny by default: FORWARD_AUTH on, FORM_ALLOWED_GROUPS empty.'
        printf '%s\n' '  return 403;'
        printf '%s\n' '}'
      } > /etc/nginx/form-proxy.conf
    fi
  else
    if [ -n "$FORM_ALLOWED_GROUPS" ]; then
      echo "po11y: FORM_ALLOWED_GROUPS is set but FORWARD_AUTH is off - group authorization has no enforcement point (no verified identity); the /form/ proxy stays open past the shared gate." >&2
    fi
    {
      printf '%s\n' 'location /form/ {'
      printf '%s\n' '  limit_except POST { deny all; }'
      # shellcheck disable=SC2016  # literal nginx $var syntax for form-proxy.conf, not shell expansion
      printf '  set $form_upstream %s;\n' "$upstream"
      # shellcheck disable=SC2016  # literal nginx $var syntax for form-proxy.conf, not shell expansion
      printf '%s\n' '  proxy_pass $form_upstream;'
      for h in $scrub_hdrs; do
        printf '  proxy_set_header %s "";\n' "$h"
      done
      printf '%s\n' '}'
    } > /etc/nginx/form-proxy.conf
  fi
else
  : > /etc/nginx/form-proxy.conf
fi
# Feeds always come from the po11y server. FEED_UPSTREAM stays a runtime
# variable substitution (not a build-time nginx upstream) so the dashboard
# still starts when the server container is down.
up="$(printf %s "${FEED_UPSTREAM:-http://server:8081}" | tr -cd 'A-Za-z0-9.:/-')"
: "${up:=http://server:8081}"
sed "s|__FEED_UPSTREAM__|$up|g" /etc/nginx/po11y-feeds/feeds-server.conf > /etc/nginx/feeds.conf
exec nginx -g 'daemon off;'

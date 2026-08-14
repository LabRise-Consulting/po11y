#!/bin/sh
# HTTP smoke assertions for a running po11y instance. Pure HTTP — no docker
# commands — so it doubles as a generic health check for any po11y deployment
# and runs unchanged in CI (docker:27 job, apk curl+jq) or locally.
#
#   BASE_URL=http://localhost:8080 ci/smoke.sh
#
# Each assertion is polled until it passes or SMOKE_TIMEOUT (default 90s)
# elapses — the n8n import/activation bootstrap does, and the server's first
# sync/rebuild takes, time to come good. First failing assertion exits
# non-zero with the last observed status and a body snippet.
#
# Requires: curl, jq.
set -eu

BASE_URL="${BASE_URL:-http://localhost:8080}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-90}"
INTERVAL=3

TMP=$(mktemp)
TMP_HDR=$(mktemp)
trap 'rm -f "$TMP" "$TMP_HDR"' EXIT

# Last observed diagnostic, set by each check_* for the failure message.
LAST=""

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n      %s\n' "$1" "$2" >&2
  exit 1
}

# curl_code METHOD PATH [extra curl args...]
# Requests BASE_URL$PATH, writes the response body to $TMP, echoes the HTTP
# status (000 if the host is unreachable so callers can distinguish it).
curl_code() {
  _method=$1
  _path=$2
  shift 2
  # No fallback echo: curl's own %{http_code} is already 000 on connect
  # failure/timeout — a second echo would yield "000000" and defeat the
  # unreachable-guards that match on exactly 000.
  curl -s -m 10 -o "$TMP" -w '%{http_code}' -X "$_method" "$@" "$BASE_URL$_path" \
    2>/dev/null || true
}

# curl_code_hdr METHOD PATH
# Same contract as curl_code, but also writes the response headers to
# $TMP_HDR — for the one assertion below that needs to read a header
# (x-po11y-source), not just the body.
curl_code_hdr() {
  _method=$1
  _path=$2
  curl -s -m 10 -D "$TMP_HDR" -o "$TMP" -w '%{http_code}' -X "$_method" "$BASE_URL$_path" \
    2>/dev/null || true
}

# wait_for DESC CHECKFN
# Polls CHECKFN every $INTERVAL s until it returns 0, or fails after
# $SMOKE_TIMEOUT s using the $LAST diagnostic the check recorded.
wait_for() {
  _desc=$1
  _fn=$2
  _deadline=$(( $(date +%s) + SMOKE_TIMEOUT ))
  while : ; do
    if "$_fn"; then
      pass "$_desc"
      return 0
    fi
    if [ "$(date +%s)" -ge "$_deadline" ]; then
      fail "$_desc" "$LAST"
    fi
    sleep "$INTERVAL"
  done
}

snippet() { head -c 160 "$TMP" | tr '\n\t' '  '; }

# 1. GET / → 200, body mentions po11y (case-insensitive).
check_root() {
  code=$(curl_code GET /)
  LAST="GET / -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  grep -qi 'po11y' "$TMP" || return 1
}

# 2. GET /config.json → 200 and valid JSON.
check_config() {
  code=$(curl_code GET /config.json)
  LAST="GET /config.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  jq -e . "$TMP" >/dev/null 2>&1 || return 1
}

# 3. GET /status.json → 200, .generated_at within the last 60s. BusyBox date
# cannot parse ISO-8601, so the timestamp is converted to epoch via jq's
# fromdateiso8601 (strip the .fff fraction first). .containers was Mode A's
# docker-socket Code node (deleted with the publisher workflows) and is no
# longer asserted here — an accepted regression of dropping Mode A.
check_status_json() {
  code=$(curl_code GET /status.json)
  LAST="GET /status.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  gen=$(jq -r '.generated_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' "$TMP" 2>/dev/null) || return 1
  case "$gen" in ''|null) return 1 ;; esac
  age=$(( $(date +%s) - gen ))
  LAST="GET /status.json -> $code; generated_at age ${age}s"
  [ "$age" -ge 0 ] && [ "$age" -le 60 ] || return 1
}

# 3b. GET /status/default/status.json → 200 and the SAME .generated_at as the
# flat /status.json. Proves the namespaced-feed nginx wiring: the `default`
# scope must serve the flat canonical file (via the internal rewrite in
# nginx.conf), not a /po11y-status/default/ subdir (which does not exist). Reads
# flat first, then the scoped URL; a publish landing between the two reads would
# make the timestamps differ, but wait_for retries so that self-heals. Byte-
# equality would be brittle (nginx may add headers) — generated_at identity is
# the load-bearing bit.
check_status_default_alias() {
  gen_flat=$(curl -s -m 10 "$BASE_URL/status.json" | jq -r '.generated_at' 2>/dev/null)
  code=$(curl_code GET /status/default/status.json)
  gen_scoped=$(jq -r '.generated_at' "$TMP" 2>/dev/null)
  LAST="GET /status/default/status.json -> $code; flat gen=$gen_flat scoped gen=$gen_scoped"
  [ "$code" = 200 ] || return 1
  case "$gen_scoped" in ''|null) return 1 ;; esac
  [ "$gen_flat" = "$gen_scoped" ] || return 1
}

# 4. GET /map.json → 200, .mermaid begins with 'graph TD'.
check_map_json() {
  code=$(curl_code GET /map.json)
  LAST="GET /map.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  jq -e '.mermaid | startswith("graph TD")' "$TMP" >/dev/null 2>&1 || return 1
}

# 5. GET /ai-map.json → 200, at least one node. Heuristic path — the CI .env
# sets AI_MAP_BASE_URL without a key, which the ai-map workflow reads as "LLM
# off", so this asserts the deterministic structure, not the prose. (Without
# that, bootstrap auto-wires OmniRoute's auto/best-free and this check races a
# live LLM call against the 90 s budget.)
check_ai_map_json() {
  code=$(curl_code GET /ai-map.json)
  LAST="GET /ai-map.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  jq -e '(.nodes | length) > 0' "$TMP" >/dev/null 2>&1 || return 1
}

# 6. GET /forms.json → 200 and well-formed. Which forms it lists now depends
# entirely on what the operator has in n8n, so this no longer asserts a
# specific path (that used to be maps-build-now, a Mode A form).
check_forms_json() {
  code=$(curl_code GET /forms.json)
  LAST="GET /forms.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  jq -e '.forms | type == "array"' "$TMP" >/dev/null 2>&1 || return 1
}

# 7. GET /grafana/api/health → 200.
check_grafana() {
  code=$(curl_code GET /grafana/api/health)
  LAST="GET /grafana/api/health -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
}

# 8. GET /n8n-table/workflows → exactly 403. Load-bearing security assertion:
# on n8n Community Edition API keys cannot be scoped, so the po11y server's
# deny of everything under /n8n-table/ outside data-tables (nginx only
# forwards here, see nginx.conf) is the ONLY control keeping the injected key
# read-only-to-data-tables. Not 200, not 404 — exactly 403.
check_n8n_table_deny() {
  code=$(curl_code GET /n8n-table/workflows)
  LAST="GET /n8n-table/workflows -> $code (want exactly 403)"
  [ "$code" = 403 ] || return 1
}

# 9. GET /n8n-table/data-tables/x/rows → anything EXCEPT 403. This proves the
# data-tables prefix still reaches n8n and the deny above does not over-match.
# In CI no N8N_READ_API_KEY is configured, so n8n answers 401; with a key it
# would be 200/404. 000 means the request never reached the dashboard, so it is
# also a failure — only a real (non-403) HTTP answer counts. A 502 here would
# mean the server reached this route but could not reach n8n behind it; that is
# still evidence the deny does not over-match, so it is deliberately accepted
# (wait_for retries, so a transient one does not decide the run).
check_n8n_table_reaches() {
  code=$(curl_code GET /n8n-table/data-tables/x/rows)
  LAST="GET /n8n-table/data-tables/x/rows -> $code (want any real status but 403)"
  case "$code" in 403|000) return 1 ;; *) return 0 ;; esac
}

# 10. POST /mcp/ tools/list → 200 with all ten tools. The only assertion that
# exercises the MCP boot path inside the server (buildRegistry ->
# createDispatcher -> the /mcp route in server/http.mjs) and nginx's variable
# proxy_pass hop; every unit test fakes the layer below it. Ten is the full set
# — a source being absent makes a tool answer `unavailable`, never disappear.
check_mcp_tools_list() {
  code=$(curl_code POST /mcp/ -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  tools=$(jq -r '.result.tools | length' "$TMP" 2>/dev/null)
  LAST="POST /mcp/ -> $code; tools=$tools; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  [ "$tools" = 10 ] || return 1
}

# 10b. po11y_sql runs as the read-only po11y_ro role, and that role cannot
# read credentials_entity or execution_data. Probed through the MCP tool
# itself — the whole chain (nginx → mcp → Grafana datasource → postgres) as
# the role, not a docker exec — via non-mutating privilege introspection, so
# this stays safe to run against any live deployment.
sql_call() { # sql_call SQL -> tool result text (the JSON the tool returned)
  curl -s -m 10 -X POST "$BASE_URL/mcp/" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"po11y_sql\",\"arguments\":{\"sql\":\"$1\"}}}" \
    2>/dev/null | jq -r '.result.content[0].text // empty' 2>/dev/null
}

check_sql_role() {
  out=$(sql_call 'SELECT current_user::text AS u')
  LAST="po11y_sql current_user -> $(printf '%s' "$out" | head -c 200)"
  [ "$(printf '%s' "$out" | jq -r '.rows[0][0]' 2>/dev/null)" = "po11y_ro" ]
}

check_sql_denied_tables() {
  out=$(sql_call "SELECT has_table_privilege('credentials_entity','SELECT')::text AS cred, has_table_privilege('execution_data','SELECT')::text AS payloads")
  LAST="po11y_sql table privileges -> $(printf '%s' "$out" | head -c 200)"
  [ "$(printf '%s' "$out" | jq -r '.rows[0] | join(",")' 2>/dev/null)" = "false,false" ]
}

# 11. GET /lib/list-rows.mjs → 200 as JavaScript. The list tab imports this
# module at runtime, so a broken mount or a missing nginx location blanks the
# tab silently — and the MIME type is load-bearing too: a browser refuses a
# module served as anything but a JavaScript type (nginx's stock mime.types has
# no .mjs entry, hence the default_type in nginx.conf).
check_lib_module() {
  code=$(curl_code GET /lib/list-rows.mjs)
  ctype=$(curl -s -m 10 -o /dev/null -w '%{content_type}' "$BASE_URL/lib/list-rows.mjs" 2>/dev/null || true)
  LAST="GET /lib/list-rows.mjs -> $code; content-type: $ctype"
  [ "$code" = 200 ] || return 1
  case "$ctype" in *javascript*) return 0 ;; *) return 1 ;; esac
}

printf 'po11y smoke: BASE_URL=%s SMOKE_TIMEOUT=%ss\n' "$BASE_URL" "$SMOKE_TIMEOUT"

wait_for 'root serves po11y dashboard'          check_root
wait_for 'config.json is valid JSON'            check_config
wait_for 'status.json is fresh'                 check_status_json
wait_for 'status/default alias == flat status'  check_status_default_alias
wait_for 'map.json mermaid is a graph TD'       check_map_json
wait_for 'ai-map.json has nodes'                check_ai_map_json
wait_for 'forms.json is well-formed'            check_forms_json
wait_for 'grafana health is 200'                check_grafana
wait_for 'n8n-table non-data-table is 403'      check_n8n_table_deny
wait_for 'n8n-table data-tables reaches n8n'    check_n8n_table_reaches
wait_for 'mcp tools/list returns ten tools'     check_mcp_tools_list
wait_for 'po11y_sql runs as po11y_ro'           check_sql_role
wait_for 'po11y_ro denied credentials/payloads' check_sql_denied_tables
wait_for 'list-rows.mjs serves as javascript'   check_lib_module

# 12. Prove the feeds actually come from the server — the only feed path since
# Mode A's deletion. The x-po11y-source header is the load-bearing bit: it
# proves the request reached the server rather than a stale nginx alias.
check_forms_server_source() {
  code=$(curl_code_hdr GET /forms.json)
  LAST="GET /forms.json -> $code; x-po11y-source: $(grep -i '^x-po11y-source:' "$TMP_HDR" 2>/dev/null | tr -d '\r'); body: $(snippet)"
  [ "$code" = 200 ] || return 1
  grep -qi '^x-po11y-source: *po11y-server' "$TMP_HDR" || return 1
  jq -e '.forms' "$TMP" >/dev/null 2>&1 || return 1
}

# 13. GET /ai-map.json → 200 with a generated_at timestamp, confirming the
# server actually rebuilt it rather than serving a stale document.
check_ai_map_server_fresh() {
  code=$(curl_code GET /ai-map.json)
  LAST="GET /ai-map.json -> $code; body: $(snippet)"
  [ "$code" = 200 ] || return 1
  jq -e '.generated_at' "$TMP" >/dev/null 2>&1 || return 1
}

wait_for 'forms.json is served by the server'   check_forms_server_source
wait_for 'ai-map.json is fresh (server-served)' check_ai_map_server_fresh

# Optional: reach the server's own /healthz and /metrics through the
# dashboard's compose network. This is the one pair of assertions in this file
# that is NOT pure HTTP against $BASE_URL — it shells out to
# `docker compose ... exec`, which breaks any remote/non-compose run. Off by
# default; opt in by setting SMOKE_COMPOSE_FILES to the exact -f arguments for
# the compose invocation under test, e.g.:
#   SMOKE_COMPOSE_FILES='-f docker-compose.readonly.yml'
#
# Both announce themselves, pass or skip. Every other assertion here prints its
# own PASS line, and these two were silent in both directions — so a log could
# not distinguish "the exposition renders" from "the block never ran", which is
# the same unknown-read-as-healthy this file exists to catch.
if [ -n "${SMOKE_COMPOSE_FILES:-}" ]; then
  # shellcheck disable=SC2086 # SMOKE_COMPOSE_FILES is meant to word-split into -f args.
  docker compose $SMOKE_COMPOSE_FILES exec -T dashboard wget -qO- http://server:8081/healthz \
    | grep -q '"lastSuccess"' \
    || { echo "smoke: server healthz unreachable from the dashboard network"; exit 1; }
  echo 'PASS  server /healthz reachable in-network'

  # /metrics is what Prometheus scrapes. A 404 here means every
  # po11y_* alert rule silently stops evaluating rather than firing — the
  # quietest possible failure, so assert the exposition really renders.
  # shellcheck disable=SC2086 # SMOKE_COMPOSE_FILES is meant to word-split into -f args.
  docker compose $SMOKE_COMPOSE_FILES exec -T dashboard wget -qO- http://server:8081/metrics \
    | grep -q '^po11y_n8n_up ' \
    || { echo "smoke: server /metrics did not render po11y_n8n_up"; exit 1; }
  echo 'PASS  server /metrics renders po11y_n8n_up'
else
  echo 'SKIP  server /healthz + /metrics (SMOKE_COMPOSE_FILES unset)'
fi

echo 'po11y smoke: all assertions passed'

# Security posture

By default, Po11y services bind to loopback (`127.0.0.1`).

## Mode A (Bundled stack)

- **Docker socket proxy**: Container listing requests use a read-only `docker-socket-proxy` sidecar restricted to `GET /containers/json`. n8n has no direct access to the host Docker socket.
- **Blocked environment access**: Code nodes cannot read process environment variables (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`).
- **Code node builtins**: Only the `fs` built-in module is enabled so workflows can write status files. n8n does not scope `fs` to a path, so a Code node can read any file the container user can, including the AI map key at `/run/po11y/ai-map.json`. Editor access therefore implies AI map key access. The key never reaches the environment, a feed, or anything the browser can fetch.
- **Execute Command node**: Enabled instance-wide (`NODES_EXCLUDE=[]`) because the Maps workflow shells out to `n8n export:workflow`. This applies to every workflow on the instance, not only that one. With no host Docker socket, commands are confined to the n8n container.
- **Exposure interlock**: `bootstrap.sh` refuses to start on non-loopback addresses unless `DASHBOARD_BASIC_AUTH` is set (or overridden using `PO11Y_ALLOW_OPEN_BIND=1`). **Mode A only** — see Mode B below.
- **AI architecture map**: OmniRoute (`docker-compose.omniroute.yml`) sends workflow digests (names, node types, schedule rules, webhooks, and truncated code comments) to a free-tier LLM provider by default. Set `OMNIROUTE_ENABLED=false` to use local heuristic descriptions instead.

## Mode B (Collector)

- **Read-only REST API access**: The collector invokes only HTTP `GET` requests against n8n (`collector/collect.mjs`). No write calls are made to n8n.
- **API key security**: The `N8N_API_KEY` is kept in process environment variables and is never saved to feed files or logs.
- **No Docker socket or Execute Command**: Mode B does not run n8n, so container listing and command execution nodes are not present.
- **Redacted webhook and heartbeat credentials**: Webhook and heartbeat URLs (such as `ALERT_WEBHOOK_URL` and `ALERT_HEARTBEAT_URL`) are treated as sensitive credentials. The collector logs scheme and host only and redacts paths and query tokens.
- **Form submission proxy**: Disabled by default (`ENABLE_FORM_PROXY=false`). Enable form proxying only when protected by the forward-authentication overlay (`FORM_ALLOWED_GROUPS`).
- **No exposure interlock**: Mode B has no `bootstrap.sh`, so nothing checks `BIND_ADDR` against `DASHBOARD_BASIC_AUTH`. `docker compose -f docker-compose.readonly.yml up -d` binds wherever `BIND_ADDR` points without complaint, and Grafana runs with anonymous Viewer access enabled (`GF_AUTH_ANONYMOUS_ENABLED`, default `true`). Set `DASHBOARD_BASIC_AUTH` yourself before pointing `BIND_ADDR` at anything but loopback.

### Upstream `N8N_METRICS` considerations

Setting `N8N_METRICS=true` on a remote n8n instance exposes `/metrics` on its main port without authentication. On public-facing n8n instances, restrict access to `/metrics` at your reverse proxy to allow requests only from the Po11y collector IP.

## Common features

- **Default binding**: All services bind to `127.0.0.1` by default. Place services behind a TLS reverse proxy before exposing them to external networks.
- **Dashboard authentication**: Set `DASHBOARD_BASIC_AUTH=user:password` to protect dashboard endpoints, static files, and proxy routes.
- **MCP endpoint security**: `/mcp/` shares the dashboard's authentication guards. In Mode A, `po11y_sql` executes queries under the read-only database role `po11y_ro`, which denies access to sensitive tables like `credentials_entity` and `execution_data`. Set `MCP_GRAFANA_URL=` in `.env` to disable `po11y_sql`.
- **Collector `/metrics` endpoint**: Exposed on port `8081` within the internal Docker Compose network without public port mappings.

## Read authorization scope

Po11y does not provide per-viewer read authorization or tenant filtering for status feeds or architecture maps. Anyone with read access to the dashboard can view all status feeds. For multi-tenant read isolation, run Mode B against paid n8n instances configured with native RBAC and project controls.

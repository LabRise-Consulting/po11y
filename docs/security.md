# Security posture

By default, Po11y services bind to loopback (`127.0.0.1`).

## Bundled stack

- **No Docker socket**: The host Docker socket is not mounted anywhere in the stack, and there is no `docker-socket-proxy` sidecar. Both existed only to fill the dashboard's container card, which was removed with the publisher workflows.
- **Blocked environment access**: Code nodes cannot read process environment variables (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`).
- **Code node builtins**: None are enabled (`NODE_FUNCTION_ALLOW_BUILTIN` is unset). `fs` used to be allowed for the workflows that published the dashboard's feeds to a shared volume; the server owns every feed now, so no shipped workflow needs a builtin.
- **Execute Command node**: Disabled, which is n8n's own default on 2.0 and later. It was previously re-enabled instance-wide (`NODES_EXCLUDE=[]`) for the Maps workflow's `n8n export:workflow` step; the server reads workflows over the REST API, so nothing in po11y needs it.
- **Minted n8n API key**: when `MCP_N8N_API_KEY` is empty, `bootstrap.sh` signs in as the owner it created and mints one key for the server, labelled `po11y server (read-only)`. Its scopes are read-only and cover workflows, executions and data tables — no credential, no write, no execution control. It does not expire, it is written to `.env`, and it is the server's only way to read n8n. Revoke it in n8n (Settings > n8n API) and clear the variable to stop the server reading anything. A key you set yourself is never replaced or rotated.
- **Exposure interlock**: `bootstrap.sh` refuses to start on non-loopback addresses unless `DASHBOARD_BASIC_AUTH` is set (or overridden using `PO11Y_ALLOW_OPEN_BIND=1`). It refuses before `compose up` publishes any port. The dashboard entrypoint runs the same check again at container start, so the interlock now covers both stacks — see the read-only stack below.
- **AI architecture map**: OmniRoute (`docker-compose.omniroute.yml`) sends workflow digests to a free-tier LLM provider by default. A digest carries, per node: name, node type, schedule rule, webhook path, request URL (truncated to 120 characters), shell command (truncated to 160 characters), sub-workflow id, and `//` comments from Code nodes (truncated to 300 characters). Credentials and execution data are never included. Note that a URL or a command can itself carry a secret — an API key in a query string leaves the machine with the digest. Set `OMNIROUTE_ENABLED=false` to use local heuristic descriptions instead — bootstrap clears the gateway settings it auto-wired, so no digest leaves the machine. If you configured your own `AI_MAP_*` provider, that is kept and keeps receiving digests; clear the three variables to stop all LLM calls.

## Read-only stack

The read-only stack runs one po11y process against the remote n8n: the
`server`. It holds `N8N_API_KEY`, and the points below describe it.

- **Read-only REST API access**: The server invokes only HTTP `GET` requests against n8n (`server/n8n.mjs`'s `apiGet`, and `server/sync.mjs`'s `assertGetOnly` wrapper on every outbound call including the `/n8n-table/` proxy). No write calls are made to n8n. It has its own GET-only invariant test.
- **API key security**: The `N8N_API_KEY` is kept in process environment variables and is never saved to feed files or logs.
- **No Docker socket or Execute Command**: The read-only stack does not run n8n, so container listing and command execution nodes are not present.
- **Redacted webhook and heartbeat credentials**: Webhook and heartbeat URLs (such as `ALERT_WEBHOOK_URL` and `ALERT_HEARTBEAT_URL`, both configured on the server service) are treated as sensitive credentials. The server logs scheme and host only and redacts paths and query tokens.
- **Form submission proxy**: Disabled by default (`ENABLE_FORM_PROXY=false`). Enable form proxying only when protected by the forward-authentication overlay (`FORM_ALLOWED_GROUPS`).
- **Exposure interlock, from the container**: The read-only stack has no `bootstrap.sh`, so the check lives in the dashboard entrypoint, which both stacks share. A non-loopback `BIND_ADDR` with no auth gate — neither `DASHBOARD_BASIC_AUTH` nor the forward-auth overlay — stops the dashboard container with exit 78. `PO11Y_ALLOW_OPEN_BIND=1` accepts the open bind. Note what the check cannot do: it runs after `docker compose up` has already published the ports, so Grafana on 3000 and Prometheus on 9090 are reachable even while the dashboard refuses to serve. `scripts/readonly-preflight.sh` reports the same finding before you bring the stack up. Grafana also runs with anonymous Viewer access enabled (`GF_AUTH_ANONYMOUS_ENABLED`, default `true`).

### Upstream `N8N_METRICS` considerations

Setting `N8N_METRICS=true` on a remote n8n instance exposes `/metrics` on its main port without authentication. On public-facing n8n instances, restrict access to `/metrics` at your reverse proxy to allow requests only from the po11y server's IP.

## Common features

- **Default binding**: All services bind to `127.0.0.1` by default. Place services behind a TLS reverse proxy before exposing them to external networks.
- **Dashboard authentication**: Set `DASHBOARD_BASIC_AUTH=user:password` to protect dashboard endpoints, static files, and proxy routes. It protects nginx and nothing else. Grafana on port 3000 and Prometheus on port 9090 are published separately by the same `BIND_ADDR`, and neither passes through nginx: a request to `/grafana/` is authenticated, a request to port 3000 is not. The same limit applies to the forward-auth overlay. Move `BIND_ADDR` off loopback and both ports move with it, so restrict them at a firewall or keep the bind on loopback behind your own proxy.
- **Secrets in `.env`**: `.env` holds the generated database, Grafana and n8n credentials. `bootstrap.sh` and `scripts/readonly-preflight.sh` `chmod 600` it whenever they write to it. If you create `.env` by hand, do the same — `cp` inherits the umask, which usually leaves the file readable by every account on the host, and no HTTP password protects a file.
- **MCP endpoint security**: `/mcp/` shares the dashboard's authentication guards. On the bundled stack, `po11y_sql` executes queries under the read-only database role `po11y_ro`, which denies access to sensitive tables like `credentials_entity` and `execution_data`. Set `MCP_GRAFANA_URL=` in `.env` to disable `po11y_sql`.
- **Server `/metrics` endpoint**: Exposed on port `8081` within the internal Docker Compose network without public port mappings.
- **`POST /rebuild`**: The dashboard's **Rebuild map** action. It shares the dashboard's authentication guards, exactly like `/mcp/`, and carries no token of its own: it accepts no body and writes nothing to the store, so it cannot forge executions or silence alerts. Its cost is compute — and LLM spend where `AI_MAP_*` is configured — which a one-minute floor between forced builds bounds. On a `BIND_ADDR` outside loopback, set `DASHBOARD_BASIC_AUTH` (or the forward-auth overlay) as this document already advises; that is what gates this route too.

## Read authorization scope

Po11y does not provide per-viewer read authorization or tenant filtering for status feeds or architecture maps. Anyone with read access to the dashboard can view all status feeds. For multi-tenant read isolation, run the read-only stack against paid n8n instances configured with native RBAC and project controls.

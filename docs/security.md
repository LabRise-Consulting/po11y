# Security posture

Po11y runs on a single box bound to `127.0.0.1`. The parts that matter:

## Mode A (bundled)

- **No host Docker socket in n8n.** The container list comes from a read-only
  `docker-socket-proxy` sidecar that exposes only `GET /containers/json` and
  denies every write and every other endpoint. A compromised n8n cannot reach
  the host Docker daemon. Remove the proxy and the containers section simply
  goes empty.
- **Env access is blocked in Code nodes** (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`),
  so a workflow can't read the DB or Grafana passwords out of the process
  environment. The optional AI-map key lives in a file that is *not*
  web-served, never in the environment.
- **`fs` is the only allowed Code-node builtin**, scoped to the shared status
  volume it has to write.
- **Execute Command is enabled instance-wide** (`NODES_EXCLUDE=[]`), for every
  workflow anyone creates, not just the one that needs it — the Maps
  workflow's `n8n export:workflow` step. With the host socket gone, anything
  it runs is confined to the n8n container. Mode B runs without n8n entirely,
  so Execute Command is disabled there — `NODES_EXCLUDE` stays at n8n's
  secure default.
- **Exposure interlock**: `bootstrap.sh` refuses to start when `BIND_ADDR` is
  anything other than `127.0.0.1`/`localhost` and `DASHBOARD_BASIC_AUTH` is
  empty — an open bind with no gate exposes the anonymous Grafana Viewer and
  every feed. Set `DASHBOARD_BASIC_AUTH` (behind TLS), or set
  `PO11Y_ALLOW_OPEN_BIND=1` to override the refusal deliberately. **This
  check is Mode-A-only** — Mode B has no `bootstrap.sh`, so
  `docker compose -f docker-compose.readonly.yml up -d` will bind wide open
  without complaint; set `DASHBOARD_BASIC_AUTH` yourself before pointing
  `BIND_ADDR` at anything but loopback.

## Mode B (collector)

- **No write path of any kind.** `collector/collect.mjs`'s `apiGet` is the
  sole choke point for every call to the remote n8n, and it hard-codes
  `method: 'GET'`; a dedicated test asserts a full poll cycle makes only GET
  calls to the n8n host (the collector's one POST goes to the optional AI
  endpoint, never to n8n). On Community Edition the API key itself is
  unconditionally full-access — this GET-only discipline is the real access
  control, not the key's scope.
- **The n8n API key is env-only.** It lives in the collector process's
  environment, never logged, never written into a published feed, never
  served to the browser.
- **No Docker socket, no Execute Command** — Mode B doesn't run n8n at all, so
  neither exists to lock down.
- **The `/form/` proxy defaults to off** (`ENABLE_FORM_PROXY=false`). On a
  shared team box the dashboard's single Basic-Auth password would otherwise
  let anyone who can load the dashboard fire the remote n8n's form triggers,
  bypassing n8n's own auth. Enabling it is defensible only behind the
  [forward-auth overlay](forward-auth.md), which gates form firing on OIDC
  group membership (`FORM_ALLOWED_GROUPS`, deny by default).

## Common to both modes

- Everything binds to `127.0.0.1`, so plain HTTP is acceptable. Put it behind a
  TLS reverse proxy before exposing it beyond the box.
- **Optional dashboard gate**: set `DASHBOARD_BASIC_AUTH=user:password` in
  `.env` to require HTTP Basic Auth for everything the dashboard serves
  (static app, feeds, the grafana/prometheus proxies). Useful when
  `BIND_ADDR` is a private LAN/VPN IP; it is not a substitute for TLS.

Residual, and inherent to n8n: anyone who can add or edit workflows can run
JavaScript in a Code node. Treat editor access as trusted.

## Read authorization is out of scope

Per-viewer filtering of the architecture map and the status feeds is
deliberately not implemented. Every feed is computed from a single privileged
export against one n8n Community Edition root account, so there is no
per-viewer boundary to enforce — filtering the map client-side would look like
access control while enforcing none, since the full data has already left the
server. The forward-auth overlay adds *write*-side authorization (who may fire
a form) precisely because that is enforceable at the proxy. Anyone who needs
real read isolation needs n8n's own projects/RBAC (its paid tiers), and Mode B
pointed at such an instance is the supported path.

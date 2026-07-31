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
- **The alert webhook URL is treated as a credential.** For Slack and Telegram
  the secret *is* the URL, so `ALERT_WEBHOOK_URL` stays in the collector's
  process environment, is never written into a published feed, and only ever
  appears in logs as scheme + host — including in transport errors, which Node
  will otherwise quote the full URL into. The push targets an
  operator-configured host that is never the n8n host, the same shape as the
  optional AI call the GET-only invariant already permits, and nothing from the
  webhook's response is parsed — only its status code is read.
- **The heartbeat URL is treated as a credential too.** `ALERT_HEARTBEAT_URL`
  (the optional off-box dead-man switch, GETed after every successful poll)
  carries its monitor id in the path on every service that implements it, and
  anyone holding it can forge a healthy ping and mute the switch. It gets the
  same handling as the alert webhook: env-only, never in a feed, scheme + host
  in logs, scrubbed out of transport errors. Like the push it targets an
  operator-configured host that is never the n8n host, and its response body is
  never read.
- **A failed poll publishes a scrubbed error, not a raw one.** The `unreachable`
  alert's message reaches `notifications.json` — which the dashboard serves —
  and the push webhook, so the n8n base URL is stripped out of it before
  publishing. The unredacted line stays on stderr, which is operator-only.
- **The `/form/` proxy defaults to off** (`ENABLE_FORM_PROXY=false`). On a
  shared team box the dashboard's single Basic-Auth password would otherwise
  let anyone who can load the dashboard fire the remote n8n's form triggers,
  bypassing n8n's own auth. Enabling it is defensible only behind the
  [forward-auth overlay](forward-auth.md), which gates form firing on OIDC
  group membership (`FORM_ALLOWED_GROUPS`, deny by default).

### Turning on `N8N_METRICS` upstream is a real exposure

`N8N_METRICS_TARGET` points Prometheus at the remote n8n's `/metrics`, and that
only returns data if the operator of *that* instance sets `N8N_METRICS=true`.
Po11y asks them to; be clear about what it costs them, because this is the one
place where po11y's setup instructions widen someone else's attack surface
rather than its own.

n8n serves `/metrics` **on its main port, with no authentication** — the same
port and origin as the editor and the public API, gated by neither the login
session nor the API key. n8n's own documentation says the endpoint "should not
be exposed publicly to prevent sensitive operational data from being revealed".
In Mode A this is a non-issue: `n8n:5678` is compose-internal and never
published. In Mode B the remote is frequently internet-facing, so flipping the
flag makes `https://their-n8n.example.com/metrics` world-readable to anyone who
guesses the path — including workflow ids and names once the `*_INCLUDE_*`
flags Mode A sets are on.

Tell the upstream operator to enable it **and** block `/metrics` at their
reverse proxy for everyone except the po11y box. If they will not, leave
`N8N_METRICS=false`: the only thing lost is the Grafana tab, which degrades to
empty. **No shipped alert rule depends on it** — every rule in
`observability/alerts.yml` reads a collector-produced series, because the
collector's `po11y_n8n_up` proves the API key still works whereas
`up{job="n8n"}` only proves a port answers.

## Common to both modes

- Everything binds to `127.0.0.1`, so plain HTTP is acceptable. Put it behind a
  TLS reverse proxy before exposing it beyond the box.
- **Optional dashboard gate**: set `DASHBOARD_BASIC_AUTH=user:password` in
  `.env` to require HTTP Basic Auth for everything the dashboard serves
  (static app, feeds, the grafana/prometheus proxies). Useful when
  `BIND_ADDR` is a private LAN/VPN IP; it is not a substitute for TLS.

### Collector `/metrics`

Served on the collector's health port (8081), which has no compose `ports:`
mapping and is therefore reachable only from the compose network. The exported
series carry workflow ids, names and timestamps — a strict subset of the
`map.json` the dashboard already serves — plus liveness gauges. The n8n API key
is never passed to the metrics module, which like `watchdog.mjs` makes no network
calls and touches no filesystem.

Workflow *names* are the sensitive part, and they are already public to anyone
who can reach the dashboard. If your Prometheus is shared with people who should
not see them, do not add the scrape job.

### Alertmanager overlay

Two deliberate trade-offs, both opt-in with the overlay:

- **`ALERTMANAGER_WEBHOOK_URL` is written to a file inside the
  `alertmanager_data` volume** (`/alertmanager/webhook_url`, mode 600) at
  container start, and read back through Alertmanager's `url_file`. This is a
  deviation from the collector's env-only, nothing-on-disk posture, forced by
  Alertmanager having no env interpolation of its own. It is still preferable to
  the alternative: `sed`-ing the URL into the config corrupts any URL containing
  `&`, because `&` on the right-hand side of `s|||` expands to the whole match.
- **The Alertmanager UI on :9093 has no authentication** and can silence alerts
  and read every alert label. It binds to `BIND_ADDR` (loopback by default), the
  same posture as Prometheus and Grafana. Putting it on a non-loopback address
  means putting it behind the forward-auth overlay.

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

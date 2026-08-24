# Configuration and feed contracts

The dashboard reads configuration from `/config.json` and status feeds proxied from the po11y `server`'s own store. This page defines the format and requirements for each file.

## `/config.json`

See [`config.example.json`](../config.example.json). All fields are optional.

| Key | Description |
|-----|-------------|
| `title`, `lede`, `footer` | UI branding text. `lede` appears in the sidebar below the title. `footer` is an array of `[{text, href?}]` rendered at the bottom of the sidebar. |
| `cards` | Defined as `{ "Group heading": [{name, sub, href \| action, tip?, up?, mem?}] }`. Defines ordered card groups. `tip` sets hover tooltips. `up` (and optional `mem`) accept Prometheus queries to show live status indicators (UP/DOWN, RSS memory). `action` sets a form trigger path that sends POST requests through the `/form/` proxy. Cards declared here override auto-discovered form cards. |
| `tabs` | Defined as `[{id, label, src, group?}]`. Configures iframe views in the sidebar. `src` specifies the page path (e.g. `/site/page.html`). Entries with matching `group` labels group together into a tabbed sidebar item. The open view is named in the address bar (`#projects`, `#reports/daily`) — see [Address-bar routing](#address-bar-routing). |
| `sections` | Controls visible status sections and headings: `{executions, notifications}`. `notifications` opens a dedicated sidebar view with an unread badge. `executions` renders in the Overview view. (`containers` is still accepted for backward compatibility, but `status.json` never carries a `containers` list any more — see [docs/server.md](server.md#accepted-regressions) — so a configured `containers` section always renders empty.) |
| `metrics` | Configures Grafana and Prometheus metrics panels: `{heading, grafana: {embed, base, dashboard, panels: [{id, title?, span?, h?, wide?}], range}, promBase, stats: [{label, up, mem?}]}`. `span` sets column width (1–4, default 2). `h` sets height in pixels (120–800). |
| `refreshSec` | Poll interval for `status.json` and `notifications.json` in seconds (default `30`). |
| `metricsRefreshSec` | Refresh interval for metrics in seconds (default `60`, `0` disables). Grafana embeds update automatically; Prometheus stat cards re-poll. |
| `staleAfterMin` | Minutes before status data is flagged as stale (default `5`). |
| `statusHint` | Text displayed while `status.json` is loading or missing. |
| `baseUrl` | Hostname substituted for `{host}` in links. See details below. |
| `n8nUrl` | n8n base URL, substituted for `{n8n}` in links and used for form links (default `http://{host}:5678`). |
| `formProxy` | Enables the `/form/` proxy endpoint (default `true`; set `false` on the read-only stack unless forward-auth is enabled). When `false`, fieldless form triggers link directly to n8n form pages. |
| `scopes` | Enables multi-team scope selectors: `{ "<scope>": "Display name" }`. Keys must match `[a-z0-9-]+`. |

### Host substitution (`{n8n}`, `{host}`, `{self}` and `baseUrl`)

Three placeholders are substituted in `href` and `src` fields. Relative path links like `/grafana` use none of them.

| Placeholder | Resolves to | Use it for |
|---|---|---|
| `{n8n}` | The whole `n8nUrl`, scheme and port included, with any trailing slash removed | Every link to n8n |
| `{host}` | `baseUrl` when set, otherwise the browser's hostname | Other services on the n8n host |
| `{self}` | The browser's hostname, always — `baseUrl` is ignored | Services beside the dashboard, such as Prometheus |

Prefer `{n8n}` for n8n links. `{host}` carries a host and nothing else, so a link built as `http://{host}:5678/workflow/new` hardcodes both the scheme and the port: an n8n behind TLS, or on any other port, cannot be reached that way however correct `baseUrl` is. `{n8n}` takes its whole shape from `n8nUrl`, so `"n8nUrl": "https://n8n.example.com"` moves every n8n link at once.

`{self}` versus `{host}` matters on the read-only topology: `baseUrl` points at the remote n8n there, so a `{host}` link to a local service resolves to the remote host and fails.

On the read-only topology, `./scripts/readonly-preflight.sh` fills `baseUrl` and `n8nUrl` in from `N8N_PUBLIC_URL` (or `N8N_API_URL`) the first time it runs, and never overwrites a value you set yourself. Without it both stay empty and every n8n link resolves to the box serving the dashboard.

### Multi-team views (`scopes`)

When several publishers feed a single dashboard, assign a scope to each source.

- The canonical scope (`default`) reads directly from `/status.json`, `/map.json`, etc.
- Named scopes (`<scope>`) read from `/status/<scope>/<feed>.json`, proxied by nginx.

Define scopes in `config.json`:
```json
{
  "scopes": {
    "default": "Primary Instance",
    "team-a": "Team A"
  }
}
```

When multiple scopes are defined, a scope selector dropdown appears in the header. Switching scopes updates feed requests for status, notifications, forms, and maps.

**One `server` process answers for exactly one `PO11Y_SCOPE`.** A multi-scope
dashboard needs one `server` service per scope — each with its own store and
its own `PO11Y_SCOPE` — all behind the same nginx; see
[docs/server.md](server.md#multi-scope-deployments) for the full picture. Form
proxying (`/form/`), list proxying (`/n8n-table/`), and Kubernetes manifests
do not use scope paths.

## Status Feed Contracts

### `/status.json`

Written by the po11y `server`, from its own store, on every deployment.

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "executions": {
    "recent": 42,
    "errors": 1,
    "byWorkflow": [
      { "name": "Sync Job", "id": "42", "count": 10, "errors": 0, "lastAt": "2026-07-10T11:58:00Z", "running": 1 }
    ]
  }
}
```

`status.json` always carries this `executions` object with run metrics. It
never carries a container list — see [docs/server.md](server.md#accepted-regressions).

`byWorkflow` holds every workflow that appears in the recent window, busiest
first, with no top-N truncation — so the per-workflow counts sum to `recent`,
and consumers can search the whole set. The dashboard shows the first ten and
offers a "show all" button; its filter box searches all of them.

`running` is how many executions of that workflow were still in flight at the
last poll, and the dashboard renders it as a cyan dot and an "N running" pill.
Two things bound it:

- **It is as fresh as `SERVER_POLL_INTERVAL`** (30 s by default), not live. A
  workflow that finishes inside one poll window can start and end without ever
  being seen as running. Lower it if your workflows are shorter than the
  interval and you want their runs visible while they happen.
- **It needs the running listing.** n8n leaves in-flight executions out of the
  default `/executions` response, so the server asks for `?status=running`
  separately each poll. If that request fails the poll still succeeds and logs
  `running-executions listing failed`; the counts simply go stale until an
  execution ends and reappears with its terminal status.

Only the `running` status counts. An execution parked on a Wait node longer
than 65 seconds is `waiting`, not `running`, because n8n takes it out of memory
— it is not consuming a worker, so Po11y does not report it as in flight.
Shorter waits stay in memory and remain `running`.

To watch the indicator work, import `workflows/demo/heartbeat.json`
(`./bootstrap.sh --pack /workflows/demo`). It holds an execution open for 20
seconds of every minute. The bundled example workflows all finish in a few
seconds, which is shorter than the default poll interval.

### `/notifications.json`

Array of notifications sorted newest-first.

```json
[
  {
    "ts": "2026-07-10T12:00:00Z",
    "title": "Workflow Error",
    "message": "Workflow #42 failed",
    "status": "failure",
    "link": "http://127.0.0.1:5678/workflow/42"
  }
]
```

`status` values: `success`, `failure`, `info`.

#### Watchdog Rules

The watchdog evaluates these rules against recent executions (`EXECUTIONS_LIMIT`, default `250`). The po11y server runs them against its own store, from the same variables, on every deployment.

| Rule | Description | Default Budget |
|------|-------------|----------------|
| `failing` | Triggers when error count and error rate exceed thresholds | `ALERT_MIN_ERRORS=3`, `ALERT_ERROR_RATE=0.5` |
| `stale` | Triggers when a workflow has no successful executions within the budget | `ALERT_STALE_AFTER_MIN=0` (disabled by default) |
| `stuck` | Triggers when an execution remains in `running` status past the budget | `ALERT_STUCK_AFTER_MIN=0` (disabled by default) |
| `unreachable` | Triggers when n8n's API cannot be reached | Always enabled when watchdog is active |

Notes:
- `unreachable` alerts trigger when n8n cannot be reached. When n8n is offline, existing workflow alerts remain unchanged until connectivity returns.
- Staleness is calculated from the last successful run, not the last execution attempt.
- When an alert condition clears, a `success` notification ("recovered") is appended.

#### Webhook Push Notifications

Set `ALERT_WEBHOOK_URL` to push notifications to external webhooks. Set `ALERT_WEBHOOK_FORMAT` to match your target platform:

| Format | JSON Payload | Description |
|--------|--------------|-------------|
| `slack` | `{text}` | Slack incoming webhooks and Mattermost |
| `discord` | `{content}` | Discord channel webhooks |
| `telegram` | `{chat_id, text}` | Telegram Bot API (requires `ALERT_TELEGRAM_CHAT_ID`) |
| `raw` | `{text, alerts:[…]}` | Generic JSON payload for webhooks or n8n endpoints |

The server sends these — see [docs/alerting.md](alerting.md) for the full picture. It redacts authentication tokens from webhook URLs in logs and limits HTTP request duration using `ALERT_WEBHOOK_TIMEOUT_MS` (default `10000`).

#### External Heartbeat Monitoring

Set `ALERT_HEARTBEAT_URL` on the server service, on either compose file, to send an HTTP GET request to an external monitoring service after each successful sync — the server's reachability probe against n8n. The request timeout is controlled by `ALERT_HEARTBEAT_TIMEOUT_MS` (default `10000`).

### Prometheus Metrics

The po11y server exposes Prometheus metrics at `server:8081/metrics`, on every deployment. Both compose files scrape it as the `po11y-server` job, so these series are available to Grafana on either stack. `observability/alerts.yml` reads the same series, but neither Prometheus config loads it on its own — add the `docker-compose.alerts.yml` overlay, which supplies the `rule_files` entry and Alertmanager. See [docs/alerting.md](alerting.md).

| Metric | Type | Labels | Description |
|---|---|---|---|
| `po11y_n8n_up` | Gauge | None | `1` if n8n API is reachable, else `0`. |
| `po11y_poll_last_success_timestamp_seconds` | Gauge | None | Unix timestamp of the last successful poll. |
| `po11y_workflow_errors_total` | Counter | `workflow_id`, `workflow_name` | Total failed executions recorded for a workflow, persisted in the store. |
| `po11y_workflow_executions_total` | Counter | `workflow_id`, `workflow_name` | Total executions recorded finishing for a workflow, successful or failed. The denominator under `po11y_workflow_errors_total`. |
| `po11y_workflow_last_success_timestamp_seconds` | Gauge | `workflow_id`, `workflow_name` | Unix timestamp of the last successful run for a workflow. Omitted if a workflow has no recorded success. |
| `po11y_workflow_running_seconds` | Gauge | `workflow_id`, `workflow_name` | Duration in seconds of the current longest-running execution (`0` if none). |
| `po11y_ai_map_llm_up` | Gauge | None | `1` if the last ai-map build got LLM prose, `0` if it fell back to heuristic descriptions. Absent when no LLM is configured, and until a build has actually called one. |

Before writing rules against these:

- **`po11y_ai_map_llm_up` reports the last LLM *call*, not a reachability probe.** Nothing scrapes the gateway directly; the value is a byproduct of the ai-map build the server already performs. `buildAiMap` returns without calling the LLM when the workflow set has not changed (`republish`, `keep-annotated`, `skip-fresh`), and on those rebuilds the metric holds its previous reading rather than reporting an all-clear it has no evidence for. A stack whose workflows never change can therefore hold a stale `1` — the reading is only refreshed when a build genuinely goes to the LLM. Force one with `docker kill -s HUP <server>`.
- **It is absent, not `0`, when no LLM is configured.** A deployment running `OMNIROUTE_ENABLED=false` with no `AI_MAP_*` has no LLM to be down, and a `0` there would leave `Po11yAiMapLlmDegraded` firing forever on a correctly configured stack.

- **`po11y_workflow_errors_total` is persisted and monotonic.** The count lives in a SQLite table, incremented once per failed execution and never decremented, so it survives process restarts and retention pruning. This replaced an in-memory accumulator that reset to zero on every restart — a reset Prometheus believed, several times a week. Expect one discontinuity the first time a deployment runs on the new counter (the table starts empty), then a flatter, more honest line than before. **A store restored from an older backup rewinds the counter** — that is a genuine counter reset, and Prometheus handles it correctly. Do not paper over it with a `max()` guard.
- **`po11y_workflow_executions_total` is the denominator, and it is not "all executions".** It counts runs that reached a verdict of their own — `success`, `error` and `crashed`. `canceled` is in neither this counter nor the error counter: a human stopped the run, so it never reached one, and counting it here would make every cancellation read as a dip in success rate. `new`, `running` and `waiting` have not finished at all. Every failed status is also a finished status by construction, so `errors / executions` is a rate bounded by 1:

  ```promql
  100 * (1 - sum(po11y_workflow_errors_total) / sum(po11y_workflow_executions_total))   # success rate, %
  100 * po11y_workflow_errors_total / po11y_workflow_executions_total                   # failure rate per workflow, %
  ```

  Both are `sum()/sum()` rather than an average of per-workflow rates on purpose: a workflow that ran twice must not weigh the same as one that ran two thousand times.
- **The denominator is backfilled once, and it is pessimistic on an old store.** A store that predates this counter already has failures in `workflow_error_totals`, so starting the new table at zero would compute `1 - 4/1 = -300%` on the first finished run. The table is therefore seeded the one time it is created, from the failures already counted plus the successes still retained. Successes already pruned past `PO11Y_RETENTION_DAYS` cannot be recovered, so a store older than its retention window understates its success rate until the counter has run for one full window. Understating it is the safe direction.
- **A workflow that has never succeeded exports no `last_success` series.** Zero-filling would mean 1970, so every staleness rule would fire on workflows that simply have not run yet. Use the `failing` rule for that case, or `absent()` to alert on it explicitly.
- **During an n8n outage the server keeps serving the last known per-workflow series** and only sets `po11y_n8n_up` to `0`. Clearing them would restart every Prometheus `for:` duration and turn one outage into flapping alerts on recovery. The cost is that an outage also trips the staleness and stuck rules, which is what the shipped Alertmanager inhibit rule collapses.

### Sizing the Execution Window

The server retrieves up to `EXECUTIONS_LIMIT` executions per poll. The default is `250`, which is also the maximum that n8n's API accepts. Ensure `EXECUTIONS_LIMIT` is greater than or equal to the expected number of executions completed during one `SERVER_POLL_INTERVAL`. Executions above the window are invisible to `status.json` and to the `failing` rule. Because the default is already the maximum, an instance that exceeds it must decrease `SERVER_POLL_INTERVAL`. Decrease `EXECUTIONS_LIMIT` only to give a slow n8n a smaller response to build.

### Watchdog Internal State

The server keeps alert-dedupe state in its own SQLite store, not on disk as a separate file. This prevents repeating notifications on every cycle. `ALERT_RENOTIFY_MIN` sets the re-notification interval (default `360` minutes; `0` disables re-notification). It is not served by Nginx.

### `/map.json`

Rendered by the [`site/map.html`](../site/map.html) tab.

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "mermaid": "graph TD\n ...",
  "workflows": 4,
  "entries": [{ "nid": "wf_42", "id": "42", "name": "Sync Job", "sub": "" }]
}
```

### `/forms.json`

Lists active form triggers. Merged automatically into the Actions card group.

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "forms": [{ "name": "Deploy Form", "sub": "Production", "path": "/form/deploy", "fields": 0 }]
}
```

Fieldless forms (`fields: 0`) fire directly via POST requests through `/form/`. Forms with input fields open n8n's native form page.

### `/ai-map.json`

Alongside the map, `llm` records why the prose reads the way it does:

```json
"llm": { "configured": true, "ok": false, "error": "LLM POST -> 503" }
```

`configured` is whether all three `AI_MAP_*` variables are set. `ok` is `null`
when they are not — an unconfigured stack is neither healthy nor degraded — and
otherwise `false` when an LLM was configured but the published text is
heuristic. `error` carries the transport failure, scrubbed of the gateway URL.
A degraded build also publishes an `info` notification through the watchdog, so
it appears in the dashboard's notifications feed rather than only in the log.

Rendered by [`site/ai-map.html`](../site/ai-map.html). Contains structured diagram data and AI-generated node descriptions.

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "model": "auto/best-free",
  "eyebrow": "Architecture Map",
  "title": "System Architecture",
  "lede": "Overview of active workflows",
  "columns": ["Triggers", "Actions"],
  "kinds": { "sched": "neutral" },
  "nodes": [{ "id": "42", "col": 0, "kind": "sched", "tag": "Cron", "name": "Hourly Sync", "sub": "Runs every hour" }],
  "edges": [["42", "43", "sched"]],
  "legend": [["Schedule", "sched"]],
  "notes": [],
  "sigs": { "42": "a1b2c3d4" }
}
```

## n8n DataTable Read Proxy (`/n8n-table/`)

The `/n8n-table/` proxy routes GET requests to n8n's public API using a read-only API key stored in `N8N_READ_API_KEY`. The po11y server enforces the proxy's allowlist and injects the key (nginx only forwards); the key is configured on the `server` service.

### Setup

1. In n8n (**Settings > n8n API**), create an API key scoped only to **data-table row: read**.
2. Add the key to `.env` as `N8N_READ_API_KEY`.
3. Configure your `list` tab endpoint: `/n8n-table/data-tables/<dataTableId>/rows?sortBy=id:desc`.

Always sort DataTable queries by a unique column (such as `id:desc`) to ensure reliable pagination.

## Custom Instance Pages (`tabs`)

Custom pages placed in `/site/` can be added to the dashboard sidebar using `tabs[]` in `config.json`. Pages adapt to dark/light theme settings via `po11y-theme` in `localStorage` and `html[data-theme]`.

### Address-bar routing

The open view is named in the URL fragment, so a reload, a bookmark or a shared
link opens it instead of the Overview. The dashboard writes the canonical form
and accepts the shorter ones:

| Hash | Opens |
|------|-------|
| `#overview`, `#notifications` | Those two views. |
| `#projects` | An ungrouped tab, by its `id` or its `label`. |
| `#reports/daily` | A grouped tab: group first, then the tab. |
| `#reports` | That group, on its remembered tab. |
| `#map` | A grouped tab named on its own — the group is implied. |

Matching ignores case and punctuation (`#PRs` and `#prs` are the same view), and
a hash naming nothing in the config is ignored: the Overview opens and the URL
is left alone. Selecting a view or a tab pushes a history entry, so the browser
Back button walks the views.

### Data Table List View (`site/list.html`)

Render tabular data using `site/list.html` by configuring a tab entry:

```json
{
  "id": "orders",
  "label": "Orders",
  "src": "/site/list.html",
  "list": {
    "title": "Orders",
    "endpoint": "/n8n-table/data-tables/REPLACE_WITH_TABLE_ID/rows?sortBy=id:desc",
    "defaultSort": "day",
    "defaultRange": "7d",
    "mapping": {
      "title": "title",
      "url": "url",
      "score": "score",
      "day": "firstSeen",
      "badge": "source",
      "meta": ["customer", "region"],
      "detail": "detail"
    }
  }
}
```

#### Configuration Properties

- `endpoint`: API endpoint path (e.g. `/n8n-table/...` or static JSON path).
- `mapping`: Maps data columns to card fields (`title`, `url`, `score`, `day`, `badge`, `meta`, `detail`).
- `badge`: (Optional) Column displayed as a tag pill next to the title. When the rows in the selected range carry more than one badge value, the tab also shows a multi-select filter — tick any number of values (e.g. `sentry` and `grafana`) to narrow the list, **All** to clear it. Rows without a badge are hidden while the filter is active. The filter is client-side, so it never re-fetches; it resets on reload.
- `badgeLabel`: (Optional) Caption for that filter row. Default `Source`.
- `detail`: (Optional) Column containing JSON assessment arrays (`{ aspect, kind, assessment }`) to make cards expandable.
- `defaultSort`: `"day"` (date grouped) or `"score"` (ranking order).
- `defaultRange`: Active time range filter on load (`"all"`, `"today"`, `"7d"`, `"30d"`).
- `pageSize`: Number of rows per request (default `250`).

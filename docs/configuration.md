# Configuration and feed contracts

The dashboard reads configuration from `/config.json` and status feeds from the shared status volume. This page defines the format and requirements for each file.

## `/config.json`

See [`config.example.json`](../config.example.json). All fields are optional.

| Key | Description |
|-----|-------------|
| `title`, `lede`, `footer` | UI branding text. `lede` appears in the sidebar below the title. `footer` is an array of `[{text, href?}]` rendered at the bottom of the sidebar. |
| `cards` | Defined as `{ "Group heading": [{name, sub, href \| action, tip?, up?, mem?}] }`. Defines ordered card groups. `tip` sets hover tooltips. `up` (and optional `mem`) accept Prometheus queries to show live status indicators (UP/DOWN, RSS memory). `action` sets a form trigger path that sends POST requests through the `/form/` proxy. Cards declared here override auto-discovered form cards. |
| `tabs` | Defined as `[{id, label, src, group?}]`. Configures iframe views in the sidebar. `src` specifies the page path (e.g. `/site/page.html`). Entries with matching `group` labels group together into a tabbed sidebar item. |
| `sections` | Controls visible status sections and headings: `{containers, executions, notifications}`. `notifications` opens a dedicated sidebar view with an unread badge. `containers` and `executions` render in the Overview view. |
| `metrics` | Configures Grafana and Prometheus metrics panels: `{heading, grafana: {embed, base, dashboard, panels: [{id, title?, span?, h?, wide?}], range}, promBase, stats: [{label, up, mem?}]}`. `span` sets column width (1–4, default 2). `h` sets height in pixels (120–800). |
| `refreshSec` | Poll interval for `status.json` and `notifications.json` in seconds (default `30`). |
| `metricsRefreshSec` | Refresh interval for metrics in seconds (default `60`, `0` disables). Grafana embeds update automatically; Prometheus stat cards re-poll. |
| `staleAfterMin` | Minutes before status data is flagged as stale (default `5`). |
| `statusHint` | Text displayed while `status.json` is loading or missing. |
| `baseUrl` | Hostname substituted for `{host}` in links. See details below. |
| `n8nUrl` | n8n instance URL for workflow and form links (default `http://{host}:5678`). |
| `formProxy` | Enables the `/form/` proxy endpoint (default `true`; set `false` in Mode B unless forward-auth is enabled). When `false`, fieldless form triggers link directly to n8n form pages. |
| `scopes` | Enables multi-team scope selectors: `{ "<scope>": "Display name" }`. Keys must match `[a-z0-9-]+`. |

### Hostname substitution (`{host}` and `baseUrl`)

Occurrences of `{host}` in `href` and `src` fields are replaced with the browser's hostname. Set `baseUrl` to a specific hostname if deep links (such as n8n editor links) should point to a different host than the dashboard. Relative path links like `/grafana` do not use `{host}`.

### Multi-team views (`scopes`)

When multiple collectors or sources publish to a single dashboard, assign a scope to each source.

- The canonical scope (`default`) reads directly from `/status.json`, `/map.json`, etc.
- Named scopes (`<scope>`) read from `/status/<scope>/<feed>.json` on the same volume.

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

To publish to a scope in Mode B, set `STATUS_DIR=/po11y-status/<scope>`. Form proxying (`/form/`), list proxying (`/n8n-table/`), and Kubernetes manifests do not use scope paths.

## Status Feed Contracts

### `/status.json`

Written by Mode A workflows or the Mode B collector. Must be written atomically (write to a temporary file, then rename).

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "containers": [
    { "name": "n8n", "status": "Up 2 hours", "image": "n8nio/n8n:2.29.8" }
  ]
}
```

In Mode B, `status.json` includes an `executions` object with run metrics instead of a container list.

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

#### Mode B Watchdog Rules

The Mode B collector watchdog evaluates rules against recent executions (`EXECUTIONS_LIMIT`, default `100`):

| Rule | Description | Default Budget |
|------|-------------|----------------|
| `failing` | Triggers when error count and error rate exceed thresholds | `ALERT_MIN_ERRORS=3`, `ALERT_ERROR_RATE=0.5` |
| `stale` | Triggers when a workflow has no successful executions within the budget | `ALERT_STALE_AFTER_MIN=0` (disabled by default) |
| `stuck` | Triggers when an execution remains in `running` status past the budget | `ALERT_STUCK_AFTER_MIN=0` (disabled by default) |
| `unreachable` | Triggers when the collector cannot reach the n8n API | Always enabled when watchdog is active |

Notes:
- `unreachable` alerts trigger when n8n cannot be reached. When n8n is offline, existing workflow alerts remain unchanged until connectivity returns.
- Staleness is calculated from the last successful run, not the last execution attempt.
- When an alert condition clears, the collector appends a `success` notification ("recovered").

#### Webhook Push Notifications

Set `ALERT_WEBHOOK_URL` to push notifications to external webhooks. Set `ALERT_WEBHOOK_FORMAT` to match your target platform:

| Format | JSON Payload | Description |
|--------|--------------|-------------|
| `slack` | `{text}` | Slack incoming webhooks and Mattermost |
| `discord` | `{content}` | Discord channel webhooks |
| `telegram` | `{chat_id, text}` | Telegram Bot API (requires `ALERT_TELEGRAM_CHAT_ID`) |
| `raw` | `{text, alerts:[…]}` | Generic JSON payload for webhooks or n8n endpoints |

The collector redacts authentication tokens from webhook URLs in logs and limits HTTP request duration using `ALERT_WEBHOOK_TIMEOUT_MS` (default `10000`).

#### External Heartbeat Monitoring

Set `ALERT_HEARTBEAT_URL` in Mode B to send an HTTP GET request to an external monitoring service after each successful poll. The request timeout is controlled by `ALERT_HEARTBEAT_TIMEOUT_MS` (default `10000`).

### Prometheus Metrics (Mode B)

The Mode B collector exposes Prometheus metrics at `collector:8081/metrics`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `po11y_n8n_up` | Gauge | None | `1` if n8n API is reachable, else `0`. |
| `po11y_poll_last_success_timestamp_seconds` | Gauge | None | Unix timestamp of the last successful poll. |
| `po11y_workflow_errors_total` | Counter | `workflow_id`, `workflow_name` | Total failed executions observed since collector start. |
| `po11y_workflow_last_success_timestamp_seconds` | Gauge | `workflow_id`, `workflow_name` | Unix timestamp of the last successful run for a workflow. Omitted if a workflow has no recorded success. |
| `po11y_workflow_running_seconds` | Gauge | `workflow_id`, `workflow_name` | Duration in seconds of the current longest-running execution (`0` if none). |

Before writing rules against these:

- **`po11y_workflow_errors_total` accumulates; it is not the window count.** The collector reads a sliding window whose error count drops as it moves, so exporting that count directly would make `increase()` read every slide as a counter reset. The series resets only when the collector restarts, which is a genuine counter reset.
- **A workflow that has never succeeded exports no `last_success` series.** Zero-filling would mean 1970, so every staleness rule would fire on workflows that simply have not run yet. Use the `failing` rule for that case, or `absent()` to alert on it explicitly.
- **During an n8n outage the collector keeps serving the last known per-workflow series** and only sets `po11y_n8n_up` to `0`. Clearing them would restart every Prometheus `for:` duration and turn one outage into flapping alerts on recovery. The cost is that an outage also trips the staleness and stuck rules, which is what the shipped Alertmanager inhibit rule collapses.

### Sizing the Execution Window (Mode B)

The collector retrieves up to `EXECUTIONS_LIMIT` executions per poll (default `100`, maximum `250`). Ensure `EXECUTIONS_LIMIT` is greater than or equal to the expected number of executions completed during one `POLL_INTERVAL`. If execution volume exceeds `EXECUTIONS_LIMIT`, increase `EXECUTIONS_LIMIT` or decrease `POLL_INTERVAL`.

### Collector Internal State (`alert-state.json`)

The watchdog stores alert state in `alert-state.json` inside the status directory. This prevents repeating notifications on every poll cycle. `ALERT_RENOTIFY_MIN` sets the re-notification interval (default `360` minutes; `0` disables re-notification). This file is used internally by the collector and is not served by Nginx.

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

The Nginx proxy `/n8n-table/` routes GET requests to n8n's public API using a read-only API key stored in `N8N_READ_API_KEY`.

### Setup

1. In n8n (**Settings > n8n API**), create an API key scoped only to **data-table row: read**.
2. Add the key to `.env` as `N8N_READ_API_KEY`.
3. Configure your `list` tab endpoint: `/n8n-table/data-tables/<dataTableId>/rows?sortBy=id:desc`.

Always sort DataTable queries by a unique column (such as `id:desc`) to ensure reliable pagination.

## Custom Instance Pages (`tabs`)

Custom pages placed in `/site/` can be added to the dashboard sidebar using `tabs[]` in `config.json`. Pages adapt to dark/light theme settings via `po11y-theme` in `localStorage` and `html[data-theme]`.

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
- `badge`: (Optional) Column displayed as a tag pill next to the title.
- `detail`: (Optional) Column containing JSON assessment arrays (`{ aspect, kind, assessment }`) to make cards expandable.
- `defaultSort`: `"day"` (date grouped) or `"score"` (ranking order).
- `defaultRange`: Active time range filter on load (`"all"`, `"today"`, `"7d"`, `"30d"`).
- `pageSize`: Number of rows per request (default `250`).

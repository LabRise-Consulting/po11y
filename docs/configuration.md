# Configuration and feed contracts

The dashboard reads one config file and a handful of small JSON feeds from the
shared status volume. This page is the contract for each.

## `/config.json`

See [`config.example.json`](../config.example.json). Everything is optional;
omitted pieces don't render.

| key | what |
|-----|------|
| `title`, `lede`, `footer` | branding; `lede` renders in the sidebar under the title; `footer` is `[{text, href?}]`, rendered at the sidebar's foot |
| `cards` | `{ "Group heading": [{name, sub, href, tip?, up?, mem?}] }`, ordered groups of link cards; `tip` overrides the hover tooltip, and an `up` (+ optional `mem`) Prometheus query makes the card double as a live status card (up/DOWN · rss) |
| `tabs` | `[{id, label, src, group?}]`, iframe views listed in the sidebar; serve `src` yourself (e.g. under `/site/`). Entries sharing a `group` label fold into one sidebar entry whose view keeps a tab strip (last-open tab remembered per group) |
| `sections` | which status sections render, and their headings: `{containers, executions, notifications}`. `notifications` renders as its own sidebar view with an unseen badge (count of entries newer than the last visit, red when one is a failure; watermark in localStorage `po11y-notif-seen`); the rest render as Overview sections, each with a sidebar jump link |
| `metrics` | `{heading, grafana: {embed, base, dashboard, panels: [{id, title?, span?, h?, wide?}], range}, promBase, stats: [{label, up, mem?}]}` — `wide` spans the full row; `span` (1-4, default 2) is how many grid tracks a panel takes on wide screens (the row has 4, so 1 ≈ a quarter); `h` pins the panel height in px (120-800) when the span-derived height cuts the chart off; the Grafana deep-link card renders only when `embed` is off |
| `refreshSec` | poll interval for status + notifications (default 30) |
| `metricsRefreshSec` | metrics refresh interval (default 60, `0` disables): grafana embeds get a native `refresh` param (panels re-query themselves, no reload), prometheus stat cards re-poll |
| `staleAfterMin` | staleness threshold (default 5) |
| `statusHint` | text shown while `status.json` is missing |
| `baseUrl` | optional; a bare host (not a URL prefix) substituted for `{host}` instead of the browser's hostname — see below |
| `scopes` | optional; multi-team views: `{ "<scope>": "Display name" }`, `<scope>` restricted to `[a-z0-9-]+` — see below |

`{host}` inside any `href`/`src` is replaced with the browser's hostname, so
one config works from every device that can reach the box. Set `baseUrl` when
a `{host}`-templated deep link (an n8n editor card, the auto-discovered form
links) should point at a different host than the dashboard's — the
same-origin `/grafana` embed and `/prom` metrics don't use `{host}` and are
unaffected. It substitutes into the same slot `{host}` occupies (e.g.
`http://{host}:5678/`); it is not a URL prefix. A non-string or empty value
falls back to the browser-hostname behavior.

**Multi-team views (`scopes`).** When several publishers each feed the same
dashboard — several Mode B collectors, or Mode A plus a collector — give each
a scope. The `default` scope is the flat canonical feeds (`/status.json`, …);
a non-default scope `<s>` lives under `/status/<s>/` on the same volume (nginx
serves both, with the scope charset and feed whitelist enforced by regex).
List them in `config.json` as `{ "default": "This box", "team-a": "Team A" }`;
with more than one entry the header shows a switcher (remembered in
`localStorage`) and every feed fetch — status, notifications, forms, and the
Map/Architecture tabs — is drawn from the active scope. With no `scopes` key,
or a single entry, the dashboard fetches the flat paths exactly as before.
Keys outside the charset are dropped with a console warning.

To feed a non-default scope, run a collector with
`STATUS_DIR=/po11y-status/<scope>` (created at startup). The `/form/` proxy
remains single-upstream — form firing is scope-agnostic.

## `/status.json` (your publisher writes this)

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "containers": [ { "name": "…", "status": "Up 2 hours", "image": "…" } ]
}
```

Write it atomically (tmp file plus rename on the same volume). Sections you
don't enable in `config.json` can simply be absent. In Mode B it carries an
`executions` summary (recent run count, error count, per-workflow breakdown)
instead of a container list.

## `/notifications.json` (optional)

Newest first. The dashboard shows the newest 5 with a "show all" toggle.

```json
[ { "ts": "…", "title": "…", "message": "…", "status": "success|failure|info",
    "link": "https://…" } ]
```

In Mode A an n8n sub-workflow owns this file. In Mode B the collector's optional
watchdog writes it (`ALERTS_ENABLED=true`, see the "Mode B" block in
`.env.example`), prepending new entries and truncating to `ALERT_FEED_MAX`.
Enable the `notifications` section in `config.json` to render them.

The watchdog evaluates three rules against the execution window it already
fetches for `status.json` — no extra n8n calls, still GET-only:

| rule | fires when | budget |
|------|-----------|--------|
| `failing` | errors clear both `ALERT_MIN_ERRORS` and `ALERT_ERROR_RATE` in the window | both floors, defaults 3 and 0.5 |
| `stale` | no *successful* execution within the budget, including an active workflow with no executions at all | `ALERT_STALE_AFTER_MIN`, 0 = off |
| `stuck` | an execution has sat in `running` past the budget | `ALERT_STUCK_AFTER_MIN`, 0 = off |
| `unreachable` | a poll could not reach n8n at all | always on with `ALERTS_ENABLED=true` |

The first three are derived from data fetched *out of* n8n, so when n8n itself
is down, hung or rejecting the API key there is nothing to evaluate and all
three go quiet on exactly the outage that matters most. `unreachable` covers
that gap: the collector raises it from the failure path, before any workflow
data exists. It dedupes like every other rule, so a two-day outage is one
message plus a "recovered" — not one per `POLL_INTERVAL`.

A failed poll knows nothing about workflows, so it deliberately does **not**
touch their alert state. Open `failing`/`stale`/`stuck` alerts are carried
through the outage untouched rather than being announced as recovered and then
re-announced when n8n returns.

Staleness is measured from the last **success**, not the last run — a workflow
failing every five minutes has a very fresh last-run time, and that is exactly
the workflow a run-based check would never flag. A workflow activated more
recently than its own budget is given the full budget before it can fire.

An alert that stops being true emits a `success` "recovered" entry.

**Outbound push.** Set `ALERT_WEBHOOK_URL` and the same alerts are also POSTed
there, batched into one message per poll (a broad outage produces a dozen alerts
at once, and a dozen separate pings is how a channel gets muted). Long bursts
truncate with a count. `ALERT_WEBHOOK_FORMAT` picks the body shape:

| format | body | for |
|--------|------|-----|
| `slack` | `{text}` | Slack incoming webhooks, Mattermost |
| `discord` | `{content}` | Discord channel webhooks |
| `telegram` | `{chat_id, text}` | Telegram bot API; needs `ALERT_TELEGRAM_CHAT_ID` |
| `raw` | `{text, alerts:[…]}` | anything else — an n8n webhook, most usefully |

The webhook URL is a **credential** for Slack and Telegram, which carry their
secret in the path. The collector never logs it beyond scheme and host, never
writes it into a feed, and scrubs it out of transport errors before logging
them. A failing or hung webhook is reported and the poll continues —
`ALERT_WEBHOOK_TIMEOUT_MS` (default 10000) bounds how long it can delay one.

There is no SMTP client, deliberately: it would mean a mail dependency,
credentials on disk and bounce handling. For email, point `raw` at an n8n
webhook and let n8n send it.

**Dead-man switch.** Everything above runs *inside* the collector, so none of it
survives the machine dying — a dead process cannot send a message. Detecting
that requires inverting the direction: set `ALERT_HEARTBEAT_URL` and the
collector GETs it after every **successful** poll, and something off-box alerts
when the pings stop. A plain GET is what Healthchecks.io, Uptime Kuma push
monitors and Better Stack heartbeats all accept.

It is deliberately not gated on `ALERTS_ENABLED` — "is po11y alive at all" and
"is a workflow misbehaving" are different questions and either is useful without
the other. The URL is a credential for the same reason the webhook URL is (the
monitor id sits in the path, and anyone holding it can forge a healthy ping and
mute the switch), so it gets identical handling: scheme + host in logs, never in
a feed, scrubbed out of transport errors. A ping that fails is logged and
otherwise ignored, and never counts against `/healthz` —
`ALERT_HEARTBEAT_TIMEOUT_MS` (default 10000) bounds how long it can delay a
poll that has already succeeded.

## Prometheus metrics

The Mode B collector serves the Prometheus text exposition at
`collector:8081/metrics`, on the same port as `/healthz`. Port 8081 has no
`ports:` mapping — it is reachable from the compose network only, which is where
Prometheus scrapes it from. The exported series carry workflow ids, names and
timestamps: a strict subset of what `map.json` already publishes. No
configuration, no API key, no execution payloads.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `po11y_n8n_up` | gauge | — | `1` if the last poll reached the n8n API, else `0`. |
| `po11y_poll_last_success_timestamp_seconds` | gauge | — | Unix time of the last successful poll. Absent until the first one succeeds. |
| `po11y_workflow_errors_total` | counter | `workflow_id`, `workflow_name` | Failed executions observed since collector start. "Failed" is `error` **or** `crashed`, matching the Grafana dashboards; `canceled` is not a failure. |
| `po11y_workflow_last_success_timestamp_seconds` | gauge | `workflow_id`, `workflow_name` | Unix time of the workflow's last success. **Absent** for a workflow that has never succeeded. |
| `po11y_workflow_running_seconds` | gauge | `workflow_id`, `workflow_name` | Age of the oldest currently-running execution; `0` if none. |

Two behaviours worth knowing before you write rules against these:

- **`po11y_workflow_errors_total` is accumulated, not the window count.** The
  collector reads `/api/v1/executions?limit=100`, a sliding window whose error
  count goes down as it moves. Exporting that directly would make `increase()`
  read every slide as a counter reset. The counter resets to zero when the
  collector restarts, which is a genuine counter reset and handled natively.
- **A workflow that has never succeeded exports no `last_success` series.**
  Zero-filling would mean 1970, so every staleness rule would fire instantly on
  workflows that simply have not run yet. Use `Po11yWorkflowFailing` for that
  case, or `absent()` if you want to alert on it explicitly.

During an n8n outage the collector keeps serving the last-known per-workflow
series and only flips `po11y_n8n_up` to `0`. Clearing them would restart every
Prometheus `for:` duration and turn one outage into a burst of flapping alerts on
recovery. The cost is that an outage also trips the staleness and stuck rules —
which is what the shipped Alertmanager inhibit rule exists to collapse.

## Alerting: which of the three paths to use

| Path | Enable with | Best when |
|---|---|---|
| `notifications.json` feed only | `ALERTS_ENABLED=true` | You read the dashboard and want no outbound traffic. |
| Collector push | `ALERTS_ENABLED=true` + `ALERT_WEBHOOK_URL` | You want Slack/Discord/Telegram with nothing else to run. |
| Prometheus + Alertmanager | the `docker-compose.alerts.yml` overlay | You already run Prometheus, or you want silences, grouping, inhibition and on-call routing. |

These are alternatives. Turning on more than one delivers every alert more than
once. The overlay path does not need `ALERTS_ENABLED` at all — the metrics
publish either way.

```bash
docker compose -f docker-compose.readonly.yml -f docker-compose.alerts.yml up -d
```

Alertmanager's UI is at `http://127.0.0.1:9093` (or your `BIND_ADDR`). Rules live
in `observability/alerts.yml`; the thresholds match the watchdog defaults and are
meant to be edited.

## `alert-state.json` (Mode B, watchdog only — not web-served)

```json
{ "<rule>:<workflowId>": { "firstSeen": "…", "lastNotified": "…", "workflowName": "…" } }
```

The `unreachable` rule is instance-wide rather than per-workflow, so its key has
an empty id (`unreachable:`) and its notification carries no `link` — a
`/workflow/…` href would render as a live button that 404s.

Bookkeeping so an alert that is still true isn't re-announced every poll;
`ALERT_RENOTIFY_MIN` sets the repeat interval (0 = say it once). It lives in the
feed directory because that is the collector's only writable mount under a
read-only rootfs — but unlike the five feeds above it is **not** web-served:
[`nginx.conf`](../nginx.conf) aliases `status`, `notifications`, `map`,
`ai-map` and `forms` by name, and the scoped `/status/<scope>/<feed>` regex
enumerates the same five. It is collector-internal state, not a feed. Delete it
(inside the volume) to force every open alert to re-announce.

## `/map.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "mermaid": "graph TD\n …", "workflows": 4 }
```

Rendered by the bundled [`site/map.html`](../site/map.html) tab (mermaid is
bundled too, no CDN).

## `/forms.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "forms": [{ "name": "…", "sub": "…", "path": "…", "fields": 0 }] }
```

Live inventory of every active workflow's form triggers. The dashboard merges
it into the "Actions" card group (config-declared cards win), so a new form
trigger becomes a dashboard button within one Maps tick. Field-less forms
(`fields: 0`) fire in place — a `fetch` POST through the same-origin `/form/`
nginx proxy with a toast for the result; forms with inputs open n8n's own form
page.

## `/ai-map.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "model": "…", "eyebrow": "…", "title": "…", "lede": "…",
  "columns": ["Triggers", "…"], "kinds": {"sched": "neutral"},
  "nodes": [{ "id": "…", "col": 0, "kind": "sched", "tag": "…", "name": "…", "sub": "…" }],
  "edges": [["fromId", "toId", "sched"]],
  "legend": [["label", "sched"]], "notes": [{ "title": "…", "text": "…" }],
  "sigs": { "<node id>": "…" } }
```

Structure is computed deterministically from the live workflow export; an LLM
(optional, see [ai-map.md](ai-map.md)) only writes the prose. `sigs` are
per-node content signatures the Maps workflow uses to re-annotate only changed
nodes. Rendered by [`site/ai-map.html`](../site/ai-map.html).

## `/prom/*` and `/grafana/*` (optional)

`metrics.stats` needs the two read-only Prometheus query endpoints proxied
under `promBase`; Grafana embeds need Grafana served under
`metrics.grafana.base` in subpath mode with anonymous viewing and embedding
enabled (the default here; set `DASHBOARD_GRAFANA_EMBED=false` in `.env` to
turn that off). The bundled [`nginx.conf`](../nginx.conf) has both blocks
ready.

## n8n DataTable read proxy (optional)

The `/n8n-table/` location proxies `GET` requests to n8n's public API and adds
a read-scoped `X-N8N-API-KEY` server-side, so a `list` tab (see
[`site/list.html`](../site/list.html)) can read a Data Table live without the
browser ever holding a key. It's GET-only (`limit_except GET { deny all; }`)
and the key is injected by the `dashboard` service entrypoint in
`docker-compose.yml` — the committed `nginx.conf` only carries the
`${N8N_READ_API_KEY}` reference.

One-time setup:

1. In n8n → **Settings → n8n API**, create an API key. Scope it to
   **data-table row: read** only.
2. Put it in `.env` as `N8N_READ_API_KEY` (`.env` is gitignored).
3. Point a `list` tab's `endpoint` at
   `/n8n-table/data-tables/<dataTableId>/rows?sortBy=id:desc` (confirm
   the exact rows path/params against your n8n version's API docs at
   `/api/v1/docs` — the DataTable API is young and has moved between minors).

**Sort on a unique column.** n8n's cursor is an encoded `{limit, offset}`, so
paging past the first 250 rows re-runs the query per page. If the sort column
has ties — a `firstSeen` timestamp shared by a batch of rows inserted together —
their relative order is not stable between requests, and an offset walk serves
some rows twice while never returning others. Measured on a 657-row table sorted
by a tied timestamp: 34 duplicates fetched, 34 distinct rows never seen. Sorting
by `id` (unique, and ascending with insertion, so still newest-first for an
append-only feed) makes the walk exact. The tab dedupes by `id` regardless, but
dedupe cannot recover a row the API never sent.

A `tabs[]` entry wiring a `list` tab to a Data Table (the table id is in the
Data Table's URL in the n8n UI):

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
      "meta": ["customer", "region", "units", "status", "note"],
      "detail": "detail"
    }
  }
}
```

## Instance pages (`tabs`)

A tab page is any HTML you serve under `/site/`. Copy the design tokens from
[`html/style.css`](../html/style.css) if you want it to match. The iframe gets
`class="tabframe"` sizing from the shell; pages load lazily on first open.

The shell's theme toggle writes localStorage `po11y-theme` (`light` | `dark`;
key absent = follow the OS) and sets `html[data-theme]`. A page that copies
the tokens should mirror the bundled ones: apply the key before first paint,
guard its dark `@media` block with `:root:not([data-theme=light])`, add an
equivalent `:root[data-theme=dark]` block, and reload on the `storage` event
so a toggle in the shell restyles already-open iframes.

### `list` tab

A generic tab (`/site/list.html`) that renders any row feed as day-grouped,
sortable cards. Add a `tabs[]` entry with a `list` block:

- `endpoint` — URL the tab fetches. A relative `/n8n-table/…` proxy path for
  live n8n Data Table reads, or any static JSON (`{items:[…]}`, `[…]`, or
  `{data:[…]}`). The browser fetches whichever you name. The [MCP](mcp.md)
  content tools (`po11y_rows`, `po11y_row`) serve only the `/n8n-table/…` form
  — that is the one that rewrites onto the n8n API, and the only request the
  read-scoped key may ride on; a dataset on any other endpoint answers with a
  structured `unsupported endpoint` instead.
- `mapping` — source-column → card-field map: `title`, `url`, `score`, `day`
  (ISO string, bucketed by date), and `meta` (list of extra columns shown as a
  detail line).
- `badge` (optional) — a source column rendered as a small pill beside the card
  title. Intended for provenance when a feed merges several upstreams (which job
  board an ad came from, which cluster a run belongs to). It is deliberately not
  part of `meta`: the meta line is a run-on `key: value · key: value` string, so
  a value buried there stops being scannable once a few columns are mapped. An
  empty or unmapped value renders nothing.
- `detail` (optional) — a source column holding a JSON array (or already-parsed
  array) of `{ aspect, kind: "fit"|"gap", assessment }` rows. When present and
  non-empty the card becomes expandable: the title still links out, and a
  `▸ fit / gap analysis` toggle reveals the rows as a table. A gap whose
  `assessment` begins with `real` / `debatable` is styled accordingly. Omit it
  (or leave the column empty per row) and the card behaves exactly as before.
- `defaultSort` — `"day"` (newest, grouped) or `"score"` (best-fit first).
- `defaultRange` (optional) — which of the tab's `Range:` buttons is active on
  load: `"all"`, `"today"`, `"7d"` or `"30d"`. The windows roll from the
  browser's local date and include today, so `"7d"` is today plus the six
  preceding days — a rolling window rather than a calendar week, which would
  show a single day every Monday. Range and sort are independent: narrow to a
  window, then flip Newest / Best fit inside it. Rows whose mapped `day` column
  is missing or unparseable appear only under `All`. Omitted ⇒ `"all"`, the
  pre-existing behaviour.

  Filtering happens in the browser, over a feed that arrives newest-first. n8n
  caps a page at 250 rows, so covering a window means walking pages by
  `nextCursor`: the tab keeps pulling until the feed ends, until a row older
  than the window proves it has passed the edge, or until its page budget (8
  pages, or 1 for `All`) runs out — only that last case offers `load more`.
  Sorting is a client-side reshuffle of rows already in hand and never re-walks
  the feed.
- `pageSize` (optional) — rows per request, default `250` (n8n's ceiling;
  requesting more is a 400). Static JSON feeds ignore it and return everything.

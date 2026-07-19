# Configuration and feed contracts

The dashboard reads one config file and a handful of small JSON feeds from the
shared status volume. This page is the contract for each.

## `/config.json`

See [`config.example.json`](../config.example.json). Everything is optional;
omitted pieces don't render.

| key | what |
|-----|------|
| `title`, `eyebrow`, `lede`, `footer` | branding; `footer` is `[{text, href?}]` |
| `cards` | `{ "Group heading": [{name, sub, href}] }`, ordered groups of link cards |
| `tabs` | `[{id, label, src}]`, iframe tabs; serve `src` yourself (e.g. under `/site/`) |
| `sections` | which status sections render, and their headings: `{containers, executions, notifications}` |
| `metrics` | `{heading, grafana: {embed, base, dashboard, panels: [{id, wide?}], range}, promBase, stats: [{label, up, mem?}]}` |
| `refreshSec` | poll interval for status + notifications (default 30) |
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
   `/n8n-table/data-tables/<dataTableId>/rows?sort=firstSeen:desc` (confirm
   the exact rows path/params against your n8n version's API docs at
   `/api/v1/docs` — the DataTable API is young and has moved between minors).

A `tabs[]` entry wiring a `list` tab to a Data Table (the table id is in the
Data Table's URL in the n8n UI):

```json
{
  "id": "orders",
  "label": "Orders",
  "src": "/site/list.html",
  "list": {
    "title": "Orders",
    "endpoint": "/n8n-table/data-tables/REPLACE_WITH_TABLE_ID/rows?sort=firstSeen:desc",
    "defaultSort": "day",
    "mapping": {
      "title": "title",
      "url": "url",
      "score": "score",
      "day": "firstSeen",
      "meta": ["customer", "region", "units", "status", "note"]
    }
  }
}
```

## Instance pages (`tabs`)

A tab page is any HTML you serve under `/site/`. Copy the design tokens from
[`html/style.css`](../html/style.css) if you want it to match. The iframe gets
`class="tabframe"` sizing from the shell; pages load lazily on first open.

### `list` tab

A generic tab (`/site/list.html`) that renders any row feed as day-grouped,
sortable cards. Add a `tabs[]` entry with a `list` block:

- `endpoint` — URL the tab fetches. A relative `/n8n-table/…` proxy path for
  live n8n Data Table reads, or any static JSON (`{items:[…]}`, `[…]`, or
  `{data:[…]}`).
- `mapping` — source-column → card-field map: `title`, `url`, `score`, `day`
  (ISO string, bucketed by date), and `meta` (list of extra columns shown as a
  detail line).
- `defaultSort` — `"day"` (newest, grouped) or `"score"` (best-fit first).

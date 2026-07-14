# Po11y

A tiny, no-build status dashboard for self-hosted stacks. One nginx container,
three static files, everything instance-specific in one `config.json`.

Built as the front door of an [n8n](https://n8n.io) automation stack: n8n
workflows publish `status.json` and `notifications.json` to a shared volume,
Po11y renders them — next to link cards, Grafana embeds / Prometheus stats,
and your own iframe tab pages. The contracts are just two JSON files, so any
publisher works; n8n is simply the canonical one.

## What you get

- **Overview tab**: named groups of link cards (actions, monitoring, …),
  live sections fed by `status.json` (running containers, open MRs), a
  notification feed, and grafana embeds or prometheus stat cards.
- **Workflow map tab**: auto-generated mermaid graph of every workflow on
  the n8n instance and how they link (triggers, sub-workflow calls,
  webhook/form calls) — no hand-maintained architecture diagram.
- **Architecture tab (optional, LLM-authored)**: an interactive column map
  — hover a box to trace its wiring — authored daily by an LLM that reads
  the live workflow export and infers the semantic flow (triggers → entry
  workflows → workers → outputs) plus operational-insight cards. Bring any
  OpenAI-compatible endpoint via `AI_MAP_*` in `.env`, or — no API key —
  run `./ai-map-cli.sh` to build it through a local AI CLI (`claude -p` by
  default; override with `AI_MAP_CLI`). Skipped when neither is used.
- **Extra tabs**: each config entry becomes an iframe onto a page you serve
  under `/site/` — bring your own registry table, docs, anything.
- **Staleness badge**: flips on when `status.json` is older than
  `staleAfterMin` minutes.
- No build step, no external dependencies (mermaid is vendored), dark/light
  via `prefers-color-scheme`.

## Quickstart (standalone)

```sh
git clone https://gitlab.com/labrise/po11y && cd po11y
./bootstrap.sh                # full stack: n8n + postgres + prometheus + grafana + dashboard
./bootstrap.sh --no-examples  # skip the demo feeds (HN news)
```

Dashboard on `http://127.0.0.1:8080`, n8n editor on `:5678` — the owner
account is created for you, credentials land in `.env`. Set `BIND_ADDR` in
`.env` to a private VPN/LAN IP to reach it from other devices (never
0.0.0.0). Out of the box: running-containers section (status publisher),
the auto-generated workflow map (Map tab), n8n execution analytics + system
health dashboards in Grafana, and — unless `--no-examples` — a notifications
feed of Hacker News top stories demonstrating the contract.

### Importing your workflows

Any repo or directory of standard n8n workflow exports (one JSON per
workflow — what the UI and `n8n export:workflow --separate` produce):

```sh
./bootstrap.sh --pack https://gitlab.com/you/your-workflows
./bootstrap.sh --pack ./my-local-dir
```

Import packs on the FIRST bootstrap run when possible: n8n's CLI import
does not assign ownership on an already-claimed instance — such workflows
run but stay invisible in the UI (re-import them there instead).

## Quickstart (vendored into an existing stack)

```yaml
# docker-compose.yml
dashboard:
  image: nginx:1.27-alpine
  ports: ["8080:80"]
  volumes:
    - ./vendor/po11y/html:/usr/share/nginx/html:ro
    - ./vendor/po11y/nginx.conf:/etc/nginx/conf.d/default.conf:ro  # or your copy
    - ./dashboard/site:/usr/share/nginx/site:ro                    # your tab pages
    - ./dashboard/config.json:/run/po11y/config.json:ro            # your config
    - status-volume:/po11y-status:ro                               # your publisher writes here
```

Vendor Po11y as a git submodule (pin a commit, update deliberately):

```sh
git submodule add https://gitlab.com/labrise/po11y vendor/po11y
```

### Feeding it from n8n

The dashboard only reads files — n8n writes them. Two prerequisites on the
n8n service, then one small scheduled workflow.

**Existing n8n**: mount the shared volume and allow the `fs` builtin in Code
nodes, then restart:

```yaml
n8n:
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - status-volume:/po11y-status
```

**New n8n**: add the service next to the dashboard in the same compose file:

```yaml
n8n:
  image: n8nio/n8n:latest
  ports: ["5678:5678"]
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - n8n_data:/home/node/.n8n
    - status-volume:/po11y-status
```

Either way, create a workflow — Schedule Trigger (every 1–2 min) into a Code
node that gathers whatever you want on the dashboard and writes the status
contract atomically (tmp + rename, so nginx never serves a torn file):

```js
const fs = require('fs');
const status = {
  generated_at: new Date().toISOString(),
  // fill from earlier nodes: docker ps output, API calls, queue depths, …
  containers: [],
  mrs: [],
};
fs.writeFileSync('/po11y-status/status.json.tmp', JSON.stringify(status));
fs.renameSync('/po11y-status/status.json.tmp', '/po11y-status/status.json');
return [{ json: { published: true } }];
```

A second workflow (or the same one) can append to `notifications.json` the
same way. Handy first card in `config.json` — the n8n editor itself:
`{"name": "n8n", "sub": "workflow editor", "href": "http://{host}:5678/"}`.

Instead of writing a publisher from scratch, you can import
[`workflows/core/*.json`](workflows/core) (status publisher + workflow map)
into the host stack's n8n directly — mount your status volume at
`/po11y-status` in that n8n and it matches their write paths.

## Contracts

### `/config.json`

See [`config.example.json`](config.example.json). Everything is optional;
omitted pieces don't render.

| key | what |
|-----|------|
| `title`, `eyebrow`, `lede`, `footer` | branding; `footer` is `[{text, href?}]` |
| `cards` | `{ "Group heading": [{name, sub, href}] }` — ordered groups of link cards |
| `tabs` | `[{id, label, src}]` — iframe tabs; serve `src` yourself (e.g. under `/site/`) |
| `sections` | which status sections render, and their headings: `{containers, mrs, notifications}` |
| `metrics` | `{heading, grafana: {embed, base, dashboard, panels: [{id, wide?}], range}, promBase, stats: [{label, up, mem?}]}` |
| `refreshSec` | poll interval for status + notifications (default 30) |
| `staleAfterMin` | staleness threshold (default 5) |
| `statusHint` | text shown while `status.json` is missing |

`{host}` inside any `href`/`src` is replaced with the browser's hostname —
one config works from every device that can reach the box.

### `/status.json` (your publisher writes this)

```json
{
  "generated_at": "2026-07-10T12:00:00Z",
  "containers": [ { "name": "…", "status": "Up 2 hours", "image": "…" } ],
  "mrs": [ { "project": "…", "iid": 7, "title": "…", "web_url": "…",
             "labels": ["…"], "draft": false, "updated_at": "…" } ]
}
```

Write it atomically (tmp file + rename on the same volume). Sections you
don't enable in `config.json` can simply be absent.

### `/notifications.json` (optional)

Newest first; the feed shows the first 20.

```json
[ { "ts": "…", "title": "…", "message": "…", "status": "success|failure|info",
    "link": "https://…" } ]
```

### `/map.json` (written by the maps core workflow)

```json
{ "generated_at": "…", "mermaid": "graph TD\n …", "workflows": 4 }
```

Rendered by the bundled [`site/map.html`](site/map.html) tab (vendored
mermaid, no CDN).

### `/forms.json` (written by the maps core workflow)

```json
{ "generated_at": "…", "forms": [{ "name": "…", "sub": "…", "path": "…" }] }
```

Live inventory of every active workflow's form triggers. The dashboard
merges it into the "Actions" card group (config-declared cards win), so a
new form trigger becomes a dashboard button within one maps tick — no
config.json edit.

### `/ai-map.json` (written by the maps core workflow, optional)

```json
{ "generated_at": "…", "model": "…", "eyebrow": "…", "title": "…", "lede": "…",
  "columns": ["Triggers", "…"], "kinds": {"sched": "neutral"},
  "nodes": [{ "id": "…", "col": 0, "kind": "sched", "tag": "…", "name": "…", "sub": "…" }],
  "edges": [["fromId", "toId", "sched"]],
  "legend": [["label", "sched"]], "notes": [{ "title": "…", "text": "…" }] }
```

Structure (columns, nodes, edges) is computed deterministically from the live
workflow export; an LLM only writes the prose (per-node one-liners, lede,
insight cards) — either in the maps workflow (any OpenAI-compatible endpoint,
`AI_MAP_*` in `.env`) or via the host-side [`ai-map-cli.sh`](ai-map-cli.sh)
annotator (local AI CLI, `claude -p` by default). Without either, the map
still publishes with heuristic text. Rendered by
[`site/ai-map.html`](site/ai-map.html).

### `/prom/*` and `/grafana/*` (optional)

`metrics.stats` needs the two read-only prometheus query endpoints proxied
under `promBase`; grafana embeds need grafana served under `metrics.grafana.base`
in subpath mode with anonymous viewing + embedding enabled. The bundled
[`nginx.conf`](nginx.conf) has both blocks ready to uncomment.

## Instance pages (`tabs`)

A tab page is any HTML you serve under `/site/`. Copy the design tokens from
[`html/style.css`](html/style.css) if you want it to match. The iframe gets
`class="tabframe"` sizing from the shell; pages load lazily on first open.

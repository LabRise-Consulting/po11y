# Po11y

Po11y is a status dashboard and observability stack for 
[n8n](https://n8n.io), the self-hostable workflow automation tool. 
Once your n8n workflows are live, Po11y answers the critical question: 
"What is running right now, and how does it all fit together?"

The dashboard is boring technology: one nginx container, three static files, no build step.
Grafana provides detailed metrics and insights.

Start everything with one `./bootstrap.sh`: n8n, Postgres, Prometheus, Grafana.
Instance-specific config lives in `config.json`, and all live data comes as 
small JSON files that n8n workflows write to a shared volume. Any publisher works; n8n is included.

## What you get

<video src="https://gitlab.com/labrise/po11y/-/raw/main/docs/intro.mp4" controls width="100%">
  <a href="docs/intro.mp4">Watch the 16 second intro video</a>.
</video>

The **Overview** tab: action buttons (each active form trigger in n8n becomes a
button automatically), monitoring links, running containers, a notification
feed and Grafana panels.

![Dashboard overview](docs/img/dashboard.png)

The **Architecture** tab: an interactive map of your workflows, rebuilt from the
live n8n instance every 10 minutes. Hover a box to trace its wiring. The
structure (columns, boxes, edges) is computed deterministically from the
workflow export; an LLM only writes the one-line descriptions and insight
cards, and plain heuristic text is used when no LLM is configured.

![Architecture map](docs/img/architecture.png)

**Grafana**, prewired with four dashboards: n8n execution analytics, system
health, and the official webhook/form execution dashboards from
[n8n-io/n8n-observability](https://github.com/n8n-io/n8n-observability):

![Grafana execution analytics](docs/img/grafana.png)

Plus a simpler auto-generated **Map** tab (mermaid graph of workflows and their
triggers), a staleness badge when the status feed stops updating, dark/light
theme following your system, and extra tabs for any pages you want to serve.

## Quickstart

```sh
git clone https://gitlab.com/labrise/po11y && cd po11y
./bootstrap.sh                # full stack: n8n + postgres + prometheus + grafana + dashboard
./bootstrap.sh --no-examples  # skip the Hacker News demo workflows
```

Then open:

- Dashboard: `http://127.0.0.1:8080`
- n8n editor: `http://127.0.0.1:5678` (an owner account is created for you;
  the credentials are written into `.env`)

Everything binds to `127.0.0.1` by default, so it is only reachable from
your machine. To reach it from other devices, set `BIND_ADDR` in `.env` to a
private VPN or LAN IP.

Out of the box you get the running-containers section, the two generated
maps, Grafana dashboards, and (unless `--no-examples`) a notification feed
of Hacker News top stories that demonstrates the whole pipeline end to end.

### The included workflows

Bootstrap imports and activates a few n8n workflows. They are normal
workflows; open them in the editor to see how they work.

| workflow | what it does |
|----------|--------------|
| Po11y - Status publish | every 2 min, lists Docker containers and writes `status.json` |
| Po11y - Maps | every 10 min, exports all workflows and rebuilds the Map, Architecture and Actions feeds; the "Build maps now" form rebuilds them on demand |
| Po11y example - HN tech news | every 30 min (or the "Fetch HN now" form), fetches Hacker News top stories |
| Po11y example - HN notify | called by HN tech news as a sub-workflow; deduplicates and writes `notifications.json` |

The two HN workflows are the template to copy for your own feeds: an entry
workflow fetches data, a sub-workflow owns the file it publishes.

### Importing your own workflows

Any repo or directory of standard n8n workflow exports works (one JSON file
per workflow, which is what the n8n UI and `n8n export:workflow --separate`
produce):

```sh
./bootstrap.sh --pack https://gitlab.com/you/your-workflows
./bootstrap.sh --pack ./my-local-dir
```

n8n's command line import does not assign ownership on an instance that already has an owner,
and such workflows run but stay invisible in the editor's list. If that
happens, re-import them through the editor UI instead.

## The AI architecture map

The Architecture tab always renders: its structure comes from code, not from
a model. An LLM is optional and improves the text. Two ways to enable
that:

1. **API endpoint**: set `AI_MAP_BASE_URL`, `AI_MAP_API_KEY` and
   `AI_MAP_MODEL` in `.env` (any OpenAI-compatible chat endpoint works:
   Mistral, OpenAI, Anthropic, a local Ollama), then `docker compose up -d
   n8n`. The Maps workflow refreshes the text daily, or immediately via the
   "Build maps now" button.
2. **Local AI CLI, no API key**: run `./ai-map-cli.sh` on the host. It pipes
   the map through a local CLI (`claude -p` by default; set `AI_MAP_CLI` to
   use `llm`, `ollama run <model>`, or anything that reads a prompt on stdin
   and prints the answer).

**Cost is near zero.** The map's structure is free (built from code). The LLM
is only called when the workflow structure actually changed — an unchanged,
fresh map skips the call entirely — so a stable stack makes essentially no
requests. A cheap model (e.g. `mistral-small-latest`) is plenty, and the
keyless heuristic and local-Ollama paths cost nothing at all.

## Security posture

Po11y runs on a single box bound to `127.0.0.1`. The parts that matter:

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
- **Execute Command** stays enabled for one job (`n8n export:workflow`, used by
  the Maps workflow). With the host socket gone it is confined to the n8n
  container.
- Everything binds to `127.0.0.1`, so plain HTTP is acceptable. Put it behind a
  TLS reverse proxy before exposing it beyond the box.

Residual, and inherent to n8n: anyone who can add or edit workflows can run
JavaScript in a Code node. Treat editor access as trusted.

## Using Po11y inside an existing stack

The dashboard is just static files plus a config, so you can mount it into a
compose stack you already have:

```yaml
# docker-compose.yml
dashboard:
  image: nginx:1.27-alpine
  ports: ["8080:80"]
  volumes:
    - ./external/po11y/html:/usr/share/nginx/html:ro
    - ./external/po11y/nginx.conf:/etc/nginx/conf.d/default.conf:ro  # or your copy
    - ./dashboard/site:/usr/share/nginx/site:ro                      # your tab pages
    - ./dashboard/config.json:/run/po11y/config.json:ro              # your config
    - status-volume:/po11y-status:ro                                 # your publisher writes here
```

Pin Po11y as a git submodule so updates are deliberate:

```sh
git submodule add https://gitlab.com/labrise/po11y external/po11y
```

### Feeding it from n8n

The dashboard only reads files; n8n writes them. Two prerequisites on the
n8n service, then one small scheduled workflow.

Existing n8n: mount the shared volume and allow the `fs` builtin in Code
nodes, then restart:

```yaml
n8n:
  environment:
    - NODE_FUNCTION_ALLOW_BUILTIN=fs
  volumes:
    - status-volume:/po11y-status
```

New n8n: add the service next to the dashboard in the same compose file:

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

Either way, create a workflow: a Schedule Trigger (every 1 to 2 minutes)
into a Code node that gathers whatever you want on the dashboard and writes
the status contract atomically (write a tmp file, then rename, so nginx
never serves a half-written file):

```js
const fs = require('fs');
const status = {
  generated_at: new Date().toISOString(),
  // fill from earlier nodes: docker ps output, API calls, queue depths, ...
  containers: [],
  mrs: [],
};
fs.writeFileSync('/po11y-status/status.json.tmp', JSON.stringify(status));
fs.renameSync('/po11y-status/status.json.tmp', '/po11y-status/status.json');
return [{ json: { published: true } }];
```

A second workflow (or the same one) can append to `notifications.json` the
same way. A first card for `config.json` is the n8n editor itself:
`{"name": "n8n", "sub": "workflow editor", "href": "http://{host}:5678/"}`.

Instead of writing a publisher from scratch, you can also import
[`workflows/core/*.json`](workflows/core) (status publisher and maps) into
your existing n8n directly. Mount your status volume at `/po11y-status` in
that n8n and the write paths match.

## Contracts

### `/config.json`

See [`config.example.json`](config.example.json). Everything is optional;
omitted pieces don't render.

| key | what |
|-----|------|
| `title`, `eyebrow`, `lede`, `footer` | branding; `footer` is `[{text, href?}]` |
| `cards` | `{ "Group heading": [{name, sub, href}] }`, ordered groups of link cards |
| `tabs` | `[{id, label, src}]`, iframe tabs; serve `src` yourself (e.g. under `/site/`) |
| `sections` | which status sections render, and their headings: `{containers, mrs, notifications}` |
| `metrics` | `{heading, grafana: {embed, base, dashboard, panels: [{id, wide?}], range}, promBase, stats: [{label, up, mem?}]}` |
| `refreshSec` | poll interval for status + notifications (default 30) |
| `staleAfterMin` | staleness threshold (default 5) |
| `statusHint` | text shown while `status.json` is missing |

`{host}` inside any `href`/`src` is replaced with the browser's hostname, so
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

Write it atomically (tmp file plus rename on the same volume). Sections you
don't enable in `config.json` can simply be absent.

### `/notifications.json` (optional)

Newest first. The dashboard shows the newest 5 with a "show all" toggle.

```json
[ { "ts": "…", "title": "…", "message": "…", "status": "success|failure|info",
    "link": "https://…" } ]
```

### `/map.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "mermaid": "graph TD\n …", "workflows": 4 }
```

Rendered by the bundled [`site/map.html`](site/map.html) tab (mermaid is
bundled too, no CDN).

### `/forms.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "forms": [{ "name": "…", "sub": "…", "path": "…" }] }
```

Live inventory of every active workflow's form triggers. The dashboard
merges it into the "Actions" card group (config-declared cards win), so a
new form trigger becomes a dashboard button within one Maps tick, without
touching config.json.

### `/ai-map.json` (written by the Maps workflow)

```json
{ "generated_at": "…", "model": "…", "eyebrow": "…", "title": "…", "lede": "…",
  "columns": ["Triggers", "…"], "kinds": {"sched": "neutral"},
  "nodes": [{ "id": "…", "col": 0, "kind": "sched", "tag": "…", "name": "…", "sub": "…" }],
  "edges": [["fromId", "toId", "sched"]],
  "legend": [["label", "sched"]], "notes": [{ "title": "…", "text": "…" }] }
```

Structure is computed deterministically from the live workflow export; an
LLM (optional, see above) only writes the prose. Rendered by
[`site/ai-map.html`](site/ai-map.html).

### `/prom/*` and `/grafana/*` (optional)

`metrics.stats` needs the two read-only Prometheus query endpoints proxied
under `promBase`; Grafana embeds need Grafana served under
`metrics.grafana.base` in subpath mode with anonymous viewing and embedding
enabled (the default here; set `DASHBOARD_GRAFANA_EMBED=false` in `.env` to
turn that off). The bundled [`nginx.conf`](nginx.conf) has both blocks ready.

## Instance pages (`tabs`)

A tab page is any HTML you serve under `/site/`. Copy the design tokens from
[`html/style.css`](html/style.css) if you want it to match. The iframe gets
`class="tabframe"` sizing from the shell; pages load lazily on first open.

## Kubernetes and Podman

The compose stack is one deployment, not the product — the product is the file
contract (small JSON files on a shared volume) plus a static dashboard, which
is deployment-agnostic.

- **Podman**: the compose file runs under `podman-compose`. Point the
  `docker-proxy` sidecar at the Podman socket (it speaks the Docker API); or
  drop the proxy and the containers section is simply empty.
- **Kubernetes**: plain manifests live in [`deploy/k8s/`](deploy/k8s) — build
  and push the n8n image, create the static-file ConfigMaps, set the Secrets,
  then `kubectl apply -k deploy/k8s`. Generic clusters have no Docker socket, so
  the containers feed is empty there; everything else works. See
  [`deploy/k8s/README.md`](deploy/k8s/README.md).

## Tracing with OpenTelemetry (opt-in)

n8n emits OpenTelemetry traces for workflow and node executions natively (no
extra package). Enable it with the bundled override, which also starts a
Grafana Tempo backend so traces surface in the same Grafana as the metrics:

```sh
docker compose -f docker-compose.yml -f docker-compose.otel.yml up -d
```

It is opt-in on purpose: tracing is a newer n8n feature and heavier than the
built-in Prometheus metrics, so the default stack leaves it off. The metrics
dashboards need nothing extra.

**What tracing adds over the metrics.** The Prometheus dashboards are
aggregates (counts, rates, average durations). Traces are per-execution: a
single run split into spans (each node, sub-workflow call, outbound HTTP
request) with timing and parent/child. Use them to answer *why was this run
slow* or *which node failed in this execution* — the drill-down the aggregates
can't give.

**A dashboard for it.** Tempo's metrics-generator derives span metrics (and a
service graph) from the trace stream and remote-writes them to Prometheus, so
the override also ships an **n8n Execution Traces** Grafana dashboard:
per-workflow execution/error counts and per-node p95 latency, broken down by
n8n's own span attributes (`n8n_workflow_name`, `n8n_node_name`, ...). This is
node-level, unlike the workflow-level metrics dashboards.

**Deep links from the Po11y dashboard.** Grafana Explore takes a TraceQL query
in the URL, so you can wire one-click links like *recent errors*
(`{status=error}`), *slow runs* (`{duration>2s}`), or *all recent traces*
(`{}`). A ready-made card group is in
[`deploy/otel/config-cards.json`](deploy/otel/config-cards.json) — merge it into
your `config.json` `cards`. The Explore links need a Grafana login (Explore is
Editor-only; the anonymous Viewer can't open it); the Execution Traces
dashboard link works anonymously.

## How it compares

- **[n8n-io/n8n-observability](https://github.com/n8n-io/n8n-observability)**
  (official, MIT) — Prometheus + Grafana with Webhook/Form execution
  dashboards. Po11y builds on the same idea and adds the status page, the live
  container feed, the interactive workflow maps and the automatic form buttons.
  Its two dashboards are bundled here (Grafana ships four in total); the Form
  one populates immediately, the Webhook one once you run webhook workflows.
- **Workflow visualizers** (e.g. [n8nmermaid](https://github.com/jwa91/n8nmermaid))
  — turn exported JSON into diagrams for pull-request review. Po11y does it
  live from the running instance every 10 minutes.
- **n8n execution viewers** (e.g. n8nTrace) — push-based dashboards for
  execution history and errors, aimed at giving non-admins a safe debug view.
  Po11y is a system-health, documentation and action panel, not a per-execution
  log viewer.
- **DIY (Retool / Appsmith + the n8n REST API)** — maximum control, more to
  build and maintain. Po11y is the pre-packaged, one-command version.

## About

Po11y is built and maintained by **[Labrise Consulting](https://labrise-consulting.com)**.

Released under the [MIT License](LICENSE).

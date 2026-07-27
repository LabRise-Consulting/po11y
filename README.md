<img src="html/logo.svg" alt="Po11y" width="215">

Po11y is a status dashboard and observability stack for
[n8n](https://n8n.io), the self-hostable workflow automation tool.
Once your n8n workflows are live, Po11y answers the critical question:
"What is running right now, and how does it all fit together?"

The dashboard is boring technology: one nginx container, three static files,
no build step. Grafana provides detailed metrics. Instance-specific config
lives in `config.json`, and all live data arrives as small JSON files on a
shared volume, written by n8n workflows in Mode A and by the collector in
Mode B.

| | Mode A (bundled) | Mode B (collector) |
|---|---|---|
| n8n | installed & managed by Po11y | yours, untouched |
| setup | `./bootstrap.sh` | set 4 env vars, `docker compose -f docker-compose.readonly.yml up -d` |
| writes to n8n | yes | **never** (GET-only, test-enforced) |
| Docker socket | read-only proxy | none |
| Execute Command | enabled instance-wide | not needed |
| identity | one shared login (CE limit) | whatever your n8n has |
| for | one person, homelab | teams, existing deployments |

**Which mode?** Mode A is the fastest way to get the whole stack running on
your own box; no existing n8n required. Mode B adds Po11y read-only beside an
n8n you (or your team) already run. Identity is the deciding factor for teams:
n8n Community Edition has no sharing, projects, or RBAC: on free n8n, "team
Po11y" means everyone shares the one Owner login. Mode B exists so Po11y can
sit beside a paid or managed n8n and leave identity (logins, projects,
RBAC) to that n8n instead.

## What you get

▶ **[Watch the 63-second intro video](https://gitlab.com/labrise/po11y/uploads/9ccb990dbeec81b247148aae5d4738ff/intro.mp4)**
— hosted as a project upload rather than committed, so cloning the stack
doesn't drag 27 MB of video along with it. It covers both modes: the bundled
stack, the dashboard, map and Grafana tabs, then the read-only collector
running against a separate n8n.

The **Overview** tab: action buttons (each active form trigger in n8n becomes
a button automatically), monitoring links, running containers, a notification
feed and Grafana panels.

![Dashboard overview](docs/img/dashboard.png)

The **Architecture** tab: an interactive map of your workflows, rebuilt from
the live n8n instance every 10 minutes. The structure is computed
deterministically from the workflow export; an LLM (optional, see
[docs/ai-map.md](docs/ai-map.md)) only writes the one-line descriptions, with
heuristic text when none is configured.

![Architecture map](docs/img/architecture.png)

**Grafana**, prewired with four dashboards: n8n execution analytics, system
health, and the official webhook/form dashboards from
[n8n-io/n8n-observability](https://github.com/n8n-io/n8n-observability):

![Grafana execution analytics](docs/img/grafana.png)

Plus a simpler auto-generated **Map** tab, a staleness badge when the status
feed stops updating, dark/light theme, and extra tabs for any pages you want
to serve.

## Quickstart: Mode A (bundled)

```sh
git clone https://gitlab.com/labrise/po11y && cd po11y
./bootstrap.sh                # full stack: n8n + postgres + prometheus + grafana + dashboard
./bootstrap.sh --no-examples  # skip the Hacker News demo workflows
```

Then open:

- Dashboard: `http://127.0.0.1:8080`
- n8n editor: `http://127.0.0.1:5678` (a single owner account is created for
  you, the only account, see "Which mode?" above; credentials are written
  into `.env`)

Everything binds to `127.0.0.1` by default. To reach it from other devices,
set `BIND_ADDR` in `.env` to a private VPN or LAN IP (and set
`DASHBOARD_BASIC_AUTH`, see [docs/security.md](docs/security.md)).

Bootstrap imports and activates a few normal n8n workflows; open them in the
editor to see how they work:

| workflow | what it does |
|----------|--------------|
| Po11y - Status publish | every 2 min, lists Docker containers and writes `status.json` |
| Po11y - Maps | every 10 min, exports all workflows and rebuilds the Map, Architecture and Actions feeds |
| Po11y example - HN tech news | every 30 min, fetches Hacker News top stories |
| Po11y example - HN notify | sub-workflow; deduplicates and writes `notifications.json` |

The two HN workflows are the template to copy for your own feeds: an entry
workflow fetches data, a sub-workflow owns the file it publishes.

**Importing your own workflows.** Any repo or directory of standard n8n
workflow exports works (one JSON file per workflow):

```sh
./bootstrap.sh --pack https://gitlab.com/you/your-workflows
./bootstrap.sh --pack ./my-local-dir
```

n8n's command line import does not assign ownership on an instance that
already has an owner, and such workflows run but stay invisible in the
editor's list. If that happens, re-import them through the editor UI.

## Quickstart: Mode B (read-only collector)

Point Po11y at an n8n you already run without touching it. `collector/` polls
the remote n8n's public API and publishes the same four feeds that the Mode A
workflows write; the dashboard doesn't know or care which mode produced them.

**Prerequisites**

- An n8n API key scoped to `workflow:list`, `workflow:read`, `execution:list`
  and `execution:read` — the only four calls the collector makes. Recent n8n
  supports scoped keys on Community Edition too (verified on 2.29.8); if yours
  offers no scope picker, the key is full-access, so create it under a
  dedicated, low-privilege operator account instead.
- Optionally, set `N8N_METRICS=true` on the remote n8n so Prometheus has
  something to scrape. Without it the Grafana tab is simply empty.

**Env vars** (`.env`; see the "Mode B" block in [`.env.example`](.env.example)
for the full list with defaults):

| var | required | notes |
|-----|----------|-------|
| `N8N_API_URL` | yes | base URL of the remote n8n |
| `N8N_API_KEY` | yes | GET-only use, see prerequisites above |
| `N8N_METRICS_TARGET` | yes | `host:port` of the remote n8n's `/metrics` |
| `GRAFANA_ADMIN_PASSWORD` | yes | no `bootstrap.sh` here to generate one |
| `POLL_INTERVAL` | no | seconds between polls, default `600` |
| `STATUS_DIR` | no | feed directory, default `/po11y-status`; set `/po11y-status/<scope>` for a scoped collector ([docs/configuration.md](docs/configuration.md)) |
| `AI_MAP_BASE_URL` / `AI_MAP_API_KEY` / `AI_MAP_MODEL` | no | optional AI prose, empty = heuristic map |
| `ENABLE_FORM_PROXY` / `FORM_PROXY_UPSTREAM` | no | default `false` in this mode ([docs/security.md](docs/security.md)) |

**Quickstart**

```sh
git clone https://gitlab.com/labrise/po11y && cd po11y
cp .env.example .env             # fill in N8N_API_URL, N8N_API_KEY, N8N_METRICS_TARGET, GRAFANA_ADMIN_PASSWORD
cp config.readonly.example.json config.json   # Mode B config; without it docker creates a directory
docker compose -f docker-compose.readonly.yml up -d
```

Both files are required before the first `up`: there is no `bootstrap.sh` in
this mode to create them for you.

No `bootstrap.sh`, no owner account, no secrets on disk: everything the
collector needs comes from those env vars.

You get the same Map, Architecture and Actions feeds as Mode A, rebuilt every
`POLL_INTERVAL`, plus Grafana. `status.json` carries an execution summary
instead of a container list (there's no Docker socket); the Mode B example
config enables that `executions` section for you. Set `baseUrl` to the remote
n8n's host (a bare hostname, not a URL) so the `{host}` deep links resolve.

Mode B's Grafana is Prometheus-only, so the example config embeds the
**System health** dashboard. The execution-analytics dashboard is backed by
n8n's postgres database, which Mode B never connects to — its panels stay
empty here, which is why `config.example.json` (Mode A) is the wrong starting
point in this mode. What you don't
get: form buttons don't fire by default (`ENABLE_FORM_PROXY=false`, see
[docs/security.md](docs/security.md)), there is never a container list, and
the `/n8n-table/` list-tab proxy isn't wired up for a remote n8n yet.

## Going further

- [docs/security.md](docs/security.md): the security posture of both modes,
  the exposure interlock, and why read authorization is out of scope.
- [docs/forward-auth.md](docs/forward-auth.md): optional OIDC overlay
  (Keycloak/Authentik/Google/GitLab) replacing Basic Auth with real identity,
  and per-group authorization for form firing.
- [docs/configuration.md](docs/configuration.md): `config.json` reference,
  every feed contract, multi-team scopes, the DataTable read proxy, and
  custom tab pages.
- [docs/ai-map.md](docs/ai-map.md): enabling LLM prose on the architecture
  map, and why it costs near zero.
- [docs/integration.md](docs/integration.md): mounting the dashboard into an
  existing compose stack and feeding it from your own n8n.
- [docs/deployment.md](docs/deployment.md): Podman, Kubernetes,
  OpenTelemetry tracing, and how Po11y compares to alternatives.

## Contributing

Issues and merge requests welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has the
local check suite (all of it runs without bringing the stack up) and the one
non-obvious rule about `lib/` being the source of truth for the workflow Code
nodes. Found a security problem? [SECURITY.md](SECURITY.md), not a public
issue.

## About

Po11y is built and maintained by
**[Labrise Consulting](https://labrise-consulting.com)**.

Released under the [MIT License](LICENSE). Third-party assets vendored under
[`html/vendor/`](html/vendor/README.md) keep their own licences.

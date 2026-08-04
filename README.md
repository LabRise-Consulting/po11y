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

▶ **[Watch the intro video](https://gitlab.com/labrise/po11y/uploads/d04e082c46c4795f13f9c529b840c926/intro.mp4)**

It covers both modes end to end: the bundled stack, the dashboard, map and
Grafana tabs, the alert rules and the MCP endpoint, then the read-only
collector running against a separate n8n.

The **Overview** view: action buttons (each active form trigger in n8n becomes
a button automatically), monitoring links, running containers, a notification
feed and Grafana panels.

![Dashboard overview](docs/img/dashboard.png)

The **Architecture** view: an interactive map of your workflows, rebuilt from
the live n8n instance every 10 minutes. The structure is computed
deterministically from the workflow export; an LLM (optional, see
[docs/ai-map.md](docs/ai-map.md)) only writes the one-line descriptions, with
heuristic text when none is configured.

![Architecture map](docs/img/architecture.png)

**Grafana**, prewired with four dashboards: n8n execution analytics, system
health, and the official webhook/form dashboards from
[n8n-io/n8n-observability](https://github.com/n8n-io/n8n-observability):

![Grafana execution analytics](docs/img/grafana.png)

Plus a simpler auto-generated **Map** view (pan by dragging, zoom with the
wheel, the buttons or `+`/`-`, and `0` to refit), a staleness badge when the status
feed stops updating, a dark/light theme toggle, and extra sidebar views for
any pages you want to serve.

**Alerting** ships on by default in both modes, with no extra service to run:
Grafana rules against n8n's database in Mode A, a watchdog in the collector in
Mode B. Both cover failing, stale and stuck workflows plus an unreachable n8n.
Mode B can instead run a bundled Prometheus + Alertmanager overlay, which buys
routing and inhibition: one n8n outage arrives as one message rather than one
per workflow. It replaces the collector's own push rather than joining it
([docs/alerting.md](docs/alerting.md)). A read-only **MCP server** at `/mcp/`
lets an agent ask the same questions the dashboard answers, without execution
payloads ever leaving the box ([docs/mcp.md](docs/mcp.md)).

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

**Alerting is on from the first boot.** Five Grafana rules (failing, stale,
stuck, queue backlog and n8n unreachable) evaluate against n8n's own database
and show up under *Alerting* in Grafana with no configuration. Set
`GRAFANA_ALERT_WEBHOOK_URL` when you want them to leave the box. Mode A is the
only mode that can see stuck executions and queue depth at all; see
[docs/alerting.md](docs/alerting.md) for why, and for the three other
mechanisms.

Bootstrap imports and activates a few normal n8n workflows; open them in the
editor to see how they work:

| workflow | what it does |
|----------|--------------|
| Po11y - Status publish | every 2 min, lists Docker containers and writes `status.json` |
| Po11y - Maps | every 10 min, exports all workflows and rebuilds the Map and Actions feeds; the Architecture feed is only rebuilt when something changed (or once a day) |
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
  and `execution:read`, the only four calls the collector makes. Recent n8n
  supports scoped keys on Community Edition too (verified on 2.29.8); if yours
  offers no scope picker, the key is full-access, so create it under a
  dedicated, low-privilege operator account instead.
- Optionally, set `N8N_METRICS=true` on the remote n8n so Prometheus has
  something to scrape. Without it the Grafana tab is simply empty, and no alert
  rule depends on it. n8n serves `/metrics` unauthenticated on its main port, so
  read [docs/security.md](docs/security.md#turning-on-n8n_metrics-upstream-is-a-real-exposure)
  before asking the remote's operator to enable it.

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

**Optional watchdog.** Set `ALERTS_ENABLED=true` and the collector evaluates
three rules on each poll, writing anything worth saying into the notifications
feed the dashboard already renders: `failing` (a workflow erroring above both a
count and a rate floor), `stale` (no *successful* run within its budget,
including an active workflow with no executions at all) and `stuck` (an
execution sitting in `running` past its budget). It costs no extra n8n calls: it
reads the same execution window `status.json` is built from. Staleness is
measured from the last success rather than the last run, so a workflow failing
every five minutes still ages into an alert. Set `ALERT_WEBHOOK_URL` to also
push those alerts to Slack, Discord, Telegram or any webhook (an n8n one, if
you want it to end up as email).

Those three rules are computed *from* n8n, so a poll that can't reach n8n at all
raises a fourth alert of its own (`unreachable`) rather than going quiet on the
outage you most wanted to hear about. It is deduped the same way, so a long
outage is one message and a recovery. Neither survives the box itself dying, which is what
`ALERT_HEARTBEAT_URL` is for: the collector pings it after every successful poll
and something off-box (Healthchecks.io, Uptime Kuma, Better Stack) alerts when
the pings stop. See
[docs/configuration.md](docs/configuration.md) for the budgets and
`.env.example` for every variable.

Mode B's Grafana is Prometheus-only, so the example config embeds the
**System health** dashboard. The execution-analytics dashboard is backed by
n8n's postgres database, which Mode B never connects to, so its panels stay
empty here, which is why `config.example.json` (Mode A) is the wrong starting
point in this mode. What you don't
get: form buttons don't fire by default (`ENABLE_FORM_PROXY=false`, see
[docs/security.md](docs/security.md)), there is never a container list, and
the `/n8n-table/` list-tab proxy isn't wired up for a remote n8n yet.

## How Po11y compares

Other people are solving overlapping problems; several were found on
[community.n8n.io](https://community.n8n.io) (surveyed July 2026, so check the
threads before trusting a cell).

| | what it is | licence | touches your n8n | alerting | per-node detail | architecture map |
|---|---|---|---|---|---|---|
| **Po11y** | status page, workflow maps, Grafana, read-only collector | MIT | Mode A: Po11y runs the n8n. **Mode B: never writes** (GET-only, test-enforced) | 5 Grafana rules (Mode A) or collector watchdog + webhook (Mode B) | no | **yes** |
| **[n8n-trace](https://community.n8n.io/t/273899)** | execution analytics dashboard, its own container + Postgres | MIT | you add its collector workflows | not built (author has it as a maybe) | **yes**: per-node P95, run counts, items out | no |
| **[n8n Manager](https://community.n8n.io/t/187720)** | self-hosting toolkit: install, upgrade, backup, restore ([n8n-toolkit](https://github.com/thenguyenvn90/n8n-toolkit)) | not stated | it installs and manages the instance | yes, `--monitoring` provisions Grafana rules | no | no |
| **[FlowPulse](https://community.n8n.io/t/303372)** | commercial, several low-code platforms, "catch silent automation failures" | not disclosed | not disclosed | yes, that is the pitch | not disclosed | no |
| **[n8n-observability](https://github.com/n8n-io/n8n-observability)** | n8n's own Prometheus + Grafana dashboards | MIT | `N8N_METRICS=true` | build your own rules | no | no |
| **DIY Error Trigger → Slack/Telegram** | one error workflow per route | n/a | yes, workflows in your instance | failures only, no stale or stuck | the error payload | no |

Where Po11y is behind: **n8n-trace has per-node drill-down and RBAC**
(Admin/Analyst/Viewer, scoped by instance, workflow id or tag, with an audit
log). Po11y has neither: it shows you which *workflow* broke, not which node,
and it deliberately treats read authorization as out of scope
([docs/security.md](docs/security.md)). If "which node failed and who may see
it" is your question, n8n-trace answers it better.

Where Po11y is ahead: nothing else in the survey builds an **architecture map**
of how your workflows call each other, nothing else turns **form triggers into
action buttons**, and Mode B's read-only posture is stricter than the
alternatives: it installs no workflows, needs no database of its own, and
makes four GET calls.

## Going further

- [docs/alerting.md](docs/alerting.md): the four alerting mechanisms side by
  side, which mode each belongs to, and why they are alternatives rather than
  layers.
- [docs/security.md](docs/security.md): the security posture of both modes,
  the exposure interlock, and why read authorization is out of scope.
- [docs/forward-auth.md](docs/forward-auth.md): optional OIDC overlay
  (Keycloak/Authentik/Google/GitLab) replacing Basic Auth with real identity,
  and per-group authorization for form firing.
- [docs/configuration.md](docs/configuration.md): `config.json` reference,
  every feed contract, multi-team scopes, the DataTable read proxy, and
  custom tab pages.
- [docs/mcp.md](docs/mcp.md): the read-only MCP server, covering what an agent can ask
  about a running instance, which tools each mode can serve, and why execution
  payloads never leave the box.
- [docs/ai-map.md](docs/ai-map.md): enabling LLM prose on the architecture
  map, and why it costs near zero.
- [docs/integration.md](docs/integration.md): mounting the dashboard into an
  existing compose stack and feeding it from your own n8n.
- [docs/deployment.md](docs/deployment.md): Podman, Kubernetes,
  OpenTelemetry tracing, and how Po11y compares to alternatives.

## Contributing

Issues and merge requests welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the
local check suite (all of it runs without bringing the stack up) and the one
non-obvious rule about `lib/` being the source of truth for the workflow Code
nodes. Found a security problem? [SECURITY.md](SECURITY.md), not a public
issue.

## About

Po11y is built and maintained by
**[Labrise Consulting](https://labrise-consulting.com)**.

Released under the [MIT License](LICENSE). Third-party assets vendored under
[`html/vendor/`](html/vendor/README.md) keep their own licences.

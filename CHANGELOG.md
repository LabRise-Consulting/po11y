# Changelog

Notable changes to Po11y. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not
versioned yet, so `main` is the only line.

## [Unreleased]

### Added

- CI `publish-images` job: pushing a git tag now builds and publishes a
  multi-arch (amd64 + arm64) `server` image to
  `registry.gitlab.com/labrise/po11y/server:<tag>` (plus a moving `latest`),
  gated behind the full validate + smoke pipeline. The n8n-derived bundled
  image stays build-local (Sustainable Use License; the bundled stack needs
  the clone for `bootstrap.sh` anyway).

- MCP endpoint: read-only Model Context Protocol at `/mcp/`, behind the
  dashboard's existing auth. Ten tools — incidents, workflow health, failure
  explanation, executions, dependency graph, PromQL, read-only SQL, and three
  content tools over the datasets your workflows publish. Zero runtime
  dependencies; execution payloads are never returned. Served by the po11y
  `server` process (`server/mcp/`); it shipped as a standalone `mcp` container
  and was folded in before this line was ever released.
- `/metrics`: Prometheus exposition (`po11y_n8n_up`,
  `po11y_poll_last_success_timestamp_seconds`, `po11y_workflow_errors_total`,
  `po11y_workflow_last_success_timestamp_seconds`,
  `po11y_workflow_running_seconds`), served by the po11y `server` at
  `server:8081/metrics`. The error metric is a true accumulated counter
  rather than a sliding execution window, so `increase()` and `rate()`
  behave. (This shipped first on the collector's own health port, scraped by
  the read-only stack's Prometheus; the collector is gone — see the Phase 3
  entry below — and `/metrics` now lives on the server for every deployment.)
- `docker-compose.alerts.yml`: opt-in Prometheus rules + Alertmanager overlay
  for the read-only stack, with an inhibit rule so one unreachable n8n
  reports as one alert instead of one per workflow. An alternative to
  po11y's own webhook push (on the `server` service), not a companion to it.
- `SECURITY.md`: confidential-issue disclosure process, plus an explicit
  in-scope/out-of-scope list so the documented design trade-offs in
  `docs/security.md` don't get re-reported as vulnerabilities.
- `CONTRIBUTING.md`: the full local check suite and the project conventions.
  (Its `lib/` → `tools/sync-workflows.mjs` → `maps.json` loop was retired in
  the same Phase 3 that deleted that loop entirely — see below.)
- `html/vendor/README.md` and `html/vendor/mermaid.LICENSE`: provenance,
  version and SHA-256 for the vendored Mermaid build, which shipped with no
  attribution despite being MIT-licensed.

### Fixed

- Phase 3: `po11y_poll_last_success_timestamp_seconds` is refreshed only by a
  poll that actually reached n8n. The executions fetch swallowed every failure
  into an empty list, so an unreachable n8n, a revoked key or a timed-out
  request all looked like an idle instance and the gauge reported a fresh poll
  for as long as the process lived. `Po11yPollStalled` was therefore unfireable
  in both directions — the series never aged while the server ran, and it
  disappears when the server is down. An outage now leaves the stamp to age,
  which is what the alert reads.

- Maps: workflow ids that differ only in punctuation (`a-b` and `a.b`) no
  longer collapse into one mermaid node. Sanitising to `[A-Za-z0-9_]` mapped
  both onto `wf_a_b`, so the diagram silently merged two workflows and the
  dialog showed whichever came last. Ids that need no sanitising keep their
  plain form, so existing maps do not churn.
- Maps: schedule triggers on a weeks or months interval show it. Both builders
  read the interval count from a fixed list of four unit fields, so those
  schedules rendered as an unlabelled "schedule".
- MCP: `/healthz` answers `405` to POST/PUT/DELETE/PATCH instead of `200`. The
  health branch sat above the method check.
- MCP: self-start detection compares the resolved module URL instead of testing
  whether the entry script is *named* `index.mjs`, which almost every entry
  script is — importing the module from one started a second listener.
- Collector: new optional `BIND_HOST` narrows the listener from every
  interface. The default is unchanged and correct under the shipped compose
  (the port is not published), but it serves unauthenticated endpoints, so
  host networking or a shared network namespace deserves an explicit knob.
  Documented in `.env.example`. The MCP listener gained the same knob; it has
  since become a route on the `server` process, which binds and caps bodies
  with the server's own variables (`PO11Y_MAX_BODY_BYTES`).
- Dashboard: Actions cards now point at the n8n `config.json` names. `app.js`
  hardcoded `http://{host}:5678`, so with a remote n8n (the Mode B case) the
  Map tab's dialogs and the Actions cards disagreed about the same instance.
  The new `n8nUrl` and `formProxy` config keys are documented, and the Mode B
  example config sets both.
- Dashboard: with the `/form/` proxy off — Mode B's default — a field-less form
  trigger renders as a link to n8n's form page instead of an in-place POST
  button that could only ever answer `failed (HTTP 404)`.
- Dashboard: execution counts from `status.json` are escaped like every other
  rendered field. `status.json` is written by a user-editable Code node in
  Mode A, so they are external data.
- Dashboard: `refreshSec: 0` no longer becomes `setInterval(…, 0)` and floods
  the box with feed requests; intervals are clamped to a floor.
- Dashboard: `safeUrl` rejects protocol-relative `//host/path` URLs, which look
  relative but are fully cross-origin.
- Dashboard: an unreadable `config.json` no longer also lights the "stale"
  badge. The built-in `staleAfterMin: 5` fell below the default poll interval,
  so the first-run mistake reported a second, false problem.
- Dashboard: a configured Actions card using the `action` key no longer
  produces a duplicate button when the same form is auto-discovered.
- Mode B: the Map tab is interactive. The collector published `map.json`
  without `entries`, which is what links a mermaid node back to its n8n
  workflow, so clicking a node did nothing and the workflow dialog with its AI
  summary never opened — for as long as Mode B has existed. The Mode A Code
  node had always published it. Both publishers' feed shapes are now pinned to
  each other by test.
- Mode A + OTel: `docker compose -f docker-compose.yml -f docker-compose.otel.yml
  up -d` no longer boots with zero Grafana alert rules. The overlay re-declared
  the grafana `entrypoint`, compose replaces entrypoints instead of merging
  them, and the overlay's copy omitted the alerting-provisioning branch — so
  the alerting volume mounted and went unread while the rules claimed to be
  always on. The provisioning render now lives in one script
  (`observability/grafana/entrypoint.sh`) shared by all three compose files,
  with overlays contributing datasources and dashboards through a mounted
  extras directory instead of a second entrypoint. CI asserts the entrypoint
  survives the overlay merge, that the alerting mount is still there, and that
  the overlay's Prometheus command still matches the base plus its one extra
  flag.
- MCP: `po11y_graph` and `po11y_workflow`'s neighbour slice now actually
  traverse the map. They read edges as `{from, to}` objects while every
  publisher writes `[from, to, kind]` arrays, so the slice returned the seed
  node and an empty edge list for every workflow, in both modes. The test
  fixture enshrined the wrong shape, which is why the suite stayed green; it is
  now produced by running the real builder.
- Mode B: a workflow node without a `type` no longer aborts every feed. The
  ai-map builder threw on it, and the collector's fallback (which assumes any
  throw is an LLM outage) threw again on the retry, so a cosmetic ai-map defect
  stopped `map.json`, `forms.json` and `status.json` publishing — permanently,
  since a failed poll keeps the last-good files.
- Mode B: `ALERTS_ENABLED=false` now switches alerting off when
  `ALERT_RULES_FILE` enables it. The two were OR-ed, so the kill switch could
  only ever switch alerting on, contradicting the documented "env wins over the
  file" rule every other alert setting follows.
- Mode B: the collector's LLM request now sends `stream: false`, matching the
  Mode A Code node. Without it, gateways that default to SSE — including the
  bundled OmniRoute `auto/*` routes — made every annotation attempt fail, and
  the ai-map degraded to heuristic text silently.

### Changed

- Phase 3 — one mode, not two: `po11y_workflow_errors_total` is now
  persisted in the store and monotonic across restarts, instead of an
  in-memory counter that reset to zero on every collector restart, several
  times a week. Existing Grafana panels over that series look flatter and
  more honest after the first deploy on the new counter (expect one
  discontinuity, since the table starts empty). A store restored from an
  older backup rewinds the counter — that is a genuine Prometheus counter
  reset, correctly handled, not a bug to paper over with a `max()` guard.
- Phase 3: multi-scope deployments now need one `server` process per scope
  (each with its own store and `PO11Y_SCOPE`), instead of several publishers
  sharing one status volume. See `docs/server.md`.
- Phase 3: the Grafana alert rule formerly named `Po11yCollectorDown` is now
  `Po11yServerDown`, matching the process it actually watches.
- Phase 3: the bundled stack's Prometheus scrapes the `server` as the
  `po11y-server` job. `observability/prometheus.yml` had no such job, so on
  `docker-compose.yml` the five po11y series existed nowhere in Prometheus and
  every rule in `observability/alerts.yml` was inert there.
- Phase 3: `bootstrap.sh` deletes the retired `maps` and `status-publish`
  workflows from a live n8n on the next run. Without that, an upgraded
  deployment kept running both — `status-publish` writing to a volume that is
  no longer mounted, and `maps` making scheduled LLM calls alongside the
  server's own ai-map builder.
- Phase 3: bootstrap's OmniRoute auto-wiring writes `AI_MAP_BASE_URL`,
  `AI_MAP_API_KEY` and `AI_MAP_MODEL` back into `.env`. It previously wrote
  them only into `secrets/ai-map.json`, which the deleted maps workflow read
  and the server does not, so a default bundled stack was silently publishing
  the heuristic map. **A bundled stack that was heuristic-only for that reason
  starts POSTing workflow digests through OmniRoute after the next bootstrap.**
  `docs/security.md` documents that as the default rather than a new
  behaviour, so this closes a disclosure gap rather than changing the intent —
  set `OMNIROUTE_ENABLED=false` (which now also clears what it auto-wired) to
  stay heuristic.
- Mode B: the collector watchdog is now **on by default** (`ALERTS_ENABLED=false`
  opts out; a rules file with `enabled: false` also works). It costs no extra
  n8n calls and pushes nothing anywhere without `ALERT_WEBHOOK_URL`, so the
  previous opt-in default bought nothing except a `notifications.json` 404 on
  every fresh install. The stale/stuck budgets still default to off; a bare
  default gets `failing` and `unreachable`.
- Documentation corrected where it described behaviour the code does not have.
  An audit found the confident claims were the unreliable ones, so these are
  the words changing to match the code, not the other way round:
  - Alerting is **not** on by default in both modes. Mode A's Grafana rules
    are; Mode B's watchdog needs `ALERTS_ENABLED=true`, and two of its three
    rules need a budget on top of that. README, `docs/alerting.md` and
    `.env.example` all said otherwise.
  - `observability/alerts.yml`'s thresholds are **not** the watchdog's defaults
    restated. The header now tabulates the three real differences, including
    the error-rate floor no PromQL rule reproduces.
  - Stuck executions are visible in **both** modes (Mode B derives
    `po11y_workflow_running_seconds` by polling). `docs/alerting.md`
    contradicted itself two bullets apart; only queue depth is Mode A-only.
  - "Execution payloads never leave the box" is true of the ops tools and not
    of `po11y_sql` or `po11y_row`. README and the MCP tool headers (now
    `server/mcp/`) say which is which, as does `docs/mcp.md`'s data privacy
    policy.
  - The collector makes three GETs per poll, not four; the fourth scope
    (`execution:read`) is for the MCP server sharing the key.
  - `deploy/k8s/` is a subset of the compose stack, not a port of it. Most
    importantly **there is no authentication on k8s** — the nginx ConfigMap
    ships without the auth include and nothing renders one. Also absent: any
    Mode B or MCP Deployment, all five Grafana alert rules, the `/form/` proxy,
    `/lib/list-rows.mjs`, scopes, `/n8n-table/`, and compose's container
    hardening. `docs/deployment.md` has the full table.
  - `docs/integration.md`'s nginx recipe could not start nginx: `nginx.conf`
    was a template with a `${N8N_READ_API_KEY}` placeholder (since retired —
    the key moved onto the `server` service) plus three literal includes the
    entrypoint writes. The replacement recipe was verified with `nginx -t`.
  - `n8nUrl`, `formProxy`, `cards[].action` and `BIND_HOST` are documented;
    several were read by the code and named nowhere.
- CI: every validate-stage job is now untagged and runs on stock GitLab
  shared runners. Previously all jobs were pinned to a self-hosted runner, so
  a fork or an outside merge request got no pipeline at all. `smoke` still
  needs a privileged dind host and is now restricted to the canonical project
  instead of hanging on a tag nobody else provides. (The validate stage was
  six jobs at the time, including `sync-check`; Phase 3 dropped it to five —
  see below.)
- A missing or unreadable `/config.json` now says so in the dashboard lede
  instead of silently falling back to built-in defaults and rendering an empty
  page.
- The Mode B quickstart creates `config.json` before the first `up`. Both
  compose files bind-mount it, so without that step docker created a
  *directory* of that name and the dashboard came up blank.

### Removed

- Phase 3 — one mode, not two: the collector daemon (`collector/`) is
  deleted. The `server` process now owns polling, the feeds, and `/metrics`
  for every deployment (see above); n8n needs no po11y workflows installed.
- Phase 3: Mode A's Code-node publisher workflows (`workflows/core/`),
  `tools/sync-workflows.mjs`, and `deploy/nginx/feeds-files.conf` are
  deleted. The dashboard's feeds always come from the server, proxied by
  nginx — there is no file-served alternative any more.
- Phase 3: `FEED_SOURCE` and the shared `po11y_status` volume are gone.
  There is one feed path now, not a switch between two.
- **Phase 3: `bootstrap.sh` now mints an n8n API key.** The deleted publisher
  workflows read n8n through their own internal credentials, so a bundled stack
  produced a full dashboard with no key configured anywhere. The server reads
  n8n over the public API, which accepts nothing but a key — so without one a
  default stack would now come up correct and completely empty (serving-only:
  no sync, no poll, no feed build, `status.json` reporting `generated_at` null).
  Bootstrap therefore signs in as the owner it already creates and mints one
  read-only key into `MCP_N8N_API_KEY`: workflow, execution and data-table read
  scopes, no expiry, labelled `po11y server (read-only)`. **A key you set
  yourself is never touched**, including a key pointing at a different n8n, and
  a re-run never rotates a working one. If the mint fails, bootstrap says so and
  tells you where to create one by hand. See `docs/security.md`.
- **Phase 3 — privileges that outlived their features.** The bundled stack no
  longer mounts the host Docker socket, no longer runs the `docker-proxy`
  sidecar, and no longer sets `NODES_EXCLUDE=[]` (Execute Command) or
  `NODE_FUNCTION_ALLOW_BUILTIN=fs`. Each existed for a deleted publisher
  workflow. The n8n image drops the static `docker` CLI and the `/po11y-status`
  directory with them. **If your own workflows use the Execute Command node or
  `require('fs')` in a Code node, re-add the relevant variable to the `n8n`
  service** — po11y itself needs neither.

  **Re-run `./bootstrap.sh` when upgrading.** The same change turns a leftover
  copy of the deleted `HN notify` example from a silent no-op into a hard
  failure: its Code node calls `require('fs')`, which now has no allowed
  builtin and no `/po11y-status` to write to. `hn-tech-news` still calls it
  every 30 minutes, so on an instance that kept it the demo goes red and
  raises a `failing` alert (and a webhook push, if configured). Bootstrap
  deletes it — `--no-examples` included — but a `git pull && docker compose up
  -d` with no bootstrap run will not.
- Phase 3: `ai-map-cli.sh` is deleted. It read and wrote the AI map inside the
  n8n container through a mount that no longer exists, so it could not run at
  all. The server owns the map; force a rebuild with the **Build maps now**
  action or `docker kill -s HUP po11y-server`, and drive a local model by
  pointing `AI_MAP_BASE_URL` at Ollama or any OpenAI-compatible endpoint.
- Phase 3: the `Po11y example - HN notify` demo workflow is deleted and
  `HN tech news` no longer calls it. Its Code node wrote
  `/po11y-status/notifications.json`. With that volume unmounted the write did
  not fail — it landed in the container filesystem, where nothing reads it — so
  the demo went on reporting success while publishing nothing. Removing the
  `fs` builtin turns the same call into a hard error, which is why the entry
  above asks you to re-run `./bootstrap.sh`. The server is the only writer of
  the notifications feed; an n8n workflow cannot publish into it.
- `docs/video/` and `docs/intro.mp4` removed and stripped from history. The
  rendered video was 25 MB of a 78 MB clone, and Remotion is not MIT-licensed
  — it requires a paid company licence above three people, which does not
  belong in an MIT repo's dependency tree. The Remotion source moved to a
  separate repository; the rendered mp4 is now a project upload that the
  README links, so it costs the clone nothing.
- `docs/superpowers/` (local planning output) removed and stripped from history.

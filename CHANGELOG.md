# Changelog

Notable changes to Po11y. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not
versioned yet, so `main` is the only line.

## [Unreleased]

### Added

- CI `publish-images` job: pushing a git tag now builds and publishes
  multi-arch (amd64 + arm64) `collector` and `mcp` images to
  `registry.gitlab.com/labrise/po11y/<name>:<tag>` (plus a moving `latest`),
  gated behind the full validate + smoke pipeline. The n8n-derived Mode A
  image stays build-local (Sustainable Use License; Mode A needs the clone
  for `bootstrap.sh` anyway).

- MCP server (`mcp/`): read-only Model Context Protocol endpoint at `/mcp/`,
  behind the dashboard's existing auth. Ten tools — incidents, workflow health,
  failure explanation, executions, dependency graph, PromQL, read-only SQL, and
  three content tools over the datasets your workflows publish. Zero runtime
  dependencies; execution payloads are never returned.
- Collector `/metrics`: Prometheus exposition on the existing health port
  (`po11y_n8n_up`, `po11y_poll_last_success_timestamp_seconds`,
  `po11y_workflow_errors_total`, `po11y_workflow_last_success_timestamp_seconds`,
  `po11y_workflow_running_seconds`), scraped by the Mode B Prometheus. The error
  metric is a true accumulated counter rather than the sliding execution
  window, so `increase()` and `rate()` behave.
- `docker-compose.alerts.yml`: opt-in Prometheus rules + Alertmanager overlay
  for Mode B, with an inhibit rule so one unreachable n8n reports as one alert
  instead of one per workflow. An alternative to the collector's own webhook
  push, not a companion to it.
- `SECURITY.md`: confidential-issue disclosure process, plus an explicit
  in-scope/out-of-scope list so the documented design trade-offs in
  `docs/security.md` don't get re-reported as vulnerabilities.
- `CONTRIBUTING.md`: the full local check suite, the `lib/` →
  `tools/sync-workflows.mjs` → `maps.json` loop, and the project conventions.
- `html/vendor/README.md` and `html/vendor/mermaid.LICENSE`: provenance,
  version and SHA-256 for the vendored Mermaid build, which shipped with no
  attribution despite being MIT-licensed.

### Fixed

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
- Collector and MCP: new optional `BIND_HOST` narrows the listener from every
  interface. The default is unchanged and correct under the shipped compose
  (neither port is published), but both serve unauthenticated endpoints, so
  host networking or a shared network namespace deserves an explicit knob.
  `MCP_MAX_BODY` was readable but documented nowhere; both are now in
  `.env.example`.
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
    of `po11y_sql` or `po11y_row`. README and the `mcp/index.mjs` header now
    say which is which.
  - The collector makes three GETs per poll, not four; the fourth scope
    (`execution:read`) is for the MCP server sharing the key.
  - `deploy/k8s/` is a subset of the compose stack, not a port of it. Most
    importantly **there is no authentication on k8s** — the nginx ConfigMap
    ships without the auth include and nothing renders one. Also absent: any
    Mode B or MCP Deployment, all five Grafana alert rules, the `/form/` proxy,
    `/lib/list-rows.mjs`, scopes, `/n8n-table/`, and compose's container
    hardening. `docs/deployment.md` has the full table.
  - `docs/integration.md`'s nginx recipe could not start nginx: `nginx.conf` is
    a template with a `${N8N_READ_API_KEY}` placeholder and three literal
    includes the entrypoint writes. The replacement recipe was verified with
    `nginx -t`.
  - `n8nUrl`, `formProxy`, `cards[].action`, `MCP_MAX_BODY` and `BIND_HOST` are
    documented; several were read by the code and named nowhere.
- CI: every validate-stage job (`test`, `sync-check`, `lint`, `interlock`,
  `compose-config`, `manifests`) is now untagged and runs on stock GitLab
  shared runners. Previously all jobs were pinned to a self-hosted runner, so
  a fork or an outside merge request got no pipeline at all. `smoke` still
  needs a privileged dind host and is now restricted to the canonical project
  instead of hanging on a tag nobody else provides.
- A missing or unreadable `/config.json` now says so in the dashboard lede
  instead of silently falling back to built-in defaults and rendering an empty
  page.
- The Mode B quickstart creates `config.json` before the first `up`. Both
  compose files bind-mount it, so without that step docker created a
  *directory* of that name and the dashboard came up blank.

### Removed

- `docs/video/` and `docs/intro.mp4` removed and stripped from history. The
  rendered video was 25 MB of a 78 MB clone, and Remotion is not MIT-licensed
  — it requires a paid company licence above three people, which does not
  belong in an MIT repo's dependency tree. The Remotion source moved to a
  separate repository; the rendered mp4 is now a project upload that the
  README links, so it costs the clone nothing.
- `docs/superpowers/` (local planning output) removed and stripped from history.

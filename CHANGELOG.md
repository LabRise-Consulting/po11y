# Changelog

Notable changes to Po11y. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `scripts/readonly-preflight.sh`, the read-only topology's stand-in for
  `bootstrap.sh`. It checks that the n8n public API accepts the key and that
  `/metrics` is reachable, then names every `N8N_METRICS_INCLUDE_*` flag the
  remote has off together with the po11y surface each one feeds — a read-only
  operator cannot set those flags themselves, so the script's job is telling
  them exactly what to ask the remote's admin for. Verdicts read each metric's
  `# TYPE` declaration rather than its samples: n8n registers a metric when its
  flag is on, but a histogram carries no series until the first request it
  measures, so a correctly configured instance that has served no webhook call
  yet would otherwise be reported as missing the flag. It also generates
  `GRAFANA_ADMIN_PASSWORD` and the three OmniRoute secrets, writing only
  variables that are still empty. `ci/check-readonly-preflight.sh` asserts the
  verdicts in both directions against two fixture expositions.
- Monitoring cards for the Form and Webhook execution dashboards, plus a
  Grafana card for the dashboard list, in both config templates. Grafana
  provisions four dashboards; the templates linked one.
- A degraded architecture map now says so on the dashboard. When an LLM is
  configured and the build cannot reach it, the map still publishes with
  heuristic descriptions — until now the only trace was a stderr line and
  `po11y_ai_map_llm_up`, so a dashboard reader saw prose quietly turn generic
  with no way to tell a deliberate local map from a gateway that was down.
  The build now raises an `info` alert through the watchdog, which gives it
  dedupe, renotify and recovery on the same terms as every other rule, so it
  lands in `notifications.json`, the dashboard's notifications section, and the
  `ALERT_WEBHOOK_URL` push. It fires only where `AI_MAP_*` is set: a stack
  without an LLM is heuristic by choice, not degraded.
- `ai-map.json` carries an `llm` block — `{ configured, ok, error }` — and the
  Architecture page's footer reads `by heuristic — LLM unavailable (…)` rather
  than `by heuristic`, which had looked like a choice.

### Fixed

- The OmniRoute overlay could not start on a read-only stack. Its three
  secrets are `:?`-required and were generated only by `bootstrap.sh`, which
  that topology never runs, so the documented LLM architecture map needed a
  hand-run `openssl` before compose would come up. `readonly-preflight.sh`
  seeds them.
- Links to Prometheus resolved to the monitored n8n's host rather than the box
  serving the dashboard. `{host}` follows `config.json`'s `baseUrl`, which on
  the read-only topology points at a remote n8n, so `http://{host}:9090/` left
  the local Prometheus unreachable from its own card. New `{self}` placeholder
  always resolves to the browser's hostname; both config templates use it for
  Prometheus, and the bundled one for OmniRoute.
- `alertsToNotifications` hardcoded `status: "failure"` for everything that was
  not a recovery, so an alert's `severity` never reached the feed. Every rule
  that existed was a failure, so nothing had exposed it. Statuses now follow
  severity, with anything unrecognised still reported as a failure — the rules
  that predate severity carry none, and under-reporting a real failure is the
  worse direction to guess in.

## [0.1.0] - 2026-08-20

First tagged release, and the first public one. Everything below is the
project's development to this point, collapsed into one entry — which is why
it also records features that were added and later removed. Nothing here was
shipped under an earlier version number, so a reader tracking upgrades starts
at this line.

Entries below use **Mode A** and **Mode B**, the names the two deployments
carried while they were built on different machinery: Mode A published the
dashboard's feeds from Code nodes inside a bundled n8n, Mode B from a separate
collector daemon watching an n8n you already ran. Both now run the same
`server` process — the "one mode, not two" entries record that consolidation —
and the README calls the deployments **bundled** and **read-only**.

### Added

- List tab source filter: a `list` tab with a `badge` mapping now offers a
  multi-select over the badge values present in the selected range, so a feed
  merging several upstreams can be narrowed to a few of them (e.g. only
  `sentry` and `grafana`). Client-side over the rows already walked — no
  extra requests — with an **All** button to clear it and an optional
  `badgeLabel` to caption the row. The bar stays hidden for single-source
  feeds.

- Dashboard: the open view is named in the address bar (`#projects`,
  `#reports/daily`, `#map`), so a reload, a bookmark or a shared link opens
  that view instead of the Overview — including the reload a scope switch
  performs. Views and tabs are addressable by `id` or by `label`, case and
  punctuation insensitive, and a grouped tab can be named on its own. Picking a
  view pushes a history entry, so Back walks them; a hash the config does not
  describe is ignored rather than rewritten.

- Execution rows on the Overview say what is running **now**: `status.json`'s
  `byWorkflow` entries carry a `running` count, drawn as a cyan pulsing dot and
  an "N running" pill. Failure still outranks activity — an erroring workflow
  keeps its red dot while it runs. Freshness is bounded by `POLL_INTERVAL`
  (30 s by default), so this is "running as of the last poll".

- `po11y_ai_map_llm_up`: a gauge saying whether the last ai-map build got LLM
  prose (`1`) or fell back to heuristic descriptions (`0`), plus a
  `Po11yAiMapLlmDegraded` warning rule in `observability/alerts.yml`. A keyless
  free-tier provider exhausting its quota is otherwise silent — the map keeps
  its structure and only the footer changes from `by auto/best-free` to
  `by heuristic`.

  It is a byproduct of the build the server already runs, not a probe: OmniRoute
  exposes no `/metrics`, and pointing a scrape job at its `/v1/models` would
  report a healthy gateway as **down**, because Prometheus cannot parse a JSON
  body and records the scrape as failed. The series is absent when no LLM is
  configured, and holds its previous reading on rebuilds where `buildAiMap`
  returned without calling the LLM (`republish`, `keep-annotated`,
  `skip-fresh`) rather than reading a null degraded-reason as an all-clear.

- OmniRoute link card in `config.example.json`'s Monitoring group. The gateway
  boots with the bundled stack but nothing pointed at it, so the one place you
  connect providers was undiscoverable unless you knew the port. `config.json`
  is seeded only when absent, so existing installs must add the card by hand;
  deployments running `OMNIROUTE_ENABLED=false` should remove it.

- Four more demo workflows in `workflows/examples/`: `order-intake` (webhook)
  calling `enrich-record` (sub-workflow), plus `ops-checklist` (form) and
  `daily-digest` (schedule). The server consolidation correctly stopped
  installing po11y's own workflows into n8n, which left a fresh install with
  one workflow and almost nothing on the map. All four are credential-free, make no outbound call, and
  cannot fail on a healthy install.

- `workflows/demo/heartbeat.json`, an opt-in demo workflow that runs every
  minute and holds the execution open for 20 seconds. Every bundled example
  finishes in a few seconds — shorter than any sane poll interval — so the
  live-run indicator, `po11y_workflow_running_seconds` and the watchdog's
  `stuck` rule had nothing to act on. This one keeps a workflow genuinely in
  flight about a third of the time. Import it with
  `./bootstrap.sh --pack /workflows/demo`; it is kept out of `workflows/examples/`
  because bootstrap publishes everything it imports, and 1440 executions a day
  is not a default anyone asked for.

  Waits under 65 seconds keep the execution in memory and n8n reports it as
  `running`; a longer wait becomes `waiting`, which Po11y deliberately does not
  count as in flight.

- CI `publish-images` job: pushing a git tag now builds and publishes a
  multi-arch (amd64 + arm64) `server` image to
  `ghcr.io/labrise-consulting/po11y/server:<tag>` (plus a moving `latest`),
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
  the read-only stack's Prometheus; the collector is gone — see the collector
  removal below — and `/metrics` now lives on the server for every deployment.)
- `docker-compose.alerts.yml`: opt-in Prometheus rules + Alertmanager overlay
  for the read-only stack, with an inhibit rule so one unreachable n8n
  reports as one alert instead of one per workflow. An alternative to
  po11y's own webhook push (on the `server` service), not a companion to it.
- `SECURITY.md`: a private disclosure process, plus an explicit
  in-scope/out-of-scope list so the documented design trade-offs in
  `docs/security.md` don't get re-reported as vulnerabilities.
- `CONTRIBUTING.md`: the full local check suite and the project conventions.
  (Its `lib/` → `tools/sync-workflows.mjs` → `maps.json` loop was retired in
  the same consolidation that deleted that loop entirely — see below.)
- `html/vendor/README.md` and `html/vendor/mermaid.LICENSE`: provenance,
  version and SHA-256 for the vendored Mermaid build, which shipped with no
  attribution despite being MIT-licensed.

### Fixed

- The Overview's execution filter reaches every workflow. `status.json` sliced
  `byWorkflow` to the ten busiest before it left the server, and the filter box
  searches the array it was sent, so on an instance with more workflows than
  that, typing the name of the eleventh-busiest returned "no match" for a
  workflow that exists and is running. The cap now lives in the dashboard:
  `byWorkflow` carries every workflow in the recent window, busiest first, so
  its counts sum to `recent` again and any consumer can search the whole set.
  The Overview still shows ten rows and gains the "show all N" toggle the
  notification feed already uses. Alerting was never affected — the watchdog
  reads its own untruncated fold.

- Alert rules now evaluate production executions only. n8n stamps every run
  with the mode that started it, and the two hand-run modes (`manual`,
  `evaluation`) were counted like any other: failed editor runs could raise a
  `failing` alert while debugging, and — worse — one manual success refreshed
  the staleness budget of a schedule that had been dead for days. Sub-workflow
  runs (`integrated`) still count, since for many sub-workflows that is the
  only way they run. The dashboard's execution summary stays unfiltered.

- A cold `bootstrap.sh` could leave the architecture map and the workflow map
  empty for ten minutes. The workflow sync runs its first tick the moment the
  server process starts, which is while n8n is still applying its first-boot
  migrations, so that tick failed with `fetch failed`. The loop then re-armed
  at the full `SERVER_SYNC_INTERVAL` (600 s), and `map.json` and `ai-map.json`
  stayed at their cold-start skeletons until it came round again — on an
  install that was otherwise healthy, and where every other feed already
  worked. Bootstrap restarts n8n part-way through, so a second miss was
  possible even when the first tick got through. A failed sync now retries
  after `SERVER_SYNC_RETRY_INTERVAL` (15 s) instead; a successful one always
  returns to the full interval, so the retry never becomes the cadence. The
  poll loop is untouched, since its 30 s interval already self-heals and
  retrying faster would only add load to an n8n that is already unwell.

- The architecture map's LLM call could not afford a reasoning model. Its
  budget was a hard-coded `max_tokens: 3000`, and a reasoning model spends the
  same allowance on its hidden thinking as on the answer — so the bundled
  default route (`auto/best-free`, which resolves to one) thought, then stopped
  mid-string. The server reported `annotation unusable` with a JSON parse error
  naming neither the cause nor the cure, and the map sat on heuristic text
  indefinitely on a stock install. The default is now 8000, tunable with
  `AI_MAP_MAX_TOKENS`, and a truncated reply is reported as truncation.

- The poll now asks n8n for in-flight executions. n8n's public API leaves
  running executions **out** of the default `/executions` listing — they are
  reachable only via `?status=running` — so a poll-driven deployment never
  stored a single running row. Everything downstream read a confident zero:
  `po11y_workflow_running_seconds`, the watchdog's `stuck` rule and the
  `Po11yWorkflowStuck` alert could not fire on polled data at all. The extra
  listing is supplementary: if it fails the poll still succeeds, and a row left
  stale at `running` self-heals when the execution ends and reappears with its
  terminal status.

  Unit tests could not have caught this — they fed the fetcher a list that
  already contained a running execution. It surfaced only by watching a real
  execution against a real n8n while the metric insisted nothing was running.

- `N8N_PUBLIC_URL`: every link po11y hands out — MCP tool results, watchdog
  notifications, webhook pushes — was built from `N8N_API_URL`, the address
  this process *sends* to. On the bundled stack that is the compose-network
  address `http://n8n:5678`, which resolves inside that network and nowhere
  else, so a `po11y_failure` result told its reader to open a URL that could
  not be opened. Links now come from `N8N_PUBLIC_URL`, which falls back to
  `N8N_API_URL` (correct for the single-host and read-only stacks, where the
  two coincide) and which the bundled compose file defaults to
  `http://${BIND_ADDR}:5678` — the same address n8n builds its own
  `WEBHOOK_URL` from. The adapter field is now `linkBase`, not `baseUrl`, so
  a future link site cannot reach for the request address by habit.

- `po11y_executions` no longer phrases a filtered slice as a failure rate.
  `{status: "error"}` returns rows that are all errors by construction, and
  the old summary — "1 of 1 recent runs failed" — described a burning instance
  where it meant one error existed at all. Under a `status` filter the summary
  now offers no denominator and says the result is a slice; the applied
  `filters` are echoed back, since the answer travels further than the call
  that produced it.

- `po11y_executions` reports the age of the newest matching run
  (`newest_started_at`, `newest_age_seconds`, and in words in the summary). A
  column of timestamps never says "and nothing has matched since", so an error
  filter on an instance that recovered days ago read as a live outage — the
  same reason `po11y_incidents` already carried `feed_age_seconds`.

- `po11y_failure` names where the payload *is*, not only that po11y withholds
  it: the deep link, or n8n's own MCP server (`get_execution`), which returns
  the run under the operator's credentials. The privacy rule is a po11y
  policy, and stating it without a forward pointer is where an investigation
  stops or starts guessing.

- `po11y_poll_last_success_timestamp_seconds` is refreshed only by a
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

- The README plays the video overview inline. GitHub renders a player only for
  files uploaded as markdown attachments, so a 1920x1080 re-encode is uploaded
  that way and embedded. The repository still carries no video, and neither does
  the release: the file lives on GitHub's attachment store, not in the clone.

- Two defaults are sized for a large instance instead of a small one.
  `EXECUTIONS_LIMIT` now defaults to `250`, which is the maximum n8n's
  executions API accepts: the window bounds every count the dashboard shows, so
  a smaller one buys nothing but blind spots — fifty workflows spend a
  100-execution window in two polls, and whatever aged out is invisible to
  `status.json` and to the `failing` rule. It is still one GET per poll, of
  metadata only. `AI_MAP_MAX_TOKENS` now defaults to `16000`, because the
  annotation answer grows with the instance (one line per node, one summary per
  workflow) and a reasoning model spends the same budget on its hidden
  thinking; a ceiling is not a spend, so it is set to clear a large map rather
  than to fit a small one.

- The feature comparison now states its scope, links every project it names, and
  carries the date it was compiled along with an invitation to correct it. Three
  cells were wrong when checked against the projects' own documentation: n8n
  Manager's licence was listed as unstated when it is MIT and ships in
  `thenguyenvn90/n8n-toolkit`, and both of FlowPulse's "undisclosed" cells are
  documented by the vendor. A fourth, n8n-trace's alerting, could not be
  verified from its README at all. Describing a project as secretive when it
  publishes the detail is the one thing a comparison table must not do. The
  table is now limited to self-hosted open-source projects, a boundary that can
  be stated and checked rather than left implicit, and each row leads with how
  the tool reads n8n — the property that decides what it can see, and the one
  least likely to go stale between their releases.

- The README states two claims accurately that it previously overstated. n8n's
  diagnostics are switched off by the bundled topology only, which was written
  as though it were true everywhere, and the read-only topology cannot change a
  setting on an instance it does not manage. "Real-time visibility" was also
  promised in the opening line and then withdrawn a screen later by the poll
  interval section, which explains that a workflow shorter than one interval is
  never shown as running at all.
- The privacy note names where the digests actually go — OmniRoute's
  `auto/best-free` route — instead of "a keyless free-tier third-party
  provider". A reader cannot weigh a privacy default whose recipient is
  unnamed.
- The published container images are now in the README. CI has pushed
  `ghcr.io/labrise-consulting/po11y/server` on every tag since the move to
  GitHub Actions, but only `docs/ci.md` and this changelog said so, so a reader
  had no way to learn they could pull the server rather than build it. The
  entry also records what is deliberately not published, and that the bundled
  topology still needs the repository.
- Smaller README corrections: the bundled quickstart states its prerequisites,
  as the read-only one already did; `--pack` explains that `/workflows/` and
  `/packs/` paths are read inside the container while any other path is a host
  directory; the two map bullets name the tabs they describe, which the UI
  labels differently; CI, licence and release badges are at the top; and the
  headings use one capitalisation style.

- `SERVER_POLL_INTERVAL` now defaults to **30 s**, down from 60 s. The interval
  is not only how stale the dashboard can be — it is the resolution of the
  live-run view. A workflow that finishes in less than one interval can start
  and end between two polls, so it is counted but never seen running, and the
  watchdog's `stuck` rule cannot see it either. 30 s halves that blind spot for
  the short workflows most instances run, at two extra GETs per minute. The
  trade-off, and how to size the interval, is documented in the README and in
  [docs/server.md](docs/server.md).

- One mode, not two: `po11y_workflow_errors_total` is now
  persisted in the store and monotonic across restarts, instead of an
  in-memory counter that reset to zero on every collector restart, several
  times a week. Existing Grafana panels over that series look flatter and
  more honest after the first deploy on the new counter (expect one
  discontinuity, since the table starts empty). A store restored from an
  older backup rewinds the counter — that is a genuine Prometheus counter
  reset, correctly handled, not a bug to paper over with a `max()` guard.
- Multi-scope deployments now need one `server` process per scope
  (each with its own store and `PO11Y_SCOPE`), instead of several publishers
  sharing one status volume. See `docs/server.md`.
- The Grafana alert rule formerly named `Po11yCollectorDown` is now
  `Po11yServerDown`, matching the process it actually watches.
- The bundled stack's Prometheus scrapes the `server` as the
  `po11y-server` job. `observability/prometheus.yml` had no such job, so on
  `docker-compose.yml` the five po11y series existed nowhere in Prometheus and
  every rule in `observability/alerts.yml` was inert there.
- `bootstrap.sh` deletes the retired `maps` and `status-publish`
  workflows from a live n8n on the next run. Without that, an upgraded
  deployment kept running both — `status-publish` writing to a volume that is
  no longer mounted, and `maps` making scheduled LLM calls alongside the
  server's own ai-map builder.
- Bootstrap's OmniRoute auto-wiring writes `AI_MAP_BASE_URL`,
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
  six jobs at the time, including `sync-check`; the consolidation dropped it to five —
  see below.)
- A missing or unreadable `/config.json` now says so in the dashboard lede
  instead of silently falling back to built-in defaults and rendering an empty
  page.
- The Mode B quickstart creates `config.json` before the first `up`. Both
  compose files bind-mount it, so without that step docker created a
  *directory* of that name and the dashboard came up blank.

### Removed

- One mode, not two: the collector daemon (`collector/`) is
  deleted. The `server` process now owns polling, the feeds, and `/metrics`
  for every deployment (see above); n8n needs no po11y workflows installed.
- Mode A's Code-node publisher workflows (`workflows/core/`),
  `tools/sync-workflows.mjs`, and `deploy/nginx/feeds-files.conf` are
  deleted. The dashboard's feeds always come from the server, proxied by
  nginx — there is no file-served alternative any more.
- `FEED_SOURCE` and the shared `po11y_status` volume are gone.
  There is one feed path now, not a switch between two.
- **`bootstrap.sh` now mints an n8n API key.** The deleted publisher
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
- **Privileges that outlived their features.** The bundled stack no
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
- `ai-map-cli.sh` is deleted. It read and wrote the AI map inside the
  n8n container through a mount that no longer exists, so it could not run at
  all. The server owns the map; force a rebuild with the **Build maps now**
  action or `docker kill -s HUP po11y-server`, and drive a local model by
  pointing `AI_MAP_BASE_URL` at Ollama or any OpenAI-compatible endpoint.
- The `Po11y example - HN notify` demo workflow is deleted and
  `HN tech news` no longer calls it. Its Code node wrote
  `/po11y-status/notifications.json`. With that volume unmounted the write did
  not fail — it landed in the container filesystem, where nothing reads it — so
  the demo went on reporting success while publishing nothing. Removing the
  `fs` builtin turns the same call into a hard error, which is why the entry
  above asks you to re-run `./bootstrap.sh`. The server is the only writer of
  the notifications feed; an n8n workflow cannot publish into it.
- `docs/video/` and `docs/intro.mp4` removed and stripped from history. The
  rendered video was 25 MB of a 78 MB clone, and the renderer it was built with
  is not MIT-licensed, so it does not belong in an MIT repo's dependency tree.
  That source lives in a separate repository; the rendered video is uploaded to
  GitHub as a markdown attachment the README embeds, so it costs the clone
  nothing.
- `docs/superpowers/` (local planning output) removed and stripped from history.

[0.1.0]: https://github.com/LabRise-Consulting/po11y/releases/tag/v0.1.0

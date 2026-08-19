# po11y architecture

Po11y runs one process, `server`, in every deployment. It polls (and
optionally ingests) n8n executions into its own SQLite store, and serves the
dashboard's feeds — status, map, forms, ai-map and notifications — directly
from that store. It also serves `/metrics` for Prometheus, the MCP endpoint
(`/mcp/`), and the Data Table read proxy (`/n8n-table/`), and it is the
process that pushes alerts to `ALERT_WEBHOOK_URL` and pings
`ALERT_HEARTBEAT_URL`.

**The server is not optional.** It is load-bearing for every deployment:

- nginx routes `/mcp/`, `/n8n-table/` and every feed to it, so stopping the
  server takes the dashboard, the MCP endpoint and the Data Table read proxy
  down with it. CI asserts all three.
- it is the alert pusher and the heartbeat sender — `ALERT_WEBHOOK_URL` and
  `ALERT_HEARTBEAT_URL` are configured on this service and nowhere else.
- it is the only source of `po11y_workflow_errors_total` and the other four
  Prometheus series Grafana and the alerting rules depend on.

n8n needs no po11y workflows installed: the server talks to n8n's public
REST API read-only, the same way regardless of which compose file starts it.

## Bringing it up

The server is part of the base compose files, not an overlay:

```sh
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.readonly.yml up -d
```

It builds its own store (`po11y_store`, a named volume — never a bind
mount) and talks to n8n's public API read-only.

## Environment

| Variable | Default | Description |
|---|---|---|
| `N8N_API_URL` | *(required)* | Base URL of the n8n instance the server polls. Where this process **sends** requests. |
| `N8N_PUBLIC_URL` | *(falls back to `N8N_API_URL`)* | Base URL a reader **opens**, used for every link po11y hands out: MCP tool results, watchdog notifications, webhook pushes. On the bundled stack the two differ — the server polls `http://n8n:5678` over the compose network, an address that resolves nowhere else — so the bundled compose file defaults this to `http://${BIND_ADDR}:5678`, the same address n8n builds its own `WEBHOOK_URL` from. Set it explicitly behind a reverse proxy or a tunnel. Never fetched; it names the n8n host by design and so is exempt from the outbound-target guard. |
| `N8N_API_KEY` | *(required on the read-only stack)* | A public-API key on that n8n, used GET-only. The bundled stack's compose file maps `MCP_N8N_API_KEY` (falling back to `N8N_API_KEY`) onto it, and `bootstrap.sh` mints a read-only key into `MCP_N8N_API_KEY` when it is empty, so a default bundled stack has one. Should both be empty — you cleared them, or the mint failed — the server starts in **serving-only** mode: no sync, no poll, no feed build. `/mcp`, `/n8n-table` and the feed routes still answer, but the MCP ops tools report `unavailable` and the feed tools report not-built rather than an empty result. |
| `SERVER_SYNC_INTERVAL` | `600` | Seconds between workflow-definition syncs (name/active state). Measured from the end of the previous sync, not its start: ticks never overlap. |
| `SERVER_SYNC_RETRY_INTERVAL` | `15` | Seconds the sync waits after a **failed** tick, instead of `SERVER_SYNC_INTERVAL`. The first sync fires as the process starts, which on a cold `bootstrap.sh` is while n8n is still migrating, and compose restarts n8n again part-way through; without a shorter retry either miss leaves `map.json` and `ai-map.json` empty for the next ten minutes on an otherwise healthy install. A successful sync always returns to the full interval, so this never becomes the cadence. Clamped to `SERVER_SYNC_INTERVAL`. |
| `SERVER_POLL_INTERVAL` | `30` | Seconds between execution poll-fills, measured the same way. Each poll makes two GETs — the finished window, and a second listing of the still-running executions, which n8n omits from the first. The interval is therefore also the resolution of the live-run view: a workflow shorter than one interval can start and finish between two polls, so it is counted but never seen running, and the watchdog's `stuck` rule cannot see it either. |
| `EXECUTIONS_LIMIT` | `250` | Recent-executions window fetched per poll. The default is n8n's API cap, because the window bounds every count the dashboard shows and a smaller one only creates blind spots — see docs/configuration.md "Sizing the executions window". |
| `N8N_TIMEOUT_MS` | `30000` | Deadline on one call to n8n. A tick re-arms only after the previous one settles, so a request without a deadline would stop the sync or poll loop for good. |
| `PO11Y_RETENTION_DAYS` | `30` | Executions (and data-table-count samples, if any) older than this are pruned. |
| `PO11Y_PACK` | *(empty)* | Path to an [expectation pack](#writing-an-expectation-pack) (empty = no expectations evaluated). The shipped example, `server/packs/example.json`, watches execution health plus one named data table — point at it explicitly (`PO11Y_PACK=/app/server/packs/example.json`) to use it as-is, or copy it as the starting point for your own. |
| `PO11Y_SCOPE` | `default` | The scope key this server answers for at `/status/<scope>/…`. Must match nginx's scope charset `[a-z0-9-]+`. |
| `PO11Y_INGEST_TOKEN` | *(empty)* | Bearer token that enables `POST /ingest`. Empty = disabled (poll-fill only) — see [Push versus poll](#push-versus-poll). |
| `PO11Y_DATATABLES` | *(empty)* | Comma-separated data-table **names** to sample a row count for every poll-fill tick — see [below](#po11y_datatables-data-table-row-count-sampling). Empty = sampling off. |
| `AI_MAP_BASE_URL` / `AI_MAP_API_KEY` / `AI_MAP_MODEL` | *(empty)* | Architecture-map LLM annotation (see `.env.example`); all three or none. |
| `AI_MAP_MAX_TOKENS` | `16000` | Budget for the annotation call. Reasoning models spend it on thinking as well as on the answer, so too small a budget returns a reply cut off mid-string — logged as `LLM answer truncated at max_tokens`, after which the map keeps its heuristic text. The answer also grows with the instance: it carries one line per node plus a summary per workflow. A ceiling is not a spend, so the default clears a large map rather than fitting a small one. |
| `ALERTS_ENABLED` | `true` | Evaluate the watchdog rules against the store and publish the verdicts to `notifications.json`. This service also **delivers** them — see the push and heartbeat rows below. |
| `ALERT_STALE_AFTER_MIN` / `ALERT_STUCK_AFTER_MIN` | `0` / `0` | Off by default; see `.env.example`'s watchdog section. |
| `ALERT_MIN_ERRORS` / `ALERT_ERROR_RATE` | `3` / `0.5` | The `failing` rule's floors — both must be cleared. |
| `ALERT_IGNORE` | *(empty)* | Comma-separated workflow names/ids excluded from every rule. |
| `ALERT_RULES_FILE` | *(empty)* | Optional JSON file for per-workflow budgets, read by `server/alert-config.mjs`. **Not passed through by either compose file** — setting it in `.env` has no effect until a compose file maps it onto the server's environment. This is a known gap, not a deliberate omission. |
| `ALERT_RENOTIFY_MIN` | `360` | Minutes before an alert that is still true is repeated. `0` says it once only. Also gates expectation-pack re-firing. |
| `ALERT_FEED_MAX` | `50` | Maximum entries kept in `notifications.json`. |
| `ALERT_WEBHOOK_URL` | *(empty)* | Outbound alert push. Empty = alerts only land in `notifications.json`. **Set it here and nowhere else** — a second pusher delivers every alert twice. A credential: logged as scheme + host only. |
| `ALERT_WEBHOOK_FORMAT` | `slack` | One of `slack`, `discord`, `telegram`, `raw`. A value outside that list disables push with a logged error rather than posting the wrong shape. |
| `ALERT_TELEGRAM_CHAT_ID` | *(empty)* | Required only when `ALERT_WEBHOOK_FORMAT=telegram`; without it push is disabled. |
| `ALERT_WEBHOOK_TIMEOUT_MS` | `10000` | Deadline on one webhook POST. |
| `ALERT_HEARTBEAT_URL` | *(empty)* | Dead-man switch: GET after every **successful sync**. Also a credential, redacted the same way. Serving-only mode never syncs, so a heartbeat configured there can never ping — the server says so at boot. |
| `ALERT_HEARTBEAT_TIMEOUT_MS` | `10000` | Deadline on one heartbeat ping. A failed ping is logged and ignored. |
| `N8N_READ_API_KEY` | *(empty)* | The data-table read key. Serves the `/n8n-table/` proxy (nginx routes to the server rather than injecting the key itself) and the MCP content tools. Scope it to *data-table row: read* — on n8n CE an API key cannot be scoped, so the server's own allowlist is what keeps it read-only-to-data-tables. Empty = both are off. |
| `PROMETHEUS_URL` | *(empty)* | MCP `po11y_promql` source. Compose sets `http://prometheus:9090` on both compose files. |
| `GRAFANA_URL` / `GRAFANA_SA_TOKEN` / `GRAFANA_DATASOURCE_UID` | *(empty)* / *(empty)* / `n8n-postgres` | MCP `po11y_sql` source, bundled stack only (`MCP_GRAFANA_URL=` switches it off). The read-only stack provisions no Postgres datasource, so the tool is off there by construction. |
| `CONFIG_PATH` | `/app/config.json` | Where the MCP content tools read the dashboard's dataset definitions. Read once at boot; no live reload. Hardcoded in both compose files, not host-configurable. |
| `PO11Y_MAX_BODY_BYTES` | `1000000` | Request-body cap shared by every route the server serves, `/mcp` and `/ingest` included. There is no MCP-specific body variable. |

Three more variables are hardcoded via the server's `Dockerfile` (`ENV
PO11Y_DB=/data/po11y.db PORT=8081 BIND_HOST=0.0.0.0`) and are not read from
the host `.env` or set by either compose file: `PO11Y_DB`, `PORT`,
`BIND_HOST`. There is no supported way to override them short of a custom
image.

One more variable lives on the **dashboard** service, not the server — nginx
proxies every feed request to the server unconditionally, and this is only
where:

| Variable | Default | Description |
|---|---|---|
| `FEED_UPSTREAM` | `http://server:8081` | Upstream the dashboard's feed proxy targets. Whitelisted to `scheme://host[:port]`, same rule as `FORM_PROXY_UPSTREAM`. |

## Accepted regressions

Two behaviors changed when the project collapsed onto the server as the
single feed source, and neither is coming back:

**The dashboard's container card is gone, permanently.** The old
`status.json.containers` section came from a docker-socket Code node that
does not exist any more. The socket mount and the `docker-proxy` sidecar it
went through were removed with it, rather than kept alive for a feature that
is not coming back. The server has no equivalent and is not getting one:
restoring it would mean giving po11y a container runtime socket again, which
is a separate feature with its own security argument (see
[docs/security.md](security.md)). There is no workaround.

**`po11y_workflow_errors_total` restarts from zero on a fresh store.** The
counter is persisted in SQLite and is monotonic across restarts (see
[docs/configuration.md](configuration.md#prometheus-metrics) for the full
rationale), but a brand-new store — first boot, or a restore from an older
backup — starts that table empty. Prometheus reads that as a genuine counter
reset. It is one, and Prometheus handles it correctly; do not "fix" it with
a `max()` guard.

## Push versus poll

n8n's log-streaming event destinations (the feature `POST /ingest` exists
to receive) are Enterprise-licensed. On an instance without that licence the
destination routes 404 rather than 401, consistent with the router not being
mounted at all; `/rest/settings` reports the enterprise flags, so it tells you
which case you are in. **Push is therefore unavailable on a Community
instance, and poll-fill (`SERVER_POLL_INTERVAL`) is the operative path**
there — it is what keeps the store current, not a fallback.

The ingest path is not dead code: a licensed n8n with log streaming enabled
can use it. To wire it up on an instance that has the feature:

1. Set `PO11Y_INGEST_TOKEN` to a random secret on the server service.
2. In n8n, add an HTTP log-streaming destination pointing at
   `http://<server-host>:8081/ingest`.
3. Set the destination's `Authorization` header to `Bearer <the same token>`.

`POST /ingest` is otherwise a 404, not a 401 — an unconfigured token means
the endpoint does not exist, so it never advertises a write surface that
was never turned on. A pushed event is deliberately **not** treated as
authoritative: poll-fill re-reads the same execution from n8n's API on its
own schedule regardless, because push is for latency and poll is for
truth.

## `PO11Y_DATATABLES` (data-table row-count sampling)

An execution can succeed and still write nothing. Execution-based
expectations see that a workflow *ran*, not that it produced rows, so
"succeeded while writing zero rows" can go unnoticed for days — the run
history looks healthy throughout. `PO11Y_DATATABLES` closes that gap: set it to a
comma-separated list of data-table **names** (the same names n8n's UI
shows, not internal ids) and, on every poll-fill tick, the server records
one row-count sample per table in the `datatable_counts` series. An
expectation pack can then watch a windowed delta over that series — see
[Writing an expectation pack](#writing-an-expectation-pack) below.

```sh
PO11Y_DATATABLES=orders,order_items
```

**Requires the data-table read scope** on `N8N_API_KEY`. A key scoped this
narrowly may 403 on workflows/executions — that only matters if the same
key also serves sync (it usually shouldn't; a scoped read-only key for
sampling and a wider key for sync is the safer split). Sampling degrades
per target, not instance-wide: an unresolvable name, a stale id, or a
transient error fetching one table's rows is logged and skipped so it
cannot take down the executions poll it rides on or the samples for the
other configured tables.

**Paging, not a total.** n8n's Data Table API (`/api/v1/data-tables` and
`/api/v1/data-tables/{id}/rows`) does not return a total row count on the
probed build (n8n 2.29.8) — no `count`/`total` field, no
`X-Total-Count`/`Content-Range` header. Counting a table means paging every
`rows` page (capped at `limit=250` per page) and summing lengths. This is
capped at 40 pages (~10,000 rows) per sample per poll tick — a table past
that ceiling still gets a sample, but it is the capped value, logged as
such, not silently short. (If a future n8n build *does* return a `count`
field on the first page, the implementation trusts it and skips paging —
see the comment at the top of `server/datatables.mjs`.)

**One-day warm-up.** A growth expectation's delta needs two samples that
straddle its window; until then the query returns `NULL`, which
`min-count` treats as `0` and reports as a failure. That is one loud day,
not a silently-passing one — see the note at the end of the next section.

## Writing an expectation pack

A pack is a JSON file (`PO11Y_PACK`) of expectations evaluated against the
store on every rebuild, each producing a feed-shaped notification on
failure. Two kinds ship:

- `max-age-minutes` — the query's first value is a timestamp; fails if it
  is older than `maxAgeMinutes` (or missing).
- `min-count` — the query's first value is a number; fails if it is below
  `min`.

Each kind needs its own threshold (`min`, `maxAgeMinutes`), and a pack that
omits one does not load. A misspelled key would otherwise compare against
`undefined`, which is false for every value: a permanent failure that no data
can clear, reported on every rebuild.

Both accept an optional `windowMinutes`. **Every count expectation must be
windowed.** An unwindowed `SELECT COUNT(*) FROM executions WHERE
status='success'` over an accumulating store is true forever after the
first success — exactly the silent-green failure this feature exists to
catch. When `windowMinutes` is present the SQL must contain exactly one
`?`, bound from JavaScript to `now - windowMinutes` as an ISO-8601 string
(not SQLite's `datetime('now')`, which does not render in the same format
as the stored `2026-08-11T02:00:00.000Z` stamps — a SQL-side comparison
would silently compare unlike strings).

The shipped pack (`server/packs/example.json`) is a working example —
four expectations, all windowed to 26 hours (a day plus slack, so a
missed-by-an-hour run does not false-positive):

```json
{
  "name": "at least one successful execution in the last 26 hours",
  "kind": "min-count",
  "min": 1,
  "windowMinutes": 1560,
  "sql": "SELECT COUNT(*) FROM executions WHERE status = 'success' AND started_at >= ?"
}
```

A pack's SQL is trusted operator input, but "trusted" is not "unchecked":
it must be a single `SELECT`/`WITH` statement and runs on a **read-only**
database handle, so a mistyped or malicious statement cannot mutate the
store. Do not accept packs over the network.

**A data-table growth expectation** — `min-count` over a row-count delta
(`SELECT (latest sample) - (sample at or before the window start)`) — is
the fourth expectation in the shipped pack, watching `orders`:

```json
{
  "name": "orders grew in the last 26 hours",
  "kind": "min-count",
  "min": 1,
  "windowMinutes": 1560,
  "sql": "SELECT (SELECT rows FROM datatable_counts WHERE key = 'orders' ORDER BY sampled_at DESC LIMIT 1) - (SELECT rows FROM datatable_counts WHERE key = 'orders' AND sampled_at <= ? ORDER BY sampled_at DESC LIMIT 1)"
}
```

It only produces samples to watch when `PO11Y_DATATABLES` includes
`orders` (see the section above). It carries a one-day warm-up: until
two samples straddle the window the delta query returns `NULL`, which
`min-count` treats as `0` and reports as a failure. That is deliberate —
one loud day rather than a silently-passing one, because "no baseline yet"
and "genuinely zero growth" are both conditions an operator wants to see,
not conditions to special-case away.

## Backup

The store is a **new backup surface** — nothing that ships with po11y
already covers it. An existing n8n backup almost certainly does not: a
`pg_dump` job covers n8n's own Postgres database, not this SQLite file. Treat
`po11y_store` as needing its own job from day one.

`VACUUM INTO` is the mechanism, not a plain file copy:

```sh
docker compose exec -T server \
  node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.PO11Y_DB).exec(\"VACUUM INTO '/data/po11y-backup.db'\")"
docker run --rm -v po11y_store:/data -v "$PWD":/out alpine \
  sh -c 'cp /data/po11y-backup.db /out/po11y-$(date +%F).db'
```

`VACUUM INTO` rather than `sqlite3 .backup`: the server image has no
`sqlite3` binary, only `node:sqlite`. `VACUUM INTO` rather than copying the
`.db` file directly: a live WAL makes a plain file copy inconsistent —
`VACUUM INTO` always yields a clean, single-file snapshot regardless of
in-flight writes.

**Ready-to-cron path:** [`scripts/backup-store.sh`](../scripts/backup-store.sh)
wraps this sequence (VACUUM INTO inside the container, then copied out via
`docker compose cp` rather than a second `docker run`, so it never needs to
know the runtime-prefixed volume name):

```sh
./scripts/backup-store.sh /path/to/backups
```

Add it to cron from the repo root:

```
0 3 * * * cd /path/to/po11y && ./scripts/backup-store.sh /path/to/backups >>/path/to/backups/backup.log 2>&1
```

## Multi-scope deployments

A single file-served volume used to let several publishers share one
dashboard: each wrote its own `/status/<scope>/…` subdirectory, and nginx
served whichever one a request asked for. The server does not work that way.

**One server answers for exactly one `PO11Y_SCOPE`.** It 404s every other
scope at `/status/<scope>/…`. A dashboard with several publishers behind
`config.json`'s `scopes` therefore needs one `server` service per scope —
each with its own `po11y_store` volume and its own `PO11Y_SCOPE` — all
routed to by the same nginx. There is no scope-aware single server, and none
is planned; running one `server` per scope is the supported shape for a
multi-scope deployment.

## Related, unmoved

- Grafana and Prometheus are separate services; the server does not
  provision or manage them.
- `config.json` is served from disk, read once at boot by both nginx and
  the server's MCP content tools.
- The dashboard UI does not distinguish which compose file is running —
  same five feeds, same shape, from the server either way.

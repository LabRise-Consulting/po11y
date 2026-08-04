# MCP server

Po11y ships a read-only [MCP](https://modelcontextprotocol.io) server so an
agent can ask a running instance what's broken, what a workflow looks like,
and what its data feeds contain — without ever seeing what flowed through a
workflow. It speaks MCP over streamable HTTP (revision `2025-06-18`) at
`/mcp/`, on the same origin as the dashboard, so it sits behind whatever auth
the dashboard already has (Basic Auth, or the [forward-auth](forward-auth.md)
overlay). The `mcp` container itself has no login of its own and is never
published to the host — nginx is the only way in.

`tools/list` returns monitoring tools first, content tools second: Po11y is a
monitoring stack that happens to also show some workflow output, and that's
the order an agent scans.

## Tools

| tool | what it answers | source |
|---|---|---|
| `po11y_incidents` | Ranked open problems from the watchdog: failing, stale, stuck and unreachable workflows. | feeds |
| `po11y_graph` | The dependency graph — instance-wide, or a slice of hops around one workflow/node. | feeds |
| `po11y_executions` | Recent execution history, filterable by workflow and status. | n8n |
| `po11y_failure` | Why one execution failed: the failing node, its error, timing, and payload shapes. | n8n |
| `po11y_workflow` | One workflow's health card: active state, recent error rate, graph neighbours. | n8n (neighbours also need feeds) |
| `po11y_promql` | Raw PromQL against the stack Prometheus, for trends the curated tools don't cover. | prometheus |
| `po11y_sql` | One read-only `SELECT` against n8n's own database. Mode A only. | grafana |
| `po11y_datasets` | Which content datasets this instance publishes, and what each field means. | `config.json` (works with no source; `rows_available` reports whether datatables is up) |
| `po11y_rows` | Filtered, sorted rows from one dataset. | datatables |
| `po11y_row` | One dataset row in full, including its parsed detail rows. | datatables |

Alongside the tools, five MCP resources expose the dashboard's own feeds
(`po11y://feeds/status.json`, `notifications.json`, `map.json`, `ai-map.json`,
`forms.json`) so an agent can pull one whole rather than reconstruct it from a
tool call.

## Which sources each mode has

| source | Mode A | Mode B | turned on by |
|---|---|---|---|
| feeds | always | always | `STATUS_DIR` — defaults to `/po11y-status`, the shared volume both compose files mount read-only into the `mcp` service |
| prometheus | always | always | `PROMETHEUS_URL` — defaults to `http://prometheus:9090` internally; nothing to set |
| n8n | opt-in | always | `MCP_N8N_API_KEY` in Mode A (mint one in n8n → Settings → n8n API; the server only ever GETs). Mode B reuses the collector's own `N8N_API_URL`/`N8N_API_KEY`, since that key already exists. |
| grafana | on by default | never | Mode A's `mcp` service points `GRAFANA_URL` at Grafana internally, so `po11y_sql` is available out of the box, independent of `MCP_GRAFANA_SA_TOKEN`. That token only matters when anonymous Grafana Viewer access is off (`DASHBOARD_GRAFANA_EMBED=false`); without it the tool still reports itself available but a query fails with a 401. Turn the source off with `MCP_GRAFANA_URL=` (empty) in `.env`. Mode B's compose file never sets `GRAFANA_URL`, so the tool is unavailable by construction, not by configuration. |
| datatables | opt-in | opt-in | `N8N_READ_API_KEY` — the same read-scoped key (`data-table row: read`) the dashboard's `/n8n-table/` proxy uses |

A source that's missing doesn't make its tools vanish from `tools/list` — they
still appear, and calling one returns a structured `unavailable` answer naming
the env var that would turn it on. A monitoring tool silently returning an
empty result where it meant "I cannot see this" is the failure mode Po11y
avoids everywhere else, so the MCP server doesn't introduce it either.

## Client configuration

```json
{
  "mcpServers": {
    "po11y": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp/",
      "headers": { "Authorization": "Basic <base64 of user:password>" }
    }
  }
}
```

Drop the `headers` block if `DASHBOARD_BASIC_AUTH` is unset (fine on a
loopback bind); point `url` at wherever `BIND_ADDR`/`DASHBOARD_PORT` actually
serve the dashboard otherwise.

## The payload policy

`po11y_failure` returns the failing node, its error message and the *shape*
of the data at that point — `object, 4 keys`, `array, 12 items` — never the
data itself, plus a link to open the execution in n8n. The same rule holds
for every tool except two, both deliberate: n8n execution data holds whatever
the workflows touched — API responses, customer records, message bodies — and
none of that belongs in a model's context by default. `po11y_rows` strips the
detail payload each dataset row carries for the same reason.

The two exceptions: `po11y_row` deliberately returns one dataset row in full
— reading a row is the point of a content tool — and `po11y_sql` runs
whatever `SELECT` you write against n8n's live database, so it returns
exactly the columns and rows that statement asks for, execution payloads
included if you query for them. See the next section.

## Why `po11y_sql` is Mode A only

`po11y_sql` runs through Grafana's `/api/ds/query` datasource proxy, not a
Postgres driver — Po11y has zero runtime dependencies, which rules out a wire
protocol client. Mode A already provisions a Grafana datasource against n8n's
own Postgres (`observability/grafana/provisioning/datasources/datasources.yml`,
uid `n8n-postgres`) for the four Mode A alert rules to query, so SQL travels
as plain HTTP JSON through a datasource that already exists — no new database
role, password, or driver. Mode B has no such datasource, so the tool is off
there by construction.

The read-only guard (`assertSelect`) checks statement *shape* only — one
`SELECT`, no stacked statements, no `INTO` — not which tables or columns it
touches. That makes this full read access to n8n's database, including
`execution_data` and `credentials_entity`, and in Mode A it is on by default.
Set `MCP_GRAFANA_URL=` (empty) in `.env` to turn the source — and so the tool —
off. See [docs/security.md](security.md) for the trade-off and why it's
accepted.

## The `startedAt` NULL trap

`execution_entity."startedAt"` is `NULL` until an execution actually starts —
a queued run has only `createdAt`. Every bundled tool that reports a start
time already falls back to `startedAt || createdAt` (and the Mode A alert
rules guard the same column with `IS NOT NULL`), so if you write your own
query through `po11y_sql` and filter or sort on `startedAt`, queued and
not-yet-started executions silently disappear from the result. Filter on
`createdAt` when what you mean is enqueue time.

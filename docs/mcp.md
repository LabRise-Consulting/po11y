# MCP server

Po11y includes a read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io) endpoint. It allows AI agents to query instance status, workflow structures, and data feeds without exposing execution payload data.

The MCP endpoint is a route (`/mcp`) served by the po11y `server` process — the same process that runs the store, feeds, and the `/n8n-table` proxy — not a separate container. It answers at `/mcp/` on the same host as the dashboard and uses the dashboard's authentication setup (Basic Auth or OIDC forward-auth), so nothing changes for clients.

## Available tools

`tools/list` returns monitoring tools first, followed by content tools.

| Tool | Description | Data Source |
|---|---|---|
| `po11y_incidents` | Lists active issues: failing, stale, stuck, and unreachable workflows. | Status feeds |
| `po11y_graph` | Returns the workflow dependency graph or a subtree around a specific node. | Status feeds |
| `po11y_executions` | Returns recent execution history, filterable by workflow and status. A `status` filter returns a slice, not a rate — see [Reading the answers](#reading-the-answers). | po11y store |
| `po11y_failure` | Returns failure details for an execution: failing node, error message, and payload data shapes. | n8n API |
| `po11y_workflow` | Returns a workflow's health summary: active state, recent error rate, and graph neighbors. | po11y store & feeds |
| `po11y_promql` | Runs raw PromQL queries against Prometheus. | Prometheus |
| `po11y_sql` | Runs a read-only `SELECT` query against n8n's Postgres database (bundled stack only). | Grafana datasource |
| `po11y_datasets` | Lists available content datasets and field definitions from `config.json`. | `config.json` |
| `po11y_rows` | Returns filtered, sorted rows from a dataset. | Data Tables proxy |
| `po11y_row` | Returns a single dataset row with detailed fields. | Data Tables proxy |

Five MCP resources expose dashboard feed files:
- `po11y://feeds/status.json`
- `po11y://feeds/notifications.json`
- `po11y://feeds/map.json`
- `po11y://feeds/ai-map.json`
- `po11y://feeds/forms.json`

## Source support

| Data Source | Availability | Configuration Requirement |
|---|---|---|
| **feeds** | Always | No configuration: the server publishes the feeds itself, from its own store. Reports unavailable until the first feed build completes (the stamp survives a restart, so a warm store counts as built). |
| **po11y store** | Depends on the ops key | Filled by the server's sync and poll loops, so it needs the same key the **n8n** row does. Always set on the read-only stack (`N8N_API_KEY` is required there); on the bundled stack `bootstrap.sh` mints one, so it is on unless you clear it. |
| **prometheus** | Always | Uses internal `PROMETHEUS_URL` (defaults to `http://prometheus:9090`). |
| **n8n** | Depends on the ops key | The bundled stack maps `MCP_N8N_API_KEY` onto the server's `N8N_API_KEY`, and bootstrap mints one when it is empty; the read-only stack requires `N8N_API_KEY` directly, so this source is always on there. |
| **grafana** | Bundled stack only | Uses `GRAFANA_URL`. Set `MCP_GRAFANA_URL=` to disable. Unavailable on the read-only stack, which provisions no Postgres datasource. |
| **datatables** | Opt-in | Requires `N8N_READ_API_KEY`. |

Without `MCP_N8N_API_KEY` — you cleared it, or bootstrap could not mint one — the server runs serving-only: it arms no sync or poll timer, so nothing fills the store and no feed build ever runs. The ops tools then answer `unavailable` and the feed tools answer not-built. Neither ever answers with an empty result — an empty execution list or a `0 open incidents` count would read as a healthy instance.

If a data source is missing, calling its associated tool returns a structured `unavailable` message naming the required configuration variable.

## Client configuration

```json
{
  "mcpServers": {
    "po11y": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp/",
      "headers": {
        "Authorization": "Basic <base64-user:password>"
      }
    }
  }
}
```

Omit `headers` if `DASHBOARD_BASIC_AUTH` is not set.

## Data privacy policy

- `po11y_failure` returns data structure shapes (e.g. `object, 4 keys` or `array, 12 items`) and error text, never raw payload content.
- Execution payload contents are excluded from tool responses to prevent sensitive data from entering LLM context.
- **Exceptions**: `po11y_row` returns full row data for specified content datasets. `po11y_sql` returns row results for explicit `SELECT` queries against non-sensitive tables.

The rule is a po11y policy, not a dead end. When the payload itself is what an
investigation needs, `po11y_failure` names the two ways to it: the `link` it
returns, and n8n's own MCP server, whose `get_execution` returns the whole run
under the operator's credentials rather than po11y's read-only key.

## Reading the answers

Two shapes of question mislead an agent that reads only the numbers, so the
tools answer them in words:

- **A filter is not a rate.** `po11y_executions {status: "error"}` returns rows
  that are all errors by construction. Its summary therefore refuses to offer a
  denominator, and the response echoes the `filters` it applied. Omit `status`
  to learn how often runs actually fail — or read `error_rate` from
  `po11y_workflow`, which is scoped to one workflow and never filtered.
- **Old is not current.** The newest matching row can be days stale — the normal
  case for an error filter on an instance that has since recovered. Every
  `po11y_executions` response carries `newest_started_at` and
  `newest_age_seconds`, and states the age in its summary. `po11y_incidents`
  carries `feed_age_seconds` for the same reason: report the age alongside the
  finding, or a two-day-old failure reads as an outage in progress.

## `po11y_sql` details (bundled stack only)

`po11y_sql` queries n8n's Postgres database using Grafana's `n8n-postgres` datasource (`/api/ds/query`).

- **Database role**: Connects using `po11y_ro`, a read-only role created by `bootstrap.sh`.
- **Denied tables**: `credentials_entity` and `execution_data` tables are blocked at the database layer.
- **Statement validation**: Accepts single `SELECT` statements only. Rejects multi-statement queries and `SELECT INTO` commands.

### Querying `execution_entity`

`execution_entity."startedAt"` is `NULL` for queued executions until execution begins. Use `createdAt` or `startedAt || createdAt` when filtering or sorting queued executions by timestamp.

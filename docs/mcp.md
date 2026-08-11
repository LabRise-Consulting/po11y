# MCP server

Po11y includes a read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server. It allows AI agents to query instance status, workflow structures, and data feeds without exposing execution payload data.

The MCP server runs at `/mcp/` on the same host as the dashboard and uses the dashboard's authentication setup (Basic Auth or OIDC forward-auth).

## Available tools

`tools/list` returns monitoring tools first, followed by content tools.

| Tool | Description | Data Source |
|---|---|---|
| `po11y_incidents` | Lists active issues: failing, stale, stuck, and unreachable workflows. | Status feeds |
| `po11y_graph` | Returns the workflow dependency graph or a subtree around a specific node. | Status feeds |
| `po11y_executions` | Returns recent execution history, filterable by workflow and status. | n8n API |
| `po11y_failure` | Returns failure details for an execution: failing node, error message, and payload data shapes. | n8n API |
| `po11y_workflow` | Returns a workflow's health summary: active state, recent error rate, and graph neighbors. | n8n API & feeds |
| `po11y_promql` | Runs raw PromQL queries against Prometheus. | Prometheus |
| `po11y_sql` | Runs a read-only `SELECT` query against n8n's Postgres database (Mode A only). | Grafana datasource |
| `po11y_datasets` | Lists available content datasets and field definitions from `config.json`. | `config.json` |
| `po11y_rows` | Returns filtered, sorted rows from a dataset. | Data Tables proxy |
| `po11y_row` | Returns a single dataset row with detailed fields. | Data Tables proxy |

Five MCP resources expose dashboard feed files:
- `po11y://feeds/status.json`
- `po11y://feeds/notifications.json`
- `po11y://feeds/map.json`
- `po11y://feeds/ai-map.json`
- `po11y://feeds/forms.json`

## Source support by mode

| Data Source | Mode A | Mode B | Configuration Requirement |
|---|---|---|---|
| **feeds** | Always | Always | Requires `STATUS_DIR` (defaults to `/po11y-status`). Reports unavailable if feed files do not exist. |
| **prometheus** | Always | Always | Uses internal `PROMETHEUS_URL` (defaults to `http://prometheus:9090`). |
| **n8n** | Opt-in | Always | Requires `MCP_N8N_API_KEY` in Mode A. Mode B reuses `N8N_API_KEY`. |
| **grafana** | Enabled | Unavailable | Mode A uses `GRAFANA_URL`. Set `MCP_GRAFANA_URL=` to disable. Unavailable in Mode B. |
| **datatables** | Opt-in | Opt-in | Requires `N8N_READ_API_KEY`. |

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

## `po11y_sql` details (Mode A only)

`po11y_sql` queries n8n's Postgres database using Grafana's `n8n-postgres` datasource (`/api/ds/query`).

- **Database role**: Connects using `po11y_ro`, a read-only role created by `bootstrap.sh`.
- **Denied tables**: `credentials_entity` and `execution_data` tables are blocked at the database layer.
- **Statement validation**: Accepts single `SELECT` statements only. Rejects multi-statement queries and `SELECT INTO` commands.

### Querying `execution_entity`

`execution_entity."startedAt"` is `NULL` for queued executions until execution begins. Use `createdAt` or `startedAt || createdAt` when filtering or sorting queued executions by timestamp.

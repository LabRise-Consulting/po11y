# Alerting

Po11y offers four alerting mechanisms. **Use only one mechanism at a time** to avoid duplicate alerts.

The watchdog, the server push and the heartbeat all run inside the po11y
`server` process, the same way on every deployment. Grafana alerting is the
one mechanism that differs: it needs n8n's own Postgres database, which only
the bundled stack provisions.

## Overview

| Mechanism | Availability | Enabled by default | Target |
|---|---|---|---|
| **Notifications feed** | Always | Yes (`ALERTS_ENABLED=false` disables); needs the ops key on the bundled stack (`MCP_N8N_API_KEY`) to have a store to evaluate | Dashboard Notifications panel |
| **Grafana alerting** | **Bundled stack only** | **Yes** | Webhook (`GRAFANA_ALERT_WEBHOOK_URL`) |
| **Server push** | Always | No | Slack, Discord, Telegram, or raw webhook |
| **Prometheus + Alertmanager** | **Read-only stack only** (opt-in overlay) | No | Webhook |

You can also configure an external **Heartbeat monitoring** service:

| Feature | Availability | Variable | Description |
|---|---|---|---|
| **Heartbeat (dead-man switch)** | Always | `ALERT_HEARTBEAT_URL` | External ping service (such as Healthchecks.io or Uptime Kuma) |

## Data source differences

The bundled stack and a read-only deployment monitor n8n differently:

```
BUNDLED STACK                                READ-ONLY STACK

  ┌────────┐                                    ┌────────┐
  │  n8n   │                                    │  n8n   │   (External)
  └───┬────┘                                    └───┬────┘
      │ database writes                             │ public API (GET requests)
      ▼                                             ▼
  ┌──────────┐   SQL     ┌─────────┐            ┌───────────┐   /metrics   ┌────────────┐
  │ Postgres │ ────────► │ Grafana │            │  server   │ ───────────► │ Prometheus │
  └──────────┘           └────┬────┘            └─────┬─────┘              └──────┬─────┘
                              │                       │                           │
                              ▼                       ▼                           ▼
                           Webhook                   Feed                  Alertmanager
```

- The bundled stack's Grafana rules read directly from n8n's **Postgres database**. In-flight executions appear immediately.
- The server reads from n8n's **public API** during each poll cycle, on every deployment — including the bundled stack, whose own watchdog rules use this path too.

### Key functional differences:
- **Stuck executions**: the bundled stack's Grafana rules detect stuck executions immediately via database queries (`finished = false` without `stoppedAt`). The server derives `po11y_workflow_running_seconds` from API responses during each poll cycle. Both paths alert on stuck workflows.
- **Queue backlog**: the bundled stack's Grafana rules can check queued executions (`status = 'new'`). The server's API poll cannot check queue depth because n8n's public API does not expose it.

## 1. Notifications feed

The Notifications panel displays entries from `notifications.json`.

The po11y `server` writes this feed, from its own store, on by default, on
every deployment. The MCP `po11y_incidents` tool reads the same feed.

- Set `ALERTS_ENABLED=false` to disable. Budget settings `ALERT_STALE_AFTER_MIN` and `ALERT_STUCK_AFTER_MIN` default to `0` (off), so default alerts cover only `failing` and `unreachable` states.
- **Bundled stack**: the server needs its ops key (`MCP_N8N_API_KEY`) to have a store to evaluate. Without it nothing is published, and the tools report that rather than reporting zero incidents.
- The server is the only writer. An n8n workflow cannot publish into this feed: the server serves it from its own store, not from a file on a shared volume.

This feed is displayed only on the dashboard and does not send external notifications.

## 2. Grafana alerting (bundled stack)

Grafana evaluates five rules in `observability/grafana/alerting/rules.yml` every 60 seconds:

| Rule | Condition | Severity |
|---|---|---|
| `Po11yN8nUnreachable` | Prometheus cannot scrape `n8n:5678` for 10 minutes | Critical |
| `Po11yWorkflowFailing` | 3 or more failed executions in 1 hour for a workflow | Warning |
| `Po11yWorkflowStale` | Active workflow with no successful execution in 6 hours | Warning |
| `Po11yWorkflowStuck` | Execution running longer than 1 hour | Warning |
| `Po11yQueueBacklog` | Executions queued longer than 15 minutes | Warning |

To send alerts externally, set `GRAFANA_ALERT_WEBHOOK_URL`. If unset, rules still evaluate and display in the Grafana UI.

Notes:
- Grafana webhooks send Grafana alert JSON. Point `GRAFANA_ALERT_WEBHOOK_URL` to an n8n webhook or configure native Slack, Discord, or Telegram contact points directly in Grafana.
- Four rules query internal n8n database tables (`execution_entity`, `workflow_entity`). Check these rules after upgrading n8n.

## 3. Server push

Configured using `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT` (`slack`, `discord`, `telegram`, or `raw`) on the server service, on every deployment, and on that service only. Configuring a second pusher delivers every alert twice.

The server batches alerts into a single message on each rebuild (triggered by its sync and poll-fill ticks) and re-notifies based on `ALERT_RENOTIFY_MIN` (default `360` minutes). Webhook delivery errors are logged without interrupting the server process.

## 4. Prometheus + Alertmanager

Enable this optional overlay on top of the read-only stack (it hardcodes
`prometheus.readonly.yml`, so it is not compatible with `docker-compose.yml`):

```sh
docker compose -f docker-compose.readonly.yml -f docker-compose.alerts.yml up -d
```

Requires `ALERTMANAGER_WEBHOOK_URL`. Rules in `observability/alerts.yml` query metrics exposed at `server:8081`.

This overlay provides **inhibition**: if an n8n outage occurs, Alertmanager sends a single unreachable notification instead of alerting on every stale or stuck workflow.

Do not combine this overlay with Server Push (`ALERT_WEBHOOK_URL`), as that will produce duplicate notifications.

## 5. Heartbeat monitoring

Set `ALERT_HEARTBEAT_URL` on the server service, on either compose file, to send an HTTP GET request to an external service (such as Healthchecks.io, Uptime Kuma, or Better Stack) after every successful sync — the server's reachability probe against n8n.

If the host machine or server process fails, the external monitoring service detects the missing ping and sends an alert. This can be combined with any alerting mechanism.

The ping rides the sync, so a bundled-stack server left without `MCP_N8N_API_KEY` never syncs and never pings. That fails safe — the monitor goes red — and the server logs the reason at boot.

## Choosing an alerting setup

- **Bundled stack**: Set `GRAFANA_ALERT_WEBHOOK_URL` to receive external alerts. Grafana reads n8n's database directly, so it needs no po11y key.
- **Simple, either deployment**: Set `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT` on the server service (the bundled stack also needs `MCP_N8N_API_KEY`).
- **Read-only stack (advanced)**: Use the Alertmanager overlay for alert deduplication and routing. Leave `ALERT_WEBHOOK_URL` unset.
- **Host failure monitoring**: Add a heartbeat URL (`ALERT_HEARTBEAT_URL`).

## Security

Webhook and heartbeat URLs contain authentication tokens:
- The server logs URLs using scheme and host only, redacting sensitive query parameters and paths.
- Alertmanager reads its webhook URL from a file (`url_file`).
- Grafana embeds `GRAFANA_ALERT_WEBHOOK_URL` at startup without saving it to tracked repository files.

For complete details, see [security.md](security.md).

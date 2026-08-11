# Alerting

Po11y offers four alerting mechanisms. **Use only one mechanism at a time** to avoid duplicate alerts.

Availability depends on your operating mode (Mode A or Mode B) because each mode accesses different data sources.

## Overview

| Mechanism | Mode | Enabled by default | Target |
|---|---|---|---|
| **Notifications feed** | Mode A and B | Mode B: yes (`ALERTS_ENABLED=false` disables); Mode A: no default publisher | Dashboard Notifications panel |
| **Grafana alerting** | **Mode A only** | **Yes** | Webhook (`GRAFANA_ALERT_WEBHOOK_URL`) |
| **Collector push** | **Mode B only** | No | Slack, Discord, Telegram, or raw webhook |
| **Prometheus + Alertmanager** | **Mode B only** | No (opt-in overlay) | Webhook |

You can also configure an external **Heartbeat monitoring** service:

| Feature | Mode | Variable | Description |
|---|---|---|---|
| **Heartbeat (dead-man switch)** | Mode B only | `ALERT_HEARTBEAT_URL` | External ping service (such as Healthchecks.io or Uptime Kuma) |

## Data source differences

Mode A and Mode B monitor n8n differently:

```
MODE A (Bundled stack)                       MODE B (External n8n)

  ┌────────┐                                    ┌────────┐
  │  n8n   │                                    │  n8n   │   (External)
  └───┬────┘                                    └───┬────┘
      │ database writes                             │ public API (GET requests)
      ▼                                             ▼
  ┌──────────┐   SQL     ┌─────────┐            ┌───────────┐   /metrics   ┌────────────┐
  │ Postgres │ ────────► │ Grafana │            │ Collector │ ───────────► │ Prometheus │
  └──────────┘           └────┬────┘            └─────┬─────┘              └──────┬─────┘
                              │                       │                           │
                              ▼                       ▼                           ▼
                           Webhook                Push / feed               Alertmanager
```

- Mode A reads directly from n8n's **Postgres database**. In-flight executions appear immediately.
- Mode B reads from n8n's **public API** during each poll cycle.

### Key functional differences:
- **Stuck executions**: Mode A detects stuck executions immediately via database queries (`finished = false` without `stoppedAt`). Mode B derives `po11y_workflow_running_seconds` from API responses during each poll cycle. Both modes alert on stuck workflows.
- **Queue backlog**: Mode A can check queued executions (`status = 'new'`). Mode B cannot check queue depth because the n8n API does not expose it.

## 1. Notifications feed

The Notifications panel displays entries from `notifications.json`.

- **Mode B**: The collector watchdog writes to this file by default. Set `ALERTS_ENABLED=false` to disable. Budget settings `ALERT_STALE_AFTER_MIN` and `ALERT_STUCK_AFTER_MIN` default to `0` (off), so default alerts cover only `failing` and `unreachable` states.
- **Mode A**: No default workflow writes to this file. See `workflows/examples/hn-notify.json` for an example implementation.

This feed is displayed only on the dashboard and does not send external notifications.

## 2. Grafana alerting (Mode A)

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

## 3. Collector push (Mode B)

Configured using `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT` (`slack`, `discord`, `telegram`, or `raw`).

The collector batches alerts into a single message per poll cycle and re-notifies based on `ALERT_RENOTIFY_MIN` (default `360` minutes). Webhook delivery errors are logged without interrupting collector execution.

## 4. Prometheus + Alertmanager (Mode B)

Enable this optional overlay using:

```sh
docker compose -f docker-compose.readonly.yml -f docker-compose.alerts.yml up -d
```

Requires `ALERTMANAGER_WEBHOOK_URL`. Rules in `observability/alerts.yml` query metrics exposed at `collector:8081`.

This overlay provides **inhibition**: if an n8n outage occurs, Alertmanager sends a single unreachable notification instead of alerting on every stale or stuck workflow.

Do not combine this overlay with Collector Push (`ALERT_WEBHOOK_URL`), as that will produce duplicate notifications.

## 5. Heartbeat monitoring

Set `ALERT_HEARTBEAT_URL` in Mode B to send an HTTP GET request to an external service (such as Healthchecks.io, Uptime Kuma, or Better Stack) after every successful poll.

If the host machine or collector process fails, the external monitoring service detects the missing ping and sends an alert. This can be combined with any alerting mechanism.

## Choosing an alerting setup

- **Mode A**: Set `GRAFANA_ALERT_WEBHOOK_URL` to receive external alerts.
- **Mode B (simple)**: Set `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT`.
- **Mode B (advanced)**: Use the Alertmanager overlay for alert deduplication and routing. Leave `ALERT_WEBHOOK_URL` unset.
- **Host failure monitoring**: Add a heartbeat URL (`ALERT_HEARTBEAT_URL`).

## Security

Webhook and heartbeat URLs contain authentication tokens:
- The collector logs URLs using scheme and host only, redacting sensitive query parameters and paths.
- Alertmanager reads its webhook URL from a file (`url_file`).
- Grafana embeds `GRAFANA_ALERT_WEBHOOK_URL` at startup without saving it to tracked repository files.

For complete details, see [security.md](security.md).

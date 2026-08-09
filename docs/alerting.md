# Alerting

Po11y ships four alerting mechanisms. **They are alternatives, not layers.**
Enabling two means every alert arrives twice.

Which one is available to you is mostly decided by which mode you run, because
each mode can see different things.

## The one-screen version

| | Mechanism | Mode | Ships on by default | Delivers to |
|---|---|---|---|---|
| 1 | **Notifications feed** | A + B | B: yes (`ALERTS_ENABLED=false` opts out); A: no, nothing writes it | The dashboard's Notifications panel |
| 2 | **Grafana alerting** | **A only** | **yes** | Webhook (`GRAFANA_ALERT_WEBHOOK_URL`) |
| 3 | **Collector push** | **B only** | no | Slack / Discord / Telegram / raw |
| 4 | **Prometheus + Alertmanager** | **B only** | no (opt-in overlay) | Webhook |

Plus one thing that is *not* an alerting mechanism and does not conflict with
any of them:

| | | | |
|---|---|---|---|
| 5 | **Heartbeat** (dead-man switch) | B only | `ALERT_HEARTBEAT_URL` |

## Why the split exists

The two modes observe n8n from different places, and that decides what each can
detect.

```
MODE A  (po11y owns the stack)          MODE B  (someone else's n8n)

  ┌────────┐                              ┌────────┐
  │  n8n   │                              │  n8n   │   ← not yours
  └───┬────┘                              └───┬────┘
      │ writes                                │ public API (GET only)
      ▼                                       ▼
  ┌──────────┐   SQL     ┌─────────┐      ┌───────────┐   /metrics   ┌────────────┐
  │ postgres │ ────────► │ Grafana │      │ collector │ ───────────► │ Prometheus │
  └──────────┘           └────┬────┘      └─────┬─────┘              └──────┬─────┘
                              │                 │                           │
                              ▼                 ▼                           ▼
                          webhook          push / feed              Alertmanager
```

Mode A reads **the database n8n writes to**, so an in-flight execution is
visible the moment its row lands. Mode B reads **the API**, only as often as it
polls, and only what the API chooses to expose.

That difference is not cosmetic:

- **Stuck executions** are visible to *n8n's own metrics* only in Mode A: those
  metrics record an execution when it *finishes*, so one that hangs forever
  emits nothing at all, while a database row with `finished = false` and no
  `stoppedAt` is unambiguous. Mode B closes the gap from the other side — the
  collector derives `po11y_workflow_running_seconds` from the executions API
  each poll, so **both modes alert on stuck workflows**; Mode B's granularity is
  the poll interval rather than instant. The collector watchdog's `stuck` rule
  and the Alertmanager overlay's `Po11yWorkflowStuck` both run off that gauge.
- **Queue backlog** (`status = 'new'`) genuinely is Mode A only. The API has no
  equivalent.

## 1. Notifications feed

The dashboard's Notifications panel, fed by `notifications.json`.

In **Mode B** the collector's watchdog writes it, on by default
(`ALERTS_ENABLED=false` opts out) — and note that two of its three rules stay
off until you give them a budget (`ALERT_STALE_AFTER_MIN` and
`ALERT_STUCK_AFTER_MIN` both default to `0` = off), so the default gets you
`failing` and `unreachable` only. In **Mode A**
nothing writes it out of the box:
`workflows/core/` contains only the maps and status-publish workflows. The
example workflow `workflows/examples/hn-notify.json` demonstrates the shape.

No outbound delivery. You have to be looking at the dashboard.

## 2. Grafana alerting — Mode A

**On by default.** Five rules in `observability/grafana/alerting/rules.yml`,
provisioned into the `Po11y` folder and evaluated every 60s:

| Rule | Fires when | Severity |
|---|---|---|
| `Po11yN8nUnreachable` | Prometheus cannot scrape `n8n:5678` for 10m | critical |
| `Po11yWorkflowFailing` | ≥3 errored executions in 1h, per workflow | warning |
| `Po11yWorkflowStale` | active workflow with no **success** in 6h | warning |
| `Po11yWorkflowStuck` | an execution running >1h | warning |
| `Po11yQueueBacklog` | executions queued >15m without starting | warning |

Thresholds mirror `observability/alerts.yml` (Mode B) exactly, so both modes
alert on the same conditions at the same limits. Change one, change the other.

**Delivery is the only optional part.** Leave `GRAFANA_ALERT_WEBHOOK_URL` unset
and the rules still evaluate and fire — they are visible under *Alerting* in
Grafana with full history, they just go nowhere. Set it and each firing alert is
POSTed there, grouped by alertname, with a resolved message when it clears.

Two things worth knowing:

- Grafana's webhook contact point sends **Grafana's own alert JSON**, not
  Slack's or Discord's message shape. A Slack incoming-webhook URL will be
  rejected. Point it at an n8n webhook node (n8n is right there in Mode A and
  can fan out to anything), or add a native Slack/Discord/Telegram contact point
  in Grafana's UI, which formats correctly.
- Four of the five rules read n8n's internal tables (`execution_entity`,
  `workflow_entity`). That schema can change across n8n versions. A broken
  dashboard is cosmetic; a broken alert is a missed outage — re-check these
  after a major n8n upgrade.

Not provisioned in Mode B: `docker-compose.readonly.yml` shares the Grafana
*provisioning* directory, so the rules live in a sibling directory mounted only
by Mode A. Mode B has no postgres.

## 3. Collector push — Mode B

`collector/notify.mjs`, configured with `ALERT_WEBHOOK_URL` plus
`ALERT_WEBHOOK_FORMAT` (`slack` | `discord` | `telegram` | `raw`). Off unless
you set a URL.

The cheapest option in the stack: no extra container, one environment variable,
and four sinks with per-platform formatting (Slack `mrkdwn` links, Discord bare
URLs, Telegram without `parse_mode`). Alerts are batched into one message per
poll, and repeated no more often than `ALERT_RENOTIFY_MIN` (default 360m).

Failure is always reported, never thrown — a broken webhook does not stop the
collector publishing feeds.

## 4. Prometheus + Alertmanager — Mode B

The opt-in overlay:

```sh
docker compose -f docker-compose.readonly.yml -f docker-compose.alerts.yml up -d
```

Requires `ALERTMANAGER_WEBHOOK_URL`. Rules in `observability/alerts.yml` read
the `po11y_*` series the collector exports on `:8081`.

**An alternative to option 3, not a companion.** Running both delivers every
alert twice.

What it adds over the collector's own push is **inhibition**. In Mode B an n8n
outage makes every workflow look stale and stuck at once, because the collector
keeps serving its last-known series while `po11y_n8n_up` is 0. Alertmanager
collapses that into one message. This is a Mode B problem specifically — it is
an artifact of polling a remote n8n — which is part of why Mode A does not ship
Alertmanager.

## 5. Heartbeat — the one that is not an alternative

`ALERT_HEARTBEAT_URL` (Mode B). A plain GET on every *successful* poll, aimed at
Healthchecks.io, Uptime Kuma, Better Stack or similar.

Every other mechanism on this page runs on the box it is watching, and therefore
dies with it. A dead process cannot send a message. The heartbeat inverts that:
it fails **by stopping**, so a service that is not on your box notices.

It composes with any of options 1–4, and nothing replaces it — not Alertmanager,
not Grafana alerting.

## Choosing

- **Mode A**: you already have it. Set `GRAFANA_ALERT_WEBHOOK_URL` when you want
  the alerts to leave the box.
- **Mode B, simplest**: set `ALERT_WEBHOOK_URL` and pick a format. Done.
- **Mode B, several teams or noisy outages**: run the Alertmanager overlay for
  routing and inhibition, and leave the collector's push unset.
- **Any mode, if the box going down matters**: add a heartbeat as well.

## Security

Every URL on this page is a credential — for Slack and Telegram the secret *is*
the URL path.

- The collector logs webhook and heartbeat URLs as scheme + host only, scrubs
  them out of transport errors, and never writes them to a feed.
- Alertmanager reads its URL via `url_file` rather than having it templated in,
  so the config stays read-only and uncorrupted by `&` in query strings.
- Grafana interpolates `GRAFANA_ALERT_WEBHOOK_URL` from the environment at
  provisioning time, so it is never written into a tracked file. Grafana admins
  can read it back from the contact point UI; anonymous Viewers (enabled by
  default for dashboard embedding) cannot.

See [security.md](security.md) for the wider posture.

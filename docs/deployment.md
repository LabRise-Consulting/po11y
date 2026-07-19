# Beyond docker compose

The compose stack is one deployment, not the product — the product is the file
contract (small JSON files on a shared volume) plus a static dashboard, which
is deployment-agnostic.

## Podman

The compose file runs under `podman-compose`. Point the `docker-proxy`
sidecar at the Podman socket (it speaks the Docker API); or drop the proxy and
the containers section is simply empty.

## Kubernetes

Plain manifests live in [`deploy/k8s/`](../deploy/k8s) — build and push the
n8n image, create the static-file ConfigMaps, set the Secrets, then
`kubectl apply -k deploy/k8s`. Generic clusters have no Docker socket, so the
containers feed is empty there; everything else works. Community-supported:
schema-checked in CI, not smoke-tested. See
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Tracing with OpenTelemetry (opt-in)

n8n emits OpenTelemetry traces for workflow and node executions natively.
Enable it with the bundled override, which also starts a Grafana Tempo backend
so traces surface in the same Grafana as the metrics:

```sh
docker compose -f docker-compose.yml -f docker-compose.otel.yml up -d
```

It is opt-in on purpose: tracing is a newer n8n feature and heavier than the
built-in Prometheus metrics, so the default stack leaves it off.

**What tracing adds over the metrics.** The Prometheus dashboards are
aggregates (counts, rates, average durations). Traces are per-execution: a
single run split into spans (each node, sub-workflow call, outbound HTTP
request) with timing and parent/child — the drill-down for *why was this run
slow* or *which node failed in this execution*.

**A dashboard for it.** Tempo's metrics-generator derives span metrics (and a
service graph) from the trace stream and remote-writes them to Prometheus, so
the override also ships an **n8n Execution Traces** Grafana dashboard:
per-workflow execution/error counts and per-node p95 latency, broken down by
n8n's own span attributes (`n8n_workflow_name`, `n8n_node_name`, …).

**Deep links from the Po11y dashboard.** Grafana Explore takes a TraceQL query
in the URL — *recent errors* (`{status=error}`), *slow runs*
(`{duration>2s}`), *all recent traces* (`{}`). A ready-made card group is in
[`deploy/otel/config-cards.json`](../deploy/otel/config-cards.json) — merge it
into your `config.json` `cards`. The Explore links need a Grafana login
(Explore is Editor-only); the Execution Traces dashboard link works
anonymously.

## How Po11y compares

- **[n8n-io/n8n-observability](https://github.com/n8n-io/n8n-observability)**
  (official, MIT) — Prometheus + Grafana with Webhook/Form execution
  dashboards. Po11y builds on the same idea and adds the status page, the live
  container feed, the interactive workflow maps and the automatic form
  buttons. Its two dashboards are bundled here (Grafana ships four in total).
- **Workflow visualizers** (e.g. [n8nmermaid](https://github.com/jwa91/n8nmermaid))
  — turn exported JSON into diagrams for pull-request review. Po11y does it
  live from the running instance every 10 minutes.
- **n8n execution viewers** (e.g. n8nTrace) — push-based dashboards for
  execution history and errors. Po11y is a system-health, documentation and
  action panel, not a per-execution log viewer.
- **DIY (Retool / Appsmith + the n8n REST API)** — maximum control, more to
  build and maintain. Po11y is the pre-packaged, one-command version.

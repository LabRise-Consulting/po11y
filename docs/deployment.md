# Deployment options

Po11y consists of static dashboard files, plus the JSON feeds the po11y `server` process builds from its SQLite store and serves over HTTP. This design works across different deployment environments.

## Podman

You can run the Compose stack using `podman-compose`.

No socket configuration is needed: the stack mounts no container runtime socket.

## Kubernetes

Plain manifests are available in [`deploy/k8s/`](../deploy/k8s). Build and push the n8n image, create ConfigMaps and Secrets, then deploy using:

```sh
kubectl apply -k deploy/k8s
```

### Feature comparison: Compose vs Kubernetes

| Feature | Docker Compose | Kubernetes (`deploy/k8s`) |
|---|---|---|
| Bundled n8n | Yes | Yes (n8n Deployment only) |
| Read-only, against an external n8n | Yes | No manifests included |
| Status feeds (status/map/forms/ai-map/notifications) | Yes, from the `server` process | **No — see [`deploy/k8s/README.md`](../deploy/k8s/README.md#status-feeds-do-not-work)** |
| Dashboard authentication | Basic Auth or OIDC forward-auth | None (must be handled by Ingress) |
| MCP server (`/mcp/`) | Yes | No deployment or routing |
| Grafana alert rules | 5 provisioned rules | Requires ConfigMap setup |
| Form submission proxy (`/form/`) | Yes | No |
| Data table list proxy (`/n8n-table/`) | Yes | No |
| Multi-team scopes | Yes | No |
| Container security context | `read_only`, `user: node` | Basic `fsGroup` only |
| Container status card | Gone permanently, every deployment — see [docs/server.md](server.md#accepted-regressions) | Same |

For complete instructions and setup details, see [`deploy/k8s/README.md`](../deploy/k8s/README.md).

## OpenTelemetry Tracing (Optional)

n8n can emit OpenTelemetry traces for executions. Enable tracing and start Grafana Tempo using the OTEL override file:

```sh
docker compose -f docker-compose.yml -f docker-compose.otel.yml up -d
```

### Features provided by OpenTelemetry

- **Execution breakdown**: Traces record execution spans (nodes, sub-workflows, outbound HTTP requests) with precise timing.
- **Grafana dashboard**: Includes an **n8n Execution Traces** dashboard showing per-workflow error rates and node latency.
- **Deep links**: Provides Grafana Explore TraceQL links (`{status=error}`, `{duration>2s}`) for root-cause analysis. Card links can be merged using [`deploy/otel/config-cards.json`](../deploy/otel/config-cards.json).

## Comparisons with other tools

For detailed comparisons with tools like `n8n-trace`, `n8n Manager`, `FlowPulse`, and `n8n-observability`, see [README.md](../README.md#feature-comparison).

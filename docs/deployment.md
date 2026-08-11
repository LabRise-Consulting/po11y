# Deployment options

Po11y consists of static dashboard files and JSON feed files stored on a shared status volume. This design works across different deployment environments.

## Podman

You can run the Compose stack using `podman-compose`.

- Configure the `docker-proxy` sidecar to point to the Podman socket.
- Alternatively, remove `docker-proxy` if container status monitoring is not needed.

## Kubernetes

Plain manifests are available in [`deploy/k8s/`](../deploy/k8s). Build and push the n8n image, create ConfigMaps and Secrets, then deploy using:

```sh
kubectl apply -k deploy/k8s
```

### Feature comparison: Compose vs Kubernetes

| Feature | Docker Compose | Kubernetes (`deploy/k8s`) |
|---|---|---|
| Mode A (Bundled n8n) | Yes | Yes |
| Mode B (Collector against external n8n) | Yes | No deployment included |
| Dashboard authentication | Basic Auth or OIDC forward-auth | None (must be handled by Ingress) |
| MCP server (`/mcp/`) | Yes | No deployment or routing |
| Grafana alert rules | 5 provisioned rules | Requires ConfigMap setup |
| Form submission proxy (`/form/`) | Yes | No |
| Data table list proxy (`/n8n-table/`) | Yes | No |
| Multi-team scopes | Yes | No |
| Container security context | `read_only`, `user: node` | Basic `fsGroup` only |
| Container status feed | Docker socket | Empty (no host socket mounted) |

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

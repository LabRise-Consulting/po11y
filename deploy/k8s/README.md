# Po11y on Kubernetes

> **Support status**: Community-supported. Manifests are schema-validated (`kustomize build deploy/k8s | kubeconform -strict`), but Docker Compose remains the primary maintained deployment target.

These manifests deploy Po11y using standard Kubernetes resources in the `po11y` namespace.

Run all commands from the **repository root directory**.

## Installation steps

### 1. Build and push the n8n container image

Build the repository `Dockerfile` and push it to your container registry. Update the image reference in `20-n8n.yaml` (default: `po11y-n8n:latest`):

```sh
docker build -t <registry>/po11y-n8n:latest .
docker push <registry>/po11y-n8n:latest
```

### 2. Create secrets

Create the `po11y` namespace and required secrets:

```sh
kubectl create namespace po11y

kubectl -n po11y create secret generic po11y-secrets \
  --from-literal=DB_POSTGRESDB_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=N8N_OWNER_PASSWORD='Chang3Me!'

kubectl -n po11y create secret generic po11y-ai-map \
  --from-file=ai-map.json=./secrets/ai-map.json
```

### 3. Create ConfigMaps

Create ConfigMaps for static UI files, Grafana dashboards, entrypoint scripts, and helper libraries:

```sh
# Dashboard UI files
kubectl -n po11y create configmap po11y-html   --from-file=html/
kubectl -n po11y create configmap po11y-vendor --from-file=html/vendor/
kubectl -n po11y create configmap po11y-site   --from-file=site/

# Grafana dashboards and entrypoint
kubectl -n po11y create configmap grafana-dashboards-json \
  --from-file=observability/grafana/provisioning/dashboards/json/

kubectl -n po11y create configmap grafana-entrypoint \
  --from-file=observability/grafana/entrypoint.sh

kubectl -n po11y create configmap grafana-alerting \
  --from-file=observability/grafana/alerting/

# List tab library
kubectl -n po11y create configmap po11y-lib --from-file=lib/list-rows.mjs
```

### 4. Deploy resources

Apply the manifests:

```sh
kubectl apply -k deploy/k8s/
```

Access the dashboard using port forwarding:

```sh
kubectl -n po11y port-forward svc/dashboard 8080:80
```

## Differences between Kubernetes and Docker Compose

- **No default authentication**: The Kubernetes Nginx ConfigMap does not include authentication. Protect the dashboard service using an authenticating Ingress.
- **Mode B unavailable**: No Deployment exists for the standalone collector.
- **MCP server unavailable**: No Deployment or `/mcp/` route is configured.
- **Container status panel is empty**: Kubernetes pods do not mount host Docker sockets, so container status cards remain empty.
- **Persistent storage affinity**: The shared volume `po11y-status` uses `ReadWriteOnce`. Pod affinity pins the `dashboard` pod to the same node as `n8n`.
- **Replica constraints**: Deployments use `Recreate` update strategies and must run with `replicas: 1`.

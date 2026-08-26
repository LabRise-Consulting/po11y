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
  --from-literal=PO11Y_RO_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=N8N_OWNER_PASSWORD='Chang3Me!'

kubectl -n po11y create secret generic po11y-ai-map \
  --from-file=ai-map.json=./secrets/ai-map.json
```

`PO11Y_RO_PASSWORD` must differ from `DB_POSTGRESDB_PASSWORD`. It belongs to
`po11y_ro`, a SELECT-only Postgres role that the `create-readonly-role` init
container on the grafana Deployment creates before Grafana starts, mirroring
what `bootstrap.sh` does on the compose stack. Grafana's `n8n-postgres`
datasource authenticates as that role and never holds n8n's own database
credentials. This matters because Grafana runs with anonymous Viewer access, a
Viewer may run arbitrary SQL through `/api/ds/query`, and the dashboard proxies
`/grafana/` without authentication: whatever the datasource can read is
readable by anyone who can reach the dashboard. The role has
`credentials_entity` and `execution_data` revoked.

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

## Status feeds do not work

**This is the biggest gap on this path, and it is not cosmetic: the dashboard's `status.json`, `map.json`, `forms.json`, `ai-map.json` and `notifications.json` all 404.**

Historically these manifests served feeds the same way the old bundled Docker
Compose stack did: an n8n Code node wrote them to a shared `po11y-status`
volume, and nginx aliased the files directly. Compose has since moved to a
`server` process that polls n8n and serves the feeds itself — see
[docs/server.md](../../docs/server.md) — and the n8n workflows that used to
write the old volume are gone from the repository entirely. Nobody ported
either side of that change to Kubernetes:

- There is no `server` Deployment, Service, or PVC here.
- The `po11y-status` PVC, its volume mounts on `n8n` and `dashboard`, and the
  nginx `location` blocks that aliased it have been removed from these
  manifests — leaving them in would have looked like a working feature that
  quietly serves nothing, which is worse than an honest 404.

**What full parity would take:** a `server` Deployment (image: `server/Dockerfile`,
same environment as `docker-compose.yml`'s `server` service), a PVC for its
SQLite store, a ClusterIP Service, and an nginx ConfigMap rework that proxies
`/status*.json`, `/map.json`, `/forms.json`, `/ai-map.json`,
`/notifications.json`, `/mcp/` and `/n8n-table/` to it — mirroring
`deploy/nginx/feeds-server.conf`. None of that exists yet. Until it does, the
dashboard's Grafana and Prometheus panels work; the status feeds do not.

## Other differences between Kubernetes and Docker Compose

- **No default authentication**: The Kubernetes Nginx ConfigMap does not include authentication. Protect the dashboard service using an authenticating Ingress. Note what that Ingress sits in front of: `/grafana/` reaches a Grafana that grants every anonymous visitor the Viewer role, and a Viewer can query the `n8n-postgres` datasource directly. The datasource is limited to the SELECT-only `po11y_ro` role for that reason (see step 2), but the dashboard itself is otherwise open until you put authentication in front of it.
- **MCP server unavailable**: No Deployment or `/mcp/` route is configured (see above — this is the same underlying gap as the missing `server` Deployment).
- **Container status panel is permanently gone**: this is not a Kubernetes-specific gap — see [docs/server.md](../../docs/server.md#accepted-regressions), which applies here too, once feeds work at all.
- **Replica constraints**: Deployments use `Recreate` update strategies and must run with `replicas: 1`.

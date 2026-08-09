# po11y on Kubernetes

> **Support level: community.** These manifests are schema-validated in CI
> (`kustomize build deploy/k8s | kubeconform -strict`) but not smoke-tested —
> the compose stack is the maintained reference deployment. Reviewed PRs
> welcome.

Plain-YAML translation of the repo's `docker-compose.yml`. No Helm, no operator.
An optional `kustomization.yaml` lets you `kubectl apply -k .`.

All manifests target the `po11y` namespace. Run every command below from the
**repo root** (so the `--from-file` paths resolve).

## 1. Build and push the n8n image

There is no public po11y image. Build the repo `Dockerfile` (n8nio/n8n:2.29.8 +
docker CLI + pre-created `/po11y-status`) and push it, then set that ref in
`20-n8n.yaml` (placeholder: `po11y-n8n:latest`):

```sh
docker build -t <registry>/po11y-n8n:latest .
docker push  <registry>/po11y-n8n:latest
# edit 20-n8n.yaml: image: <registry>/po11y-n8n:latest
```

## 2. Create the secrets

Placeholders live in `01-secrets.yaml`. Either edit them in a private copy, or
create the Secrets imperatively (preferred — nothing sensitive in git):

```sh
kubectl create namespace po11y

kubectl -n po11y create secret generic po11y-secrets \
  --from-literal=DB_POSTGRESDB_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=N8N_OWNER_PASSWORD='Chang3Me!'   # >=8 chars, >=1 digit, >=1 capital

# AI map: empty base_url/api_key/model => free heuristic map (no LLM).
kubectl -n po11y create secret generic po11y-ai-map \
  --from-file=ai-map.json=./secrets/ai-map.json
```

## 3. Create the large static ConfigMaps

These are not inlined (nested dirs / large files a ConfigMap can't or shouldn't
hold — e.g. the 2.5 MB `html/vendor/mermaid.min.js`):

```sh
# Dashboard static site
kubectl -n po11y create configmap po11y-html   --from-file=html/
kubectl -n po11y create configmap po11y-vendor --from-file=html/vendor/
kubectl -n po11y create configmap po11y-site   --from-file=site/

# Grafana dashboard JSON (required — grafana crash-loops without it)
kubectl -n po11y create configmap grafana-dashboards-json \
  --from-file=observability/grafana/provisioning/dashboards/json/

# Grafana entrypoint (required) + Mode A alert rules (optional but recommended).
# Both come from the canonical repo files so the k8s copy cannot drift from
# what compose runs. Skip grafana-alerting and Grafana simply starts with no
# alert rules; without a GRAFANA_ALERT_WEBHOOK_URL env on the Deployment the
# rules are visible and firing but deliver nowhere (same default as compose).
kubectl -n po11y create configmap grafana-entrypoint \
  --from-file=observability/grafana/entrypoint.sh
kubectl -n po11y create configmap grafana-alerting \
  --from-file=observability/grafana/alerting/

# List-tab module (optional — only a config with a list tab needs it):
kubectl -n po11y create configmap po11y-lib --from-file=lib/list-rows.mjs
```

(If you flatten `workflows/` and `packs/`, you can add `n8n-workflows` /
`n8n-packs` ConfigMaps and enable the commented mounts in `20-n8n.yaml`.
Otherwise bake those dirs into the n8n image with `COPY`.)

## 4. Apply

```sh
kubectl apply -f deploy/k8s/          # or: kubectl apply -k deploy/k8s/
```

The manifests are numbered by dependency order (namespace -> secrets/configmaps
-> PVCs -> postgres -> docker-proxy -> n8n -> prometheus -> grafana ->
dashboard). `kubectl apply -f` on the directory applies them all; ordering only
matters if you apply piecemeal.

Reach the dashboard with a quick port-forward:

```sh
kubectl -n po11y port-forward svc/dashboard 8080:80
```

For a real exposure, uncomment the Ingress or NodePort block in
`50-dashboard.yaml` — **and put authentication in front of it first**. See the
next section: these manifests have none.

## Caveats vs. the compose stack

- **There is no authentication.** On compose the dashboard entrypoint renders
  an auth include into nginx (Basic Auth via `DASHBOARD_BASIC_AUTH`, or
  forward-auth OIDC via `docker-compose.auth.yml`). Nothing renders it here, and
  the nginx ConfigMap ships without it, so anything that can reach the Service
  reads every feed and every embedded Grafana panel. Terminate auth at an
  Ingress before exposing this outside the cluster.
- **No Mode B.** There is no collector Deployment, so the read-only mode
  against a remote n8n is compose-only today.
- **No MCP server.** No Deployment and no `/mcp/` route.
- **Grafana alert rules need their ConfigMap.** The Deployment runs the shared
  `observability/grafana/entrypoint.sh` (mounted from the `grafana-entrypoint`
  ConfigMap), which provisions Mode A's five rules when the `grafana-alerting`
  ConfigMap is present — create both in step 3. Without the alerting ConfigMap
  Grafana starts with none; without `GRAFANA_ALERT_WEBHOOK_URL` the rules fire
  in the UI but deliver nowhere (see the commented env in `40-grafana.yaml`).
- **Reduced nginx config.** Besides auth and `/mcp/`, the ConfigMap omits the
  `/form/` submit proxy, the `/status/<scope>/` routes, `/n8n-table/`, and the
  identity-header scrubs. The header comment in `02-configmaps.yaml` lists them.
- **Container hardening is baseline, not verified.** Pods now set a seccomp
  RuntimeDefault profile plus, where the image tolerates it, `runAsNonRoot`,
  `allowPrivilegeEscalation: false`, dropped capabilities and
  `readOnlyRootFilesystem` (grafana, prometheus, dashboard). postgres keeps its
  root-then-setuid init and the nginx master still binds :80 as root, as on
  compose. There is still **no NetworkPolicy** — add one for anything real —
  and none of this is smoke-tested (see the support level note above).
- **Containers section is empty.** On compose a `docker-socket-proxy` sidecar
  bind-mounts the host Docker socket (read-only, container-list endpoint only)
  so n8n can render the "Running containers" card. Generic Kubernetes has **no
  Docker socket** to proxy, and mounting the node runtime socket would be a
  host-escape risk — so we do **not** mount any host socket. The `docker-proxy`
  Deployment is kept only so n8n's HTTP call resolves; it returns no containers,
  and the dashboard's containers section degrades to empty. Everything else
  (workflow map, notifications, metrics, grafana) works.
- **Shared status volume is ReadWriteOnce.** `po11y-status` is written by n8n
  and read by the dashboard. RWO only allows two pods to mount it if they are on
  the **same node**, so `50-dashboard.yaml` pins the dashboard onto n8n's node
  via `podAffinity`. For multi-node scheduling, switch the PVC to
  ReadWriteMany with an RWX StorageClass and remove the affinity block.
- **Single-writer assumption.** Every data PVC is RWO and its Deployment uses
  `strategy: Recreate`, so rollouts never double-attach a volume. Do not scale
  these Deployments beyond `replicas: 1`.

Treat image ref, StorageClass, exposure and the n8n workflow/pack provisioning
as things to confirm in your own environment — see the support-level note at
the top of this file for what has (and hasn't) been checked.

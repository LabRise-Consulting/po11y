# po11y on Kubernetes

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
`50-dashboard.yaml`.

## Caveats vs. the compose stack

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

## Validation status

These manifests were **syntax / schema validated only** (YAML parse via `yq`;
`kubectl apply --dry-run=client`). They have **not** been deployed to a live
cluster — treat image ref, StorageClass, exposure and the n8n workflow/pack
provisioning as things to confirm in your own environment before relying on it.

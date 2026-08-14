# Contributing to Po11y

We welcome issues, bug reports, and merge requests. Please report security vulnerabilities confidentially according to [SECURITY.md](SECURITY.md).

## Running checks locally

You can run all CI checks locally without starting the Docker stack:

```sh
# Unit tests
node --test "html/**/*.test.mjs" "site/**/*.test.mjs" "lib/**/*.test.mjs" \
  "server/**/*.test.mjs"

# Shell script linting — the same list the `lint` job passes
shellcheck bootstrap.sh ci/smoke.sh ci/check-expired-markers.sh \
  ci/check-grafana-entrypoint.sh observability/grafana/entrypoint.sh \
  scripts/backup-store.sh ci/check-dashboard-entrypoint.sh \
  deploy/nginx/dashboard-entrypoint.sh

# The rest of the `lint` job: expired-liability markers, and the two guards
# that keep an overlay from silently replacing a shared entrypoint
sh ci/check-expired-markers.sh bootstrap.sh
sh ci/check-grafana-entrypoint.sh
sh ci/check-dashboard-entrypoint.sh

# Compose config validation — both compose files
docker compose -f docker-compose.yml config -q
docker compose -f docker-compose.readonly.yml config -q

# Kubernetes manifest validation
kustomize build deploy/k8s | kubeconform -strict -summary
```

You can also install and run pre-commit hooks:

```sh
pre-commit install
pre-commit run --files <changed files>
```

See [docs/ci.md](docs/ci.md) for details on the full CI pipeline structure.

## Development conventions

- **Commit messages**: Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) with optional scope syntax (e.g. `fix(list): ...`).
- **No build steps**: `html/` contains static HTML, CSS, and JS files served directly by Nginx. Do not add runtime frameworks or npm dependencies.
- **Feed contract stability**: `status.json`, `notifications.json`, `map.json`, and `forms.json` define public schemas. Avoid breaking changes.
- **Read-only rule**: The po11y `server` (`server/n8n.mjs`'s `apiGet`) must send HTTP `GET` requests only to n8n. See its GET-only invariant test.
- **XSS prevention**: Sanitize data rendered in `html/app.js` using `esc()` and `safeUrl()`.

## Testing against a local stack

Run `./bootstrap.sh` to start the full stack on `127.0.0.1`:
- Dashboard: `http://127.0.0.1:8080`
- n8n Editor: `http://127.0.0.1:5678`
- Grafana: `http://127.0.0.1:3000`
- Prometheus: `http://127.0.0.1:9090`

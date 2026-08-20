# Contributing to Po11y

We welcome issues, bug reports, and pull requests. Please report security vulnerabilities privately according to [SECURITY.md](SECURITY.md).

Before your first pull request is merged, sign the
[Contributor License Agreement](CLA.md). A bot comments on the pull request
with the one line you reply to sign it. You sign once, and every later pull
request passes the check automatically.

## Running checks locally

You can run all CI checks locally without starting the Docker stack:

```sh
# Unit tests
node --test "html/**/*.test.mjs" "site/**/*.test.mjs" "lib/**/*.test.mjs" \
  "server/**/*.test.mjs" "observability/**/*.test.mjs"

# The same tests with the coverage floor CI applies. The command exits 1 if
# coverage falls below a threshold. Use whole numbers: node truncates a
# fractional threshold.
node --test --experimental-test-coverage --test-coverage-lines=95 \
  --test-coverage-branches=80 --test-coverage-functions=90 \
  "html/**/*.test.mjs" "site/**/*.test.mjs" "lib/**/*.test.mjs" \
  "server/**/*.test.mjs" "observability/**/*.test.mjs"

# Shell script linting — the same list the `lint` job passes
shellcheck bootstrap.sh ci/smoke.sh ci/check-expired-markers.sh \
  ci/check-grafana-entrypoint.sh observability/grafana/entrypoint.sh \
  scripts/backup-store.sh ci/check-dashboard-entrypoint.sh \
  deploy/nginx/dashboard-entrypoint.sh scripts/readonly-preflight.sh \
  ci/check-readonly-preflight.sh ci/check-env-example.sh

# The rest of the `lint` job: expired-liability markers, and the two guards
# that keep an overlay from silently replacing a shared entrypoint
sh ci/check-expired-markers.sh bootstrap.sh
sh ci/check-grafana-entrypoint.sh
sh ci/check-dashboard-entrypoint.sh
sh ci/check-readonly-preflight.sh
sh ci/check-env-example.sh

# Compose config validation — both compose files
docker compose -f docker-compose.yml config -q
docker compose -f docker-compose.readonly.yml config -q

# Kubernetes manifest validation. `-cache` keeps the downloaded JSON schemas
# in the working tree (gitignored), so only the first run needs
# raw.githubusercontent.com to be reachable.
mkdir -p .kubeconform-cache
kustomize build deploy/k8s | kubeconform -strict -summary -cache .kubeconform-cache
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

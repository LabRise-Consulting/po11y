# Contributing to Po11y

We welcome issues, bug reports, and merge requests. Please report security vulnerabilities confidentially according to [SECURITY.md](SECURITY.md).

## Running checks locally

You can run all CI checks locally without starting the Docker stack:

```sh
# Unit tests
node --test "html/**/*.test.mjs" "site/**/*.test.mjs" "lib/**/*.test.mjs" \
  "collector/**/*.test.mjs" "mcp/**/*.test.mjs"

# Workflow sync check
node tools/sync-workflows.mjs --check

# Shell script linting
shellcheck bootstrap.sh ai-map-cli.sh ci/smoke.sh ci/check-expired-markers.sh \
  observability/grafana/entrypoint.sh

# Compose config validation
docker compose -f docker-compose.yml config -q

# Kubernetes manifest validation
kustomize build deploy/k8s | kubeconform -strict -summary
```

You can also install and run pre-commit hooks:

```sh
pre-commit install
pre-commit run --files <changed files>
```

See [docs/ci.md](docs/ci.md) for details on the full CI pipeline structure.

## Code generation rule: `lib/` is the source of truth

`workflows/core/maps.json` embeds Code nodes generated from files in `lib/`. When editing builder logic, update `lib/` and regenerate `maps.json`:

1. Edit files in `lib/` (e.g. `lib/build-map.mjs`).
2. Update unit tests in matching `*.test.mjs` files.
3. Run `node tools/sync-workflows.mjs --write`.
4. Commit both `lib/` and `workflows/core/maps.json`.

## Development conventions

- **Commit messages**: Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) with optional scope syntax (e.g. `fix(list): ...`).
- **No build steps**: `html/` contains static HTML, CSS, and JS files served directly by Nginx. Do not add runtime frameworks or npm dependencies.
- **Feed contract stability**: `status.json`, `notifications.json`, `map.json`, and `forms.json` define public schemas. Avoid breaking changes.
- **Mode B read-only rule**: The collector (`collector/collect.mjs`) must send HTTP `GET` requests only to n8n.
- **XSS prevention**: Sanitize data rendered in `html/app.js` using `esc()` and `safeUrl()`.

## Testing against a local stack

Run `./bootstrap.sh` to start the full stack on `127.0.0.1`:
- Dashboard: `http://127.0.0.1:8080`
- n8n Editor: `http://127.0.0.1:5678`
- Grafana: `http://127.0.0.1:3000`
- Prometheus: `http://127.0.0.1:9090`

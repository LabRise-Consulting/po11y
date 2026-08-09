# Contributing to Po11y

Issues, merge requests and "this broke on my setup" reports are all welcome.
Security problems go through [SECURITY.md](SECURITY.md) instead — confidential
issue, not a public one.

## Getting the checks to pass

Everything CI runs is runnable locally, and none of it needs the stack up:

```sh
node --test "html/**/*.test.mjs" "site/**/*.test.mjs" "lib/**/*.test.mjs" \
  "collector/**/*.test.mjs" "mcp/**/*.test.mjs"                          # unit tests
node tools/sync-workflows.mjs --check                   # workflow/lib sync gate
shellcheck bootstrap.sh ai-map-cli.sh ci/smoke.sh ci/check-expired-markers.sh \
  observability/grafana/entrypoint.sh
docker compose -f docker-compose.yml config -q          # compose syntax
kustomize build deploy/k8s | kubeconform -strict -summary
```

There is also a pre-commit config:

```sh
pre-commit install
pre-commit run --files <changed files>
```

The `smoke` job (full docker-in-docker bring-up, run twice for idempotency)
only runs on the canonical project, because it needs a privileged runner that
forks don't have. Everything else runs on stock GitLab shared runners, so a
merge request from a fork gets a real pipeline. The full pipeline schematic —
stages, triggers, what each job gates — is in [docs/ci.md](docs/ci.md).

## The one non-obvious rule: `lib/` is the source of truth

`workflows/core/maps.json` embeds three n8n Code nodes whose bodies are
**generated** from the modules in `lib/`. Editing the JSON by hand will pass
review and then fail `sync-check`. The loop is:

1. edit `lib/build-map.mjs` / `lib/build-ai-map.mjs` / `lib/build-forms.mjs`
2. add or update the matching `*.test.mjs` next to it
3. `node tools/sync-workflows.mjs --write`
4. commit `lib/` **and** the regenerated `maps.json` together

## Conventions

- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) with
  an optional scope, e.g. `fix(list): …`. The body explains *why*.
- **No build step.** `html/` is three static files served by nginx, and it
  stays that way — no bundler, no framework, no npm dependency at runtime.
  `html/vendor/` is the only exception and each file there is documented in
  [`html/vendor/README.md`](html/vendor/README.md).
- **Feed contracts are public API.** `status.json`, `notifications.json`,
  `map.json` and `forms.json` are consumed by both modes and by third-party
  publishers; changing a shape is a breaking change. See
  [`docs/configuration.md`](docs/configuration.md).
- **Mode B stays read-only.** `collector/collect.mjs`'s `apiGet` is the single
  choke point for n8n calls and hard-codes `method: 'GET'`; a test asserts a
  full poll cycle issues only GETs. Don't route around it.
- Anything rendered from feed data goes through `esc()` and, for URLs,
  `safeUrl()` in `html/app.js`.

## Testing changes against a real stack

`./bootstrap.sh` brings up the whole thing on `127.0.0.1`. It publishes
n8n on 5678, the dashboard on 8080, Grafana on 3000 and Prometheus on 9090 —
override with `DASHBOARD_PORT` and friends in `.env` if something already owns
those ports on your machine.

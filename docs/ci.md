# The CI pipeline

Two stages. Six validate jobs that need nothing but a stock runner, then one
smoke job that boots the entire Mode A stack on docker-in-docker — twice. The
nightly schedule skips straight to smoke against a fresh upstream n8n image.

```mermaid
flowchart LR
  MR["merge request<br/>(every push)"] --> V
  MAIN["push to main"] --> V
  SCHED["nightly schedule<br/>(fresh n8n image)"] -. "validate jobs skipped" .-> S

  subgraph V["stage 1: validate — 6 parallel jobs · untagged · no docker daemon"]
    direction TB
    test["test<br/>node --test, every unit suite"]
    sync["sync-check<br/>lib/ ↔ maps.json byte-identical"]
    lint["lint<br/>shellcheck + CI guards"]
    inter["interlock<br/>open-bind refusal exits 78"]
    cc["compose-config<br/>both modes + overlays render"]
    man["manifests<br/>kustomize | kubeconform"]
  end

  V -- "all 6 green" --> S

  subgraph S["stage 2: smoke — dind · privileged · canonical project only"]
    direction TB
    b1["bootstrap.sh --no-examples"] --> s1["ci/smoke.sh<br/>16 polled assertions"]
    s1 --> b2["bootstrap.sh again<br/>(idempotency)"] --> s2["ci/smoke.sh again"]
  end

  S --> OK(["pipeline green — mergeable"])
  S --> FAIL(["failure — compose-logs.txt artifact"])
```

A branch push that already has an open merge request is suppressed, so there is
never a duplicate branch pipeline next to the MR pipeline.

## The jobs

| Job | Image | The gate it enforces |
|---|---|---|
| `test` | `node:22-alpine` | Every unit suite (`html/`, `site/`, `lib/`, `collector/`, `mcp/`) via node's built-in test runner. |
| `sync-check` | `node:22-alpine` | The builder Code nodes inlined into `workflows/core/maps.json` are byte-identical to what `tools/sync-workflows.mjs` generates from `lib/` — edit lib without re-syncing and this fails. |
| `lint` | `shellcheck-alpine:v0.10.0` | Shellcheck over every shell script, no expired `# REMOVE AFTER` liabilities in bootstrap.sh, and the grafana provisioning entrypoint survives every compose-overlay merge. |
| `interlock` | `alpine:3.20` | bootstrap.sh refuses a non-loopback bind with no auth gate — exit 78, and *before* any docker call (the job has no daemon, which is the proof). |
| `compose-config` | `docker:27` | Daemonless `docker compose config` of both modes, each merged with the auth / alerts / otel overlays, plus a byte-diff proving the two dashboard entrypoints never drift apart. |
| `manifests` | `alpine/k8s:1.31.1` | `kustomize build deploy/k8s` validates against Kubernetes schemas with `kubeconform -strict`. |
| `smoke` | `docker:27` + dind | bootstrap.sh brings the full Mode A stack up on a throwaway docker-in-docker daemon; `ci/smoke.sh` polls 16 HTTP assertions (dashboard, feeds, forms, grafana, MCP tools, read-only SQL role); then both run a second time to prove bring-up is idempotent. |

Everything the validate stage runs is runnable locally without the stack up —
the exact commands are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Runner policy

Every validate job is untagged and daemonless, so it runs on GitLab shared
runners and in forks — a merge request from a fork gets a real pipeline. Only
`smoke` needs a privileged runner: it carries the `dind` tag and is restricted
to the canonical project, where it is skipped-not-stalled everywhere else (a
tag nobody provides would otherwise hang the pipeline forever).

## The nightly canary

Scheduled pipelines run smoke alone — the validate jobs prove the repo against
itself and nothing in the repo changed overnight. What *does* change is
upstream: the schedule rebuilds against the freshest n8n image, so an upstream
break surfaces within a day instead of in the middle of an unrelated MR.

## Determinism notes

- The smoke `.env` pins `AI_MAP_BASE_URL` with an empty API key, which the maps
  workflow reads as "LLM off" — the ai-map assertion tests the deterministic
  heuristic structure instead of racing a live OmniRoute call against the 90 s
  per-assertion budget.
- Each assertion is polled until it passes or `SMOKE_TIMEOUT` (default 90 s)
  expires, so ordering jitter inside the stack never fails a run; only a
  genuinely missing behaviour does.
- A failed smoke uploads `compose-logs.txt` (last 200 lines per container,
  omniroute overlay included) as a job artifact.

# The AI architecture map

The Architecture tab always renders: its structure comes from code, not from a
model. An LLM is optional and improves the text. Two ways to enable that:

1. **Bundled OmniRoute gateway (default)**: the
   `docker-compose.omniroute.yml` overlay runs an
   [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway — one
   OpenAI-compatible endpoint with provider routing and fallback. Bootstrap
   includes it unless `OMNIROUTE_ENABLED=false` and wires the map to it
   automatically when `AI_MAP_BASE_URL` is empty, defaulting `AI_MAP_MODEL`
   to `auto/best-free` — OmniRoute's keyless free-tier auto-route — so a
   clean bootstrap gets LLM prose with zero configuration and zero cost. To
   use a specific (paid) model instead: open `http://127.0.0.1:20128`, log in
   (`OMNIROUTE_ADMIN_PASSWORD` in `.env`), connect a provider, set
   `AI_MAP_MODEL` in `.env` (e.g. `anthropic/claude-haiku-4-5`) and re-run
   `./bootstrap.sh`. In Mode B add the overlay by hand
   (`docker compose -f docker-compose.readonly.yml -f docker-compose.omniroute.yml up -d`)
   and set `AI_MAP_BASE_URL=http://omniroute:20128/v1` yourself (Mode B has
   no bootstrap to auto-wire it).
2. **Any other API endpoint**: set `AI_MAP_BASE_URL`, `AI_MAP_API_KEY` and
   `AI_MAP_MODEL` in `.env` (any OpenAI-compatible chat endpoint works: your
   own OmniRoute, Mistral, OpenAI, Anthropic, a local Ollama), then
   `docker compose up -d n8n`. Explicit values always beat the bundled
   auto-wiring; set `OMNIROUTE_ENABLED=false` to skip the bundled container
   entirely. The Maps workflow refreshes the text daily, or immediately via
   the "Build maps now" button.
3. **Local AI CLI, no API key**: run `./ai-map-cli.sh` on the host. It pipes
   the map through a local CLI (`claude -p` by default; set `AI_MAP_CLI` to
   use `llm`, `ollama run <model>`, or anything that reads a prompt on stdin
   and prints the answer).

**What the LLM sees.** Exactly the per-workflow digest built in
`lib/build-ai-map.mjs` (`digestOf`): workflow id, name and active flag, and
per node its name, its type, plus — only when the node has them — the schedule
`rule`, webhook `path`, `url` (truncated to 120 chars), `command` (160 chars),
the called sub-workflow id, and the `//` comment lines of Code nodes (300
chars). n8n credential objects, execution data and node payloads are never
part of it — but a secret hardcoded into a node's URL or command text is
inside those truncated fields, so it WILL be sent. With the default bundled
OmniRoute route that digest goes to a third-party free-tier provider; set
`OMNIROUTE_ENABLED=false` for the heuristic map (nothing leaves the box), or
point `AI_MAP_BASE_URL` at an endpoint you trust.

**Cost is near zero.** The map's structure is free (built from code). The LLM
is only called when a workflow actually changed, and the call is differential:
per-node content signatures (`sigs` in the published map) let unchanged nodes
keep their previous prose, so the prompt carries only the changed workflows'
digest. An unchanged map skips the call entirely; the "Build maps now" form
forces a full re-annotation — in Mode B, where there is no form, send the
collector a SIGHUP instead (`docker kill -s HUP po11y-collector`): it polls
immediately and re-annotates everything. A cheap model (e.g.
`mistral-small-latest`) is plenty, and the keyless heuristic and local-Ollama
paths cost nothing at all.

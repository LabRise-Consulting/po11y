# The AI architecture map

The Architecture tab always renders: its structure comes from code, not from a
model. An LLM is optional and improves the text. Two ways to enable that:

1. **API endpoint**: set `AI_MAP_BASE_URL`, `AI_MAP_API_KEY` and
   `AI_MAP_MODEL` in `.env` (any OpenAI-compatible chat endpoint works:
   Mistral, OpenAI, Anthropic, a local Ollama), then
   `docker compose up -d n8n`. The Maps workflow refreshes the text daily, or
   immediately via the "Build maps now" button.
2. **Local AI CLI, no API key**: run `./ai-map-cli.sh` on the host. It pipes
   the map through a local CLI (`claude -p` by default; set `AI_MAP_CLI` to
   use `llm`, `ollama run <model>`, or anything that reads a prompt on stdin
   and prints the answer).

**Cost is near zero.** The map's structure is free (built from code). The LLM
is only called when a workflow actually changed, and the call is differential:
per-node content signatures (`sigs` in the published map) let unchanged nodes
keep their previous prose, so the prompt carries only the changed workflows'
digest. An unchanged map skips the call entirely; the "Build maps now" form
forces a full re-annotation. A cheap model (e.g. `mistral-small-latest`) is
plenty, and the keyless heuristic and local-Ollama paths cost nothing at all.

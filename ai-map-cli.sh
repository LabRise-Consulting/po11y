#!/usr/bin/env bash
# Annotate the Architecture tab with a local AI CLI instead of an API endpoint.
#
# The maps workflow builds the map's STRUCTURE deterministically (and, without
# AI_MAP_* configured, publishes it with heuristic text). This script has a
# local CLI rewrite the prose — per-node one-liners, lede, insight cards —
# and republishes. The CLI contract is "prompt on stdin, answer on stdout",
# true for `claude -p`, `llm`, `ollama run <model>`, ...
#
#   ./ai-map-cli.sh                          # uses `claude -p`
#   AI_MAP_CLI='llm -m gpt-4.1' ./ai-map-cli.sh
#
# Only the LLM call runs on the host; digest and publish run inside the n8n
# container (same atomic tmp+rename write as the maps workflow).
set -euo pipefail
cd "$(dirname "$0")"

AI_MAP_CLI="${AI_MAP_CLI:-claude -p}"
CLI_BIN=${AI_MAP_CLI%% *}
command -v "$CLI_BIN" >/dev/null || {
  echo "ai-map-cli: '$CLI_BIN' not found on PATH (set AI_MAP_CLI to another CLI)" >&2; exit 1; }
docker compose ps --status running n8n 2>/dev/null | grep -q n8n || {
  echo "ai-map-cli: n8n container is not running — start the stack first (./bootstrap.sh)" >&2; exit 1; }
docker compose exec -T n8n test -f /po11y-status/ai-map.json || {
  echo "ai-map-cli: no ai-map.json yet — wait for a maps tick or submit /form/maps-build-now" >&2; exit 1; }

echo "ai-map-cli: exporting workflows…"
docker compose exec -T n8n sh -c \
  'rm -f /tmp/wf-export-cli.json && n8n export:workflow --all --output=/tmp/wf-export-cli.json >/dev/null 2>&1'

# Digest logic mirrors workflows/core/maps.json — keep the two in sync.
CONTEXT=$(docker compose exec -T n8n node -e '
const fs = require("fs");
const wfs = JSON.parse(fs.readFileSync("/tmp/wf-export-cli.json", "utf8")).filter((w) => !w.isArchived);
const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const digest = wfs.map((wf) => ({
  id: wf.id, name: wf.name, active: !!wf.active,
  nodes: (wf.nodes || []).map((nd) => {
    const p = nd.parameters || {};
    const o = { name: nd.name, type: nd.type.replace("n8n-nodes-base.", "") };
    if (p.rule) o.rule = p.rule;
    if (p.path) o.path = p.path;
    if (p.url) o.url = cut(p.url, 120);
    if (p.command) o.command = cut(p.command, 160);
    if (p.workflowId) o.calls = typeof p.workflowId === "object" ? p.workflowId.value : p.workflowId;
    if (p.jsCode) o.code_comment = cut(String(p.jsCode).split("\n").filter((l) => l.startsWith("//")).join(" "), 300);
    return o;
  }),
}));
const map = JSON.parse(fs.readFileSync("/po11y-status/ai-map.json", "utf8"));
const skeleton = (map.nodes || []).map(({ id, kind, tag, name }) => ({ id, kind, tag, name }));
process.stdout.write(JSON.stringify({ skeleton, digest }));')

# Prompt mirrors the annotation prompt in workflows/core/maps.json — keep in sync.
PROMPT=$(cat <<EOF
You annotate a fixed architecture map of an n8n automation stack. The structure is already decided — you ONLY write text.

Return STRICT JSON (no markdown, output ONLY the JSON object): {"lede": "1-2 sentences describing the left-to-right flow", "subs": {"<node id>": "concrete one-line description, max 90 chars"}, "notes": [{"title": "short", "text": "2-3 sentences of real operational insight"}]}

Rules: cover every node id; 'subs' must say what the thing concretely does (use the digest's code comments); notes max 3, skip generic filler.

Map nodes and workflow digest:
$CONTEXT
EOF
)

echo "ai-map-cli: asking '$AI_MAP_CLI' to annotate the map (may take a minute)…"
printf '%s' "$PROMPT" | sh -c "$AI_MAP_CLI" | docker compose exec -T -e AI_MAP_CLI_NAME="$AI_MAP_CLI" n8n node -e '
const fs = require("fs");
const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const text = fs.readFileSync(0, "utf8");
const m = text.match(/\{[\s\S]*\}/); // tolerate fences or chatter around the JSON
if (!m) { console.error("ai-map-cli: no JSON object in CLI output: " + text.slice(0, 200)); process.exit(1); }
const ann = JSON.parse(m[0]);
if (!ann.subs || typeof ann.subs !== "object") {
  console.error("ai-map-cli: CLI returned an unusable shape: " + m[0].slice(0, 200)); process.exit(1);
}
const map = JSON.parse(fs.readFileSync("/po11y-status/ai-map.json", "utf8"));
let covered = 0;
for (const n of map.nodes || []) {
  const s = ann.subs[n.id];
  if (typeof s === "string" && s.trim()) { n.sub = cut(s.trim(), 120); covered++; }
}
if (typeof ann.lede === "string" && ann.lede.trim()) map.lede = cut(ann.lede.trim(), 240);
map.notes = (Array.isArray(ann.notes) ? ann.notes : []).slice(0, 3)
  .filter((x) => x && x.title && x.text)
  .map((x) => ({ title: cut(String(x.title), 60), text: cut(String(x.text), 400) }));
map.generated_at = new Date().toISOString();
map.model = process.env.AI_MAP_CLI_NAME || "local cli";
fs.writeFileSync("/po11y-status/ai-map.json.tmp", JSON.stringify(map));
fs.renameSync("/po11y-status/ai-map.json.tmp", "/po11y-status/ai-map.json");
console.log(`ai-map-cli: annotated ${covered}/${(map.nodes || []).length} nodes — Architecture tab updated`);'

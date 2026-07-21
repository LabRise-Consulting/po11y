#!/usr/bin/env node
// sync-workflows.mjs — regenerate the three builder Code nodes in
// workflows/core/maps.json FROM lib/, and enforce that sync in CI.
//
// After this tool exists, editing lib/build-map.mjs, lib/build-forms.mjs or
// lib/build-ai-map.mjs and running `node tools/sync-workflows.mjs --write` is
// the ONLY sanctioned way to change those nodes' jsCode. Each generated node
// is: a GENERATED banner + the node's human intro comment + the lib module
// source (its single `export` stripped so it runs inline in the n8n Code
// sandbox) + a per-node wrapper that supplies the I/O the pure lib omits
// ($json.workflows in, generated_at stamp, tmp+rename writes to
// /po11y-status/, and the ai-map LLM transport).
//
// Modes:
//   --write   rewrite the three jsCode fields in place, then serialize the
//             whole file with JSON.stringify(obj, null, 2) + trailing newline
//             (this canonical 2-space form becomes the committed format).
//   --check   regenerate in memory and byte-compare with the file on disk;
//             exit 0 when identical, exit 1 (naming the drifted node) when not.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAPS = join(ROOT, 'workflows', 'core', 'maps.json');

const banner = (lib) =>
  `// GENERATED from lib/${lib} by tools/sync-workflows.mjs — edit lib/, run: node tools/sync-workflows.mjs --write`;

// The human intro comment kept verbatim from each node (captured once from the
// pre-generator maps.json). Preserved so the runtime node stays self-describing
// and independent of the lib module's own "pure extraction of…" developer note.
const INTRO = {
  map:
    "// Build a mermaid graph of every workflow on this instance and how they\n" +
    "// link: trigger entry points (schedule/form/webhook), Execute Workflow\n" +
    "// references, plus best-effort webhook/form-call edges (an HTTP Request\n" +
    "// whose URL contains another workflow's webhook or form path).\n" +
    "// Writes /po11y-status/map.json for site/map.html.",
  forms:
    "// Publish the live form-trigger inventory for the dashboard's Actions\n" +
    "// group: every active workflow's formTrigger nodes as { name, sub, path }.\n" +
    "// The dashboard (app.js) merges /forms.json into its Actions cards, so a\n" +
    "// new form trigger becomes a button without touching config.json.",
  ai:
    "// Deterministic architecture map. Structure (columns, nodes, edges) is\n" +
    "// computed from the live export — the same references the mermaid map uses —\n" +
    "// so the layout is identical run-to-run. An optional LLM (AI_MAP_*) only\n" +
    "// writes prose: per-node one-liners, the lede, insight cards. Without a key\n" +
    "// the map publishes with heuristic text (ai-map-cli.sh can annotate via a\n" +
    "// local CLI instead). Annotation is differential: per-node content\n" +
    "// signatures (sigs) let unchanged nodes keep their previous prose, so the\n" +
    "// LLM only ever sees the workflows that actually changed.",
};

// Per-node wrapper appended after the inlined lib source. These carry the glue
// the pure lib functions deliberately omit: the $json.workflows input (Mode A
// shim feeds it), the generated_at stamp, and the tmp+rename writes.
const WRAPPER = {
  map: [
    "const out = buildMap($json.workflows);",
    "const fs = require('fs');",
    "const published = { generated_at: new Date().toISOString(), mermaid: out.mermaid, workflows: out.workflows, entries: out.entries };",
    "fs.writeFileSync('/po11y-status/map.json.tmp', JSON.stringify(published));",
    "fs.renameSync('/po11y-status/map.json.tmp', '/po11y-status/map.json');",
    "return [{ json: { published: true, workflows: out.workflows, edges: out.edges } }];",
  ].join("\n"),

  forms: [
    "const { forms } = buildForms($json.workflows);",
    "const fs = require('fs');",
    "const published = { generated_at: new Date().toISOString(), forms };",
    "fs.writeFileSync('/po11y-status/forms.json.tmp', JSON.stringify(published));",
    "fs.renameSync('/po11y-status/forms.json.tmp', '/po11y-status/forms.json');",
    "return [{ json: { published: forms.length } }];",
  ].join("\n"),

  // buildAiMap owns all policy + prose; the wrapper owns I/O and the LLM
  // transport. CAUTION: on action 'republish' buildAiMap returns the caller's
  // prev object with generated_at deleted — so we stamp r.map (never prev) and
  // must not reuse prev after the call.
  ai: [
    "const fs = require('fs');",
    "let prev = null;",
    "try { prev = JSON.parse(fs.readFileSync('/po11y-status/ai-map.json', 'utf8')); } catch {}",
    "// AI config from a non-served file (bootstrap renders it from .env).",
    "// Environment access is blocked in Code nodes, so workflows cannot",
    "// read the DB / Grafana passwords out of the process environment.",
    "let AICFG = {};",
    "try { AICFG = JSON.parse(fs.readFileSync('/run/po11y/ai-map.json', 'utf8')); } catch {}",
    "const KEY = AICFG.api_key || '';",
    "const MODEL = AICFG.model || '';",
    "const BASE = (AICFG.base_url || '').replace(/\\/$/, '');",
    "const aiConfigured = KEY && MODEL && BASE;",
    "let forced = false;",
    "try { forced = $('Build now (form)').all().length > 0; } catch {}",
    "const llm = async (prompt) => {",
    "  const res = await this.helpers.httpRequest({",
    "    method: 'POST',",
    "    url: `${BASE}/chat/completions`,",
    "    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },",
    "    // stream:false is explicit — some gateways (OmniRoute auto/* routes)",
    "    // default to SSE when the field is absent, which json:true can't parse.",
    "    body: { model: MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 3000, stream: false },",
    "    json: true,",
    "  });",
    "  return ((res.choices || [])[0] || {}).message?.content || '';",
    "};",
    "const r = await buildAiMap($json.workflows, { prev, forced, now: Date.now(), aiConfigured, model: MODEL, llm: aiConfigured ? llm : null });",
    "if (r.action === 'skip-fresh' || r.action === 'keep-annotated') return [{ json: r.summary }];",
    "// republish | publish: stamp generated_at on the returned map and write it.",
    "r.map.generated_at = new Date().toISOString();",
    "fs.writeFileSync('/po11y-status/ai-map.json.tmp', JSON.stringify(r.map));",
    "fs.renameSync('/po11y-status/ai-map.json.tmp', '/po11y-status/ai-map.json');",
    "for (const w of (r.summary.warnings || [])) console.log(w);",
    "return [{ json: r.summary }];",
  ].join("\n"),
};

// The three generated builder nodes: n8n node name → lib module + wrapper key.
const NODES = [
  { node: "Build + publish map.json", lib: "build-map.mjs", key: "map" },
  { node: "Publish forms.json", lib: "build-forms.mjs", key: "forms" },
  { node: "Build + publish ai-map.json", lib: "build-ai-map.mjs", key: "ai" },
];

// Read a lib module, drop its trailing newline, and strip the single leading
// `export ` from its `export [async] function …` declaration so the function
// is defined inline in the Code sandbox.
function libSource(lib) {
  const src = readFileSync(join(ROOT, "lib", lib), "utf8").replace(/\n$/, "");
  // Exactly one export supported: a second one would be stripped incompletely,
  // pass --check and tests, and only blow up as a SyntaxError inside n8n.
  const exports = src.match(/^export /gm) || [];
  if (exports.length !== 1) {
    throw new Error(`${lib}: expected exactly 1 export, found ${exports.length}`);
  }
  return src.replace(/^export (?=(?:async )?function )/m, "");
}

// jsCode := banner + intro + lib source (export stripped) + wrapper.
function generate({ lib, key }) {
  return `${banner(lib)}\n${INTRO[key]}\n\n${libSource(lib)}\n\n${WRAPPER[key]}`;
}

const serialize = (obj) => JSON.stringify(obj, null, 2) + "\n";

function findNode(doc, name) {
  const n = (doc.nodes || []).find((x) => x.name === name);
  if (!n) throw new Error(`maps.json: node not found: ${name}`);
  return n;
}

function main() {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    process.stderr.write("usage: node tools/sync-workflows.mjs --write|--check\n");
    process.exit(2);
  }

  const raw = readFileSync(MAPS, "utf8");
  const doc = JSON.parse(raw);
  const generated = NODES.map((n) => ({ ...n, code: generate(n) }));

  if (mode === "--write") {
    for (const g of generated) findNode(doc, g.node).parameters.jsCode = g.code;
    writeFileSync(MAPS, serialize(doc));
    process.stdout.write(`sync-workflows: wrote ${generated.length} generated nodes to ${MAPS}\n`);
    return;
  }

  // --check: regenerate in memory, byte-compare the whole file.
  const drift = [];
  for (const g of generated) {
    if (findNode(doc, g.node).parameters.jsCode !== g.code) drift.push(g.node);
  }
  for (const g of generated) findNode(doc, g.node).parameters.jsCode = g.code;
  const expected = serialize(doc);

  if (raw === expected && drift.length === 0) {
    process.stdout.write("sync-workflows: maps.json is in sync with lib/\n");
    return;
  }
  process.stderr.write("sync-workflows: maps.json is OUT OF SYNC with lib/.\n");
  if (drift.length) {
    process.stderr.write(`  drifted node(s): ${drift.join(", ")}\n`);
  } else {
    process.stderr.write("  node jsCode matches but file formatting/other content differs.\n");
  }
  process.stderr.write("  fix: node tools/sync-workflows.mjs --write\n");
  process.exit(1);
}

main();

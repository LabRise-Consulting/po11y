// Mode B collector daemon — poll an existing n8n's public API and publish the
// four dashboard feeds (map.json, forms.json, ai-map.json, status.json) into a
// shared read-only volume. No bootstrap, no owner account, no Docker socket, no
// Execute Command, no write path to n8n.
//
// SECURITY INVARIANTS (enforced here + in collect.mjs):
//   - The n8n API key lives ONLY in this process's env (N8N_API_KEY). It is
//     never logged, never written into any feed file, and never served — the
//     health endpoint below exposes only timestamps/counters.
//   - Every n8n call is a GET (collect.apiGet is the sole choke point); the
//     collector cannot mutate the n8n instance. On n8n CE an API key is
//     unconditionally FULL-ACCESS (scopes are Enterprise-gated), so this
//     GET-only discipline — pinned by the GET-only invariant test — is the real
//     access control, not the key's scope.
//   - The only outbound POST is the optional AI annotation call, which targets
//     AI_MAP_BASE_URL, never N8N_API_URL.

import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchAllWorkflows,
  fetchStatus,
  buildAll,
  makeLlm,
  atomicWriteFile,
} from './collect.mjs';

// ---- config (env only; no config file, no secrets on disk) ------------------
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 600); // seconds
const STATUS_DIR = process.env.STATUS_DIR || '/po11y-status';
const PORT = Number(process.env.PORT || 8081);

const AI_BASE = process.env.AI_MAP_BASE_URL || '';
const AI_KEY = process.env.AI_MAP_API_KEY || '';
const AI_MODEL = process.env.AI_MAP_MODEL || '';
const aiConfigured = !!(AI_BASE && AI_KEY && AI_MODEL);

if (!N8N_API_URL || !N8N_API_KEY) {
  // Never echo the key; only report which var is missing.
  console.error('collector: N8N_API_URL and N8N_API_KEY are required');
  process.exit(2);
}

// Named-volume subdirs don't exist until created — a second collector sets
// STATUS_DIR=/po11y-status/<scope>, and that nested dir has never been
// mkdir'd. The /po11y-status mount is writable even under a read_only
// rootfs, so this is safe at startup, before the first poll.
mkdirSync(STATUS_DIR, { recursive: true });

const feedPath = (name) => join(STATUS_DIR, name);
// LLM transport is built once; only its factory sees the AI key (not logged).
const llm = aiConfigured ? makeLlm(fetch, { base: AI_BASE, key: AI_KEY, model: AI_MODEL }) : null;

// ---- health state -----------------------------------------------------------
const health = { lastSuccess: null, lastError: null, consecutiveFailures: 0 };

// ---- one poll ---------------------------------------------------------------
// On success: publish the feeds and reset the failure counter. On ANY failure:
// log to stderr and KEEP the last-good files (skip all writes) — the dashboard's
// age-based staleness badge signals the gap.
//
// Each feed is written atomically on its own (tmp+rename) and all four share
// one generated_at stamp; this is per-file atomicity, NOT a cross-file
// transaction. A crash mid-cycle can leave some feeds newer than others (each
// still individually valid + parseable); the next successful poll reconciles
// them. An AI outage does not fail the poll — buildAll degrades the ai-map to
// heuristic/last-good while map/forms/status still publish.
async function poll() {
  const workflows = await fetchAllWorkflows(fetch, N8N_API_URL, N8N_API_KEY);

  // Previous ai-map drives differential annotation; missing/corrupt -> null.
  let prevAiMap = null;
  try { prevAiMap = JSON.parse(readFileSync(feedPath('ai-map.json'), 'utf8')); } catch { /* first run */ }

  const now = Date.now();
  const { map, forms, ai } = await buildAll(workflows, prevAiMap, {
    now, forced: false, aiConfigured, model: AI_MODEL, llm,
  });

  const stamp = new Date(now).toISOString();

  atomicWriteFile(feedPath('map.json'), JSON.stringify({
    generated_at: stamp, mermaid: map.mermaid, workflows: map.workflows,
  }));
  atomicWriteFile(feedPath('forms.json'), JSON.stringify({
    generated_at: stamp, forms: forms.forms,
  }));

  // ai-map: buildAiMap owns the publish policy. Only 'publish'/'republish'
  // yield a map to write; 'skip-fresh'/'keep-annotated' leave the file as-is.
  // CAUTION: on 'republish' buildAiMap returns the caller's `prevAiMap` object
  // mutated (generated_at deleted). Stamp and write `ai.map` — never touch
  // prevAiMap afterwards.
  if (ai.map) {
    ai.map.generated_at = stamp;
    atomicWriteFile(feedPath('ai-map.json'), JSON.stringify(ai.map));
  }
  for (const w of (ai.summary?.warnings || [])) console.error(w);
  // AI outage degraded the annotation but the poll still succeeded — surface it.
  if (ai.degraded) console.error(`collector: ai-map degraded (LLM unavailable) — ${ai.degraded}`);

  // status.json is always published (empty object if executions API is off).
  const { status, warning } = await fetchStatus(fetch, N8N_API_URL, N8N_API_KEY, { now });
  if (warning) console.error(warning);
  atomicWriteFile(feedPath('status.json'), JSON.stringify({ generated_at: stamp, ...status }));
}

async function tick() {
  try {
    await poll();
    health.lastSuccess = new Date().toISOString();
    health.consecutiveFailures = 0;
  } catch (e) {
    health.lastError = new Date().toISOString();
    health.consecutiveFailures += 1;
    // Log the message only (an error object could carry request context; keep
    // it terse and key-free).
    console.error(`collector: poll failed (${health.consecutiveFailures}) — ${e.message}`);
  }
}

// ---- health endpoint --------------------------------------------------------
// Exposes ONLY liveness counters/timestamps — no config, no key, no feed data.
// 503 once three consecutive polls have failed so an orchestrator can restart.
const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url.startsWith('/healthz?'))) {
    const code = health.consecutiveFailures >= 3 ? 503 : 200;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

// ---- lifecycle --------------------------------------------------------------
let timer = null;
function schedule() {
  timer = setTimeout(async () => {
    await tick();
    schedule(); // re-arm only after the poll settles (no overlapping polls)
  }, POLL_INTERVAL * 1000);
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`collector: ${signal} received, shutting down`);
  if (timer) clearTimeout(timer);
  server.close(() => process.exit(0));
  // Fallback in case an idle keep-alive holds the server open.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A failure to bind the health port (e.g. EADDRINUSE) is fatal and must not
// leave a half-started, health-less daemon running — report and exit non-zero.
server.on('error', (e) => {
  console.error(`collector: health server error on :${PORT} — ${e.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.error(`collector: polling ${N8N_API_URL} every ${POLL_INTERVAL}s -> ${STATUS_DIR}; health on :${PORT}/healthz`);
});

// Poll immediately on boot, then on the interval.
(async () => { await tick(); schedule(); })();

// Mode B collector — pure-ish core, unit-testable.
//
// Po11y's Mode B points at an n8n you already run and derives the same
// dashboard feeds Mode A's in-n8n workflows publish, by polling n8n's public
// REST API read-only. Everything here is a normal Node module, so it imports
// the shared lib/ builders directly (the Mode A equivalents are the same
// source inlined into Code nodes by tools/sync-workflows.mjs — imports are
// forbidden inside the n8n Code sandbox, allowed HERE).
//
// SECURITY: every n8n API call goes through apiGet(), which hard-codes
// method:'GET'. The collector has no write path to n8n of any kind. See the
// GET-only invariant test in collect.test.mjs. The one outbound POST the core
// can make is the optional LLM annotation call — it targets the AI_MAP_*
// base URL, never N8N_API_URL.

import { writeFileSync, renameSync } from 'node:fs';
import { buildMap } from '../lib/build-map.mjs';
import { buildForms } from '../lib/build-forms.mjs';
import { buildAiMap } from '../lib/build-ai-map.mjs';

/**
 * Read-only GET against the n8n public API. The single choke point that keeps
 * the collector's "no write path" promise true: method is always GET, the API
 * key rides only in the X-N8N-API-KEY header (never a query string, never a
 * body). baseUrl is the n8n root (N8N_API_URL); path carries the /api/v1/...
 * segment and its own query string.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} path - starts with '/api/v1/...'
 * @returns {Promise<any>} parsed JSON body
 */
export async function apiGet(fetchFn, baseUrl, apiKey, path) {
  const url = String(baseUrl).replace(/\/$/, '') + path;
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { 'X-N8N-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/**
 * Page every workflow on the instance.
 *
 * n8n caps `limit` at 250, so we page via the opaque `nextCursor` (fed back as
 * `?cursor=`) until it is null. `excludePinnedData=true` drops pinned run data
 * we never use. There is NO slim-listing param: every node's full parameters
 * transfer on every poll — acceptable at our cadence (default 600 s), and the
 * price of getting nodes[]/connections in one round trip.
 *
 * isArchived filtering is deliberately NOT done here (there is no query filter
 * for it anyway) — the lib builders each filter archived entries themselves.
 *
 * Defensive nodes-fallback (per reviewer): GET /workflows normally returns full
 * objects incl. nodes[] (that excludePinnedData exists proves the payload is
 * heavy). But some n8n versions/proxies may hand back a slim list without
 * `nodes`. After paging, any workflow missing an Array `nodes` is re-fetched
 * individually via GET /workflows/{id} (still GET-only) and replaced with the
 * detailed object, so the builders always see real node arrays.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {string} apiKey
 * @returns {Promise<object[]>} combined `data` arrays across all pages
 */
export async function fetchAllWorkflows(fetchFn, baseUrl, apiKey) {
  const all = [];
  let cursor = null;
  // Guard against a server that keeps handing back a cursor it already gave us:
  // without this a buggy/hostile nextCursor could page forever.
  const seenCursors = new Set();
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error(`fetchAllWorkflows: repeated cursor "${cursor}" — pagination did not advance`);
      }
      seenCursors.add(cursor);
    }
    const qs = new URLSearchParams({ limit: '250', excludePinnedData: 'true' });
    if (cursor) qs.set('cursor', cursor);
    const page = await apiGet(fetchFn, baseUrl, apiKey, `/api/v1/workflows?${qs.toString()}`);
    if (Array.isArray(page.data)) all.push(...page.data);
    cursor = page.nextCursor || null;
  } while (cursor);

  for (let i = 0; i < all.length; i++) {
    if (!Array.isArray(all[i].nodes)) {
      const detail = await apiGet(
        fetchFn, baseUrl, apiKey,
        `/api/v1/workflows/${encodeURIComponent(all[i].id)}`,
      );
      all[i] = detail;
    }
  }
  return all;
}

/**
 * Mode B's status.json content, sourced from the n8n API rather than a Docker
 * socket (Mode B never touches Docker). One GET against the executions API —
 * the recent window — folds into an at-a-glance execution health summary.
 *
 * Dashboard section key: `executions` (config `sections.executions`). The
 * dashboard renders status.json sections generically from config; app.js has a
 * dedicated renderer for `containers`/`notifications` and a config-driven
 * heading for anything else.
 *
 * Shape:
 *   { executions: { recent, errors, byWorkflow: [{ name, id, count, errors, lastAt }] } }
 * where recent = size of the recent window and errors = the failures WITHIN
 * that same window, so the dashboard's "N recent · M errors" is a real rate.
 * (An earlier version sourced `errors` from a separate error-only query that
 * reached past the recent 100; both counts capped at the API limit of 100 and
 * rendered side by side, which read as a 100% failure rate.) byWorkflow is the
 * recent window aggregated per workflow (top ~10 by count desc, so the
 * per-workflow counts sum to `recent`).
 *
 * The executions API can be disabled on an instance; on ANY failure this
 * returns { status: {}, warning: <string> } so the daemon still publishes a
 * timestamped (empty) status.json and logs the warning.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ now?: number, names?: Map<string,string> }} [opts] - `names` is an
 *   id->name map from the already-fetched workflow list; the executions API
 *   omits workflowName, so without it the dashboard renders opaque n8n ids.
 * @returns {Promise<{ status: object, warning: (string|null) }>}
 */
export async function fetchStatus(fetchFn, baseUrl, apiKey, { now = Date.now(), names = null } = {}) {
  void now; // reserved for future time-window math; keeps the signature stable
  try {
    const recentRes = await apiGet(fetchFn, baseUrl, apiKey, '/api/v1/executions?limit=100');
    const recent = Array.isArray(recentRes.data) ? recentRes.data : [];

    const byId = new Map();
    for (const e of recent) {
      const id = String(e.workflowId ?? '');
      // executions without includeData omit the name: prefer whatever the
      // execution carries, then the caller's workflow-list map, then the id.
      const name = e.workflowName || (e.workflowData || {}).name || names?.get(id) || id;
      const at = e.startedAt || e.stoppedAt || e.createdAt || null;
      let g = byId.get(id);
      if (!g) { g = { name, id, count: 0, errors: 0, lastAt: null }; byId.set(id, g); }
      if (g.name === id && name !== id) g.name = name; // upgrade id->real name
      g.count += 1;
      if (e.status === 'error') g.errors += 1;
      if (at && (!g.lastAt || new Date(at) > new Date(g.lastAt))) g.lastAt = at;
    }
    const byWorkflow = [...byId.values()]
      .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
      .slice(0, 10);

    const errors = recent.reduce((n, e) => n + (e.status === 'error' ? 1 : 0), 0);
    return {
      status: { executions: { recent: recent.length, errors, byWorkflow } },
      warning: null,
    };
  } catch (e) {
    return { status: {}, warning: `status: executions API unavailable — ${e.message}` };
  }
}

/**
 * Build an LLM transport reproducing the exact /chat/completions request the
 * Mode A ai-map Code node makes (POST to {base}/chat/completions, bearer key,
 * JSON-object response format, max_tokens 3000, returns the first choice's
 * message content). Base/key/model come from AI_MAP_BASE_URL/AI_MAP_API_KEY/
 * AI_MAP_MODEL. This is the ONLY non-GET the core issues, and it never targets
 * the n8n host.
 *
 * @param {typeof fetch} fetchFn
 * @param {{ base: string, key: string, model: string }} cfg
 * @returns {(prompt: string) => Promise<string>}
 */
export function makeLlm(fetchFn, { base, key, model }) {
  const url = `${String(base).replace(/\/$/, '')}/chat/completions`;
  return async (prompt) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 3000,
      }),
    });
    if (!res.ok) throw new Error(`LLM POST -> ${res.status}`);
    const data = await res.json();
    return ((data.choices || [])[0] || {}).message?.content || '';
  };
}

/**
 * Thin composition over the three shared lib builders. buildMap/buildForms are
 * synchronous; buildAiMap is async and owns its own publish policy — the caller
 * supplies `prev` (previous ai-map.json), `now`, and the AI config/transport.
 *
 * @param {object[]} workflows - raw workflow list from fetchAllWorkflows
 * @param {object|null} prevAiMap - previously published ai-map.json, or null
 * @param {{ now?: number, forced?: boolean, aiConfigured?: boolean, model?: string, llm?: (function|null) }} [opts]
 * @returns {Promise<{ map: object, forms: object, ai: object }>}
 */
export async function buildAll(workflows, prevAiMap, opts = {}) {
  const { now = Date.now(), forced = false, aiConfigured = false, model = '', llm = null } = opts;
  const map = buildMap(workflows);
  const forms = buildForms(workflows);
  // The AI annotation is best-effort and must NOT be able to abort the poll:
  // in Mode A map/forms/status are separate n8n nodes that publish regardless
  // of the ai-map node failing. An llm-layer throw (AI outage / rate-limit)
  // propagates out of buildAiMap (its internal try only guards JSON.parse, not
  // the transport). Catch it HERE (collector-side; lib/ fidelity is frozen) and
  // degrade: re-run the builder with no LLM so buildAiMap's OWN policy applies —
  // sameStructure+prevAnnotated -> keep-annotated (last-good annotated map
  // stays); changed structure -> heuristic publish. aiConfigured:false so it
  // never calls the LLM again. `prevAiMap` is safe to reuse: buildAiMap only
  // mutates prev on the republish branch, which returns before any llm call.
  let ai;
  try {
    ai = await buildAiMap(workflows, { prev: prevAiMap, forced, now, aiConfigured, model, llm });
  } catch (e) {
    ai = await buildAiMap(workflows, { prev: prevAiMap, forced, now, aiConfigured: false, model: '', llm: null });
    ai.degraded = e.message;
  }
  return { map, forms, ai };
}

/**
 * Atomic single-file publish: write to `${path}.tmp` then rename over `path`.
 * rename(2) is atomic within a filesystem, so a reader (nginx) never sees a
 * half-written feed — same tmp+rename convention the Mode A Code nodes use.
 * The tmp file MUST sit on the same volume as the target (it does: same dir).
 *
 * @param {string} path
 * @param {string} data
 */
export function atomicWriteFile(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

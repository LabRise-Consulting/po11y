import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiGet,
  fetchAllWorkflows,
  fetchStatus,
  buildAll,
  makeLlm,
  atomicWriteFile,
} from './collect.mjs';

const core = JSON.parse(
  readFileSync(new URL('../lib/__fixtures__/core-workflows.json', import.meta.url), 'utf8'),
);

const N8N = 'http://n8n.test';
const AI = 'http://ai.test/v1';
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// ---- pagination -------------------------------------------------------------
test('fetchAllWorkflows pages 3 cursors, propagates ?cursor, always sends limit=250', async () => {
  const pages = {
    // no cursor -> page 1, then cursorB, then cursorC, then null
    '': { data: [{ id: '1', nodes: [] }], nextCursor: 'curB' },
    curB: { data: [{ id: '2', nodes: [] }], nextCursor: 'curC' },
    curC: { data: [{ id: '3', nodes: [] }], nextCursor: null },
  };
  const seen = [];
  const fetchFn = async (url, opts) => {
    const u = new URL(url);
    assert.equal(opts.method, 'GET');
    assert.equal(u.searchParams.get('limit'), '250', 'limit=250 on every page');
    assert.equal(u.searchParams.get('excludePinnedData'), 'true');
    const cursor = u.searchParams.get('cursor') || '';
    seen.push(cursor);
    return jsonRes(pages[cursor]);
  };
  const all = await fetchAllWorkflows(fetchFn, N8N, 'k');
  assert.deepEqual(seen, ['', 'curB', 'curC'], 'cursor propagated page to page');
  assert.deepEqual(all.map((w) => w.id), ['1', '2', '3']);
});

test('fetchAllWorkflows throws when the server keeps returning the same cursor', async () => {
  const fetchFn = async () => jsonRes({ data: [{ id: 'x', nodes: [] }], nextCursor: 'stuck' });
  await assert.rejects(() => fetchAllWorkflows(fetchFn, N8N, 'k'), /repeated cursor/);
});

// ---- defensive nodes-fallback (addendum) ------------------------------------
test('full list (every workflow has nodes[]) triggers ZERO detail fetches', async () => {
  let detailFetches = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v1/workflows/')) detailFetches += 1;
    return jsonRes({ data: [{ id: 'a', nodes: [] }, { id: 'b', nodes: [] }], nextCursor: null });
  };
  const all = await fetchAllWorkflows(fetchFn, N8N, 'k');
  assert.equal(detailFetches, 0);
  assert.equal(all.length, 2);
});

test('slim list (workflow without nodes[]) triggers one detail fetch per slim workflow', async () => {
  const detailIds = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v1/workflows/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      detailIds.push(id);
      return jsonRes({ id, nodes: [{ name: 'n', type: 'x', parameters: {} }] });
    }
    // slim list: 'a' has nodes, 'b' and 'c' do not
    return jsonRes({
      data: [{ id: 'a', nodes: [] }, { id: 'b' }, { id: 'c' }],
      nextCursor: null,
    });
  };
  const all = await fetchAllWorkflows(fetchFn, N8N, 'k');
  assert.deepEqual(detailIds.sort(), ['b', 'c'], 'exactly the slim workflows re-fetched');
  assert.ok(all.every((w) => Array.isArray(w.nodes)), 'all workflows end up with nodes[]');
});

// ---- GET-only invariant (binding security control) --------------------------
test('a full fetch+build cycle makes ONLY GET calls to the n8n host; the LLM POST goes to the AI base', async () => {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method });
    if (url.startsWith(N8N)) {
      // Hard fail on any non-GET to the n8n host — this is the security control.
      assert.equal(method, 'GET', `non-GET to n8n host: ${method} ${url}`);
      const u = new URL(url);
      if (u.pathname === '/api/v1/workflows') return jsonRes({ data: core, nextCursor: null });
      if (u.pathname.startsWith('/api/v1/workflows/')) {
        const id = decodeURIComponent(u.pathname.split('/').pop());
        return jsonRes(core.find((w) => String(w.id) === id));
      }
      if (u.pathname === '/api/v1/executions') {
        return u.searchParams.get('status') === 'error'
          ? jsonRes({ data: [] })
          : jsonRes({ data: [{ workflowId: '1', status: 'success', startedAt: '2026-07-19T00:00:00Z' }] });
      }
    }
    if (url.startsWith(AI)) {
      return jsonRes({ choices: [{ message: { content: '{"lede":"x","subs":{},"notes":[]}' } }] });
    }
    return jsonRes({ error: 'unexpected' }, 404);
  };

  const workflows = await fetchAllWorkflows(fetchFn, N8N, 'secret-key');
  await fetchStatus(fetchFn, N8N, 'secret-key', { now: Date.now() });
  const llm = makeLlm(fetchFn, { base: AI, key: 'ai-key', model: 'm' });
  await buildAll(workflows, null, { now: Date.now(), aiConfigured: true, model: 'm', llm });

  const n8nCalls = calls.filter((c) => c.url.startsWith(N8N));
  assert.ok(n8nCalls.length > 0, 'the cycle actually hit the n8n host');
  assert.ok(n8nCalls.every((c) => c.method === 'GET'), 'every n8n call is a GET');
  // The only non-GET in the whole cycle is the LLM POST, and it targets AI, not n8n.
  const nonGet = calls.filter((c) => c.method !== 'GET');
  assert.ok(nonGet.length >= 1, 'the LLM POST fired (aiConfigured cycle)');
  assert.ok(nonGet.every((c) => c.url.startsWith(AI)), 'all non-GET calls go to the AI base');
  assert.ok(!calls.some((c) => c.url.startsWith(N8N) && c.method === 'POST'), 'no POST ever to n8n');
});

// ---- fetchStatus ------------------------------------------------------------
test('fetchStatus builds the executions summary shape, sorted by count desc', async () => {
  const recent = [
    { workflowId: '1', workflowName: 'Alpha', status: 'success', startedAt: '2026-07-19T01:00:00Z' },
    { workflowId: '1', workflowName: 'Alpha', status: 'error', startedAt: '2026-07-19T02:00:00Z' },
    { workflowId: '1', workflowName: 'Alpha', status: 'success', startedAt: '2026-07-19T03:00:00Z' },
    { workflowId: '2', workflowName: 'Beta', status: 'success', startedAt: '2026-07-19T01:30:00Z' },
  ];
  const fetchFn = async () => jsonRes({ data: recent });

  const { status, warning } = await fetchStatus(fetchFn, N8N, 'k', { now: Date.now() });
  assert.equal(warning, null);
  const ex = status.executions;
  assert.equal(ex.recent, 4);
  // errors counts failures WITHIN the recent window so the pair is a real rate.
  assert.equal(ex.errors, 1);
  assert.equal(ex.byWorkflow.length, 2);
  assert.deepEqual(ex.byWorkflow[0], { name: 'Alpha', id: '1', count: 3, errors: 1, lastAt: '2026-07-19T03:00:00Z' });
  assert.deepEqual(ex.byWorkflow[1], { name: 'Beta', id: '2', count: 1, errors: 0, lastAt: '2026-07-19T01:30:00Z' });
});

test('fetchStatus name falls back to workflowId when the execution omits a name', async () => {
  const fetchFn = async () =>
    jsonRes({ data: [{ workflowId: '42', status: 'success', startedAt: '2026-07-19T00:00:00Z' }] });
  const { status } = await fetchStatus(fetchFn, N8N, 'k', {});
  assert.equal(status.executions.byWorkflow[0].name, '42');
});

test('fetchStatus issues exactly ONE executions GET (recent window is the only source)', async () => {
  const paths = [];
  const fetchFn = async (url) => { paths.push(new URL(url).pathname + new URL(url).search); return jsonRes({ data: [] }); };
  await fetchStatus(fetchFn, N8N, 'k', {});
  assert.deepEqual(paths, ['/api/v1/executions?limit=100']);
});

test('fetchStatus resolves names from the caller-supplied id->name map', async () => {
  // The executions API omits workflowName, but the daemon has already fetched
  // every workflow — without this the dashboard shows opaque n8n ids.
  const fetchFn = async () =>
    jsonRes({ data: [
      { workflowId: '42', status: 'success', startedAt: '2026-07-19T00:00:00Z' },
      { workflowId: '99', status: 'success', startedAt: '2026-07-19T00:00:00Z' },
    ] });
  const names = new Map([['42', 'Nightly digest']]);
  const { status } = await fetchStatus(fetchFn, N8N, 'k', { names });
  const byId = Object.fromEntries(status.executions.byWorkflow.map((w) => [w.id, w.name]));
  assert.equal(byId['42'], 'Nightly digest', 'name resolved from the map');
  assert.equal(byId['99'], '99', 'unknown id still falls back to the id');
});

test('fetchStatus prefers an execution-supplied name over the map', async () => {
  const fetchFn = async () =>
    jsonRes({ data: [{ workflowId: '42', workflowName: 'From execution', status: 'success' }] });
  const { status } = await fetchStatus(fetchFn, N8N, 'k', { names: new Map([['42', 'From map']]) });
  assert.equal(status.executions.byWorkflow[0].name, 'From execution');
});

test('fetchStatus returns {} + a warning when the executions API is unavailable', async () => {
  const fetchFn = async () => jsonRes({ message: 'disabled' }, 404);
  const { status, warning } = await fetchStatus(fetchFn, N8N, 'k', {});
  assert.deepEqual(status, {});
  assert.equal(typeof warning, 'string');
  assert.ok(warning.length > 0);
});

// ---- buildAll wiring --------------------------------------------------------
test('buildAll wires the three lib builders (map graph TD, forms found, heuristic ai-map without llm)', async () => {
  const { map, forms, ai } = await buildAll(core, null, {
    now: Date.now(), aiConfigured: false, model: '', llm: null,
  });
  assert.ok(map.mermaid.startsWith('graph TD'), 'map came from build-map');
  assert.equal(forms.forms.length, 2, 'forms came from build-forms');
  assert.equal(ai.action, 'publish');
  assert.equal(ai.map.model, 'heuristic', 'ai-map is heuristic with no LLM configured');
});

test('buildAll degrades to a heuristic ai-map when the LLM throws (poll must not abort)', async () => {
  const throwingLlm = async () => { throw new Error('AI gateway 503'); };
  const { map, forms, ai } = await buildAll(core, null, {
    now: Date.now(), aiConfigured: true, model: 'gpt-x', llm: throwingLlm,
  });
  // map + forms are unaffected by the AI outage.
  assert.ok(map.mermaid.startsWith('graph TD'));
  assert.equal(forms.forms.length, 2);
  // ai-map degraded (not thrown): a writable heuristic map, degradation recorded.
  assert.equal(ai.action, 'publish');
  assert.equal(ai.map.model, 'heuristic');
  assert.match(ai.degraded, /AI gateway 503/);
});

// ---- atomic write helper ----------------------------------------------------
test('atomicWriteFile writes via tmp then rename and leaves no .tmp behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-collect-'));
  try {
    const target = join(dir, 'map.json');
    atomicWriteFile(target, '{"ok":true}');
    assert.equal(readFileSync(target, 'utf8'), '{"ok":true}');
    assert.ok(!existsSync(`${target}.tmp`), 'the tmp file was renamed away');
    assert.deepEqual(readdirSync(dir), ['map.json'], 'only the final file remains');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- apiGet header ----------------------------------------------------------
test('apiGet sends the key in X-N8N-API-KEY (header, not query) and throws on non-2xx', async () => {
  let sawHeader = null;
  const ok = async (url, opts) => { sawHeader = opts.headers['X-N8N-API-KEY']; return jsonRes({ data: [] }); };
  await apiGet(ok, N8N, 'my-key', '/api/v1/workflows');
  assert.equal(sawHeader, 'my-key');
  await assert.rejects(() => apiGet(async () => jsonRes({}, 500), N8N, 'k', '/api/v1/workflows'));
});

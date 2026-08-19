import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  apiGet,
  apiGetPaged,
  fetchAllWorkflows,
  fetchStatus,
  fetchExecutions,
  buildAll,
  makeLlm,
  feedDocuments,
} from './n8n.mjs';

const core = JSON.parse(
  readFileSync(new URL('./build/__fixtures__/core-workflows.json', import.meta.url), 'utf8'),
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
  assert.deepEqual(ex.byWorkflow[0], { name: 'Alpha', id: '1', count: 3, errors: 1, lastAt: '2026-07-19T03:00:00Z', running: 0 });
  assert.deepEqual(ex.byWorkflow[1], { name: 'Beta', id: '2', count: 1, errors: 0, lastAt: '2026-07-19T01:30:00Z', running: 0 });
});

test('fetchStatus keeps every workflow in the window, not a top-N slice', async () => {
  // 50 workflows, each with a distinct run count, so the dashboard's filter box
  // can find the quietest one. A server-side top-10 made workflows 11..50
  // unreachable: the client filters what it was sent.
  const recent = [];
  for (let i = 1; i <= 50; i++) {
    for (let n = 0; n < 51 - i; n++) {
      recent.push({
        workflowId: String(i),
        workflowName: `Workflow ${i}`,
        status: 'success',
        startedAt: '2026-07-19T01:00:00Z',
      });
    }
  }
  const fetchFn = async () => jsonRes({ data: recent });

  const { status } = await fetchStatus(fetchFn, N8N, 'k', { now: Date.now() });
  const ex = status.executions;
  assert.equal(ex.byWorkflow.length, 50);
  assert.equal(ex.byWorkflow[0].name, 'Workflow 1', 'busiest first');
  assert.equal(ex.byWorkflow[49].name, 'Workflow 50', 'quietest last');
  assert.ok(ex.byWorkflow.some((w) => w.name === 'Workflow 42'), 'a workflow past the display cap is present');
  // Uncapped means the per-workflow counts add up to `recent` again.
  assert.equal(ex.byWorkflow.reduce((n, w) => n + w.count, 0), ex.recent);
});

test('fetchStatus counts crashed executions as errors, both totals and per-workflow', async () => {
  const recent = [
    { workflowId: '1', workflowName: 'Alpha', status: 'crashed', startedAt: '2026-07-19T01:00:00Z' },
    { workflowId: '1', workflowName: 'Alpha', status: 'error', startedAt: '2026-07-19T02:00:00Z' },
    { workflowId: '2', workflowName: 'Beta', status: 'canceled', startedAt: '2026-07-19T01:30:00Z' },
  ];
  const { status } = await fetchStatus(async () => jsonRes({ data: recent }), N8N, 'k', {});
  const ex = status.executions;
  assert.equal(ex.errors, 2, 'crashed is a failure; canceled is not');
  assert.equal(ex.byWorkflow.find((w) => w.id === '1').errors, 2);
  assert.equal(ex.byWorkflow.find((w) => w.id === '2').errors, 0);
});

// The dashboard's execution rows claim to say what is running "right now", so
// the status projection must carry the still-running executions that
// summarizeExecutions tracks for the watchdog's `stuck` rule.
test('fetchStatus reports the per-workflow count of still-running executions', async () => {
  const recent = [
    { id: 'e1', workflowId: '1', workflowName: 'Alpha', status: 'running', startedAt: '2026-07-19T03:00:00Z' },
    { id: 'e2', workflowId: '1', workflowName: 'Alpha', status: 'running', startedAt: '2026-07-19T02:50:00Z' },
    { id: 'e3', workflowId: '1', workflowName: 'Alpha', status: 'success', startedAt: '2026-07-19T02:00:00Z' },
    { id: 'e4', workflowId: '2', workflowName: 'Beta', status: 'success', startedAt: '2026-07-19T01:30:00Z' },
  ];
  const { status } = await fetchStatus(async () => jsonRes({ data: recent }), N8N, 'k', { now: Date.now() });
  const ex = status.executions;
  assert.equal(ex.byWorkflow.find((w) => w.id === '1').running, 2);
  // A number, not undefined: the renderer should not have to distinguish
  // "none running" from "this build does not report running".
  assert.equal(ex.byWorkflow.find((w) => w.id === '2').running, 0);
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
  assert.deepEqual(paths, ['/api/v1/executions?limit=250']);
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

test('buildAll survives an ai-map throw the no-LLM retry cannot fix', async () => {
  // buildAll's catch assumes any throw came from the LLM transport and retries
  // with llm:null. A defect that is NOT the transport throws on both attempts;
  // before the fix the second throw escaped buildAll and took map.json,
  // forms.json and status.json down with the cosmetic ai-map — and because
  // poll() keeps last-good files on failure, the feeds froze permanently.
  //
  // prevAiMap is the one input only buildAiMap reads, so a throwing accessor on
  // it fails exactly the ai-map builder, on both attempts, without disturbing
  // buildMap/buildForms.
  const poisonedPrev = { get nodes() { throw new Error('ai-map input unreadable'); } };
  const { map, forms, ai } = await buildAll(core, poisonedPrev, {
    now: Date.now(), aiConfigured: false, model: '', llm: null,
  });
  assert.ok(map.mermaid.startsWith('graph TD'), 'map still published');
  assert.ok(Array.isArray(forms.forms), 'forms still published');
  assert.equal(ai.action, 'skip', 'ai-map degrades to a no-op instead of throwing');
  assert.match(ai.degraded, /ai-map input unreadable/);
});

// ---- makeLlm request fidelity -----------------------------------------------
test('makeLlm sends stream:false — OmniRoute routes default to SSE without it', async () => {
  let body = null;
  const fetchFn = async (url, opts) => {
    body = JSON.parse(opts.body);
    return jsonRes({ choices: [{ message: { content: '{}' } }] });
  };
  const llm = makeLlm(fetchFn, { base: AI, key: 'k', model: 'auto/best-free' });
  await llm('prompt');
  assert.equal(body.stream, false, 'without this res.json() throws on an SSE reply');
  assert.equal(body.model, 'auto/best-free');
  assert.equal(body.max_tokens, 16_000);
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('makeLlm takes the token budget from config so a reasoning model can be paid for', async () => {
  let body = null;
  const fetchFn = async (url, opts) => {
    body = JSON.parse(opts.body);
    return jsonRes({ choices: [{ message: { content: '{}' } }] });
  };
  const llm = makeLlm(fetchFn, { base: AI, key: 'k', model: 'm', maxTokens: 24_000 });
  await llm('prompt');
  assert.equal(body.max_tokens, 24_000);
});

test('makeLlm reports a truncated answer as truncation, not as broken JSON', async () => {
  // A reasoning model spends the SAME budget on its thinking, so the visible
  // answer can stop mid-string. Returning it hands the caller half a document
  // and a "Unterminated string in JSON" that names neither the cause nor the
  // fix — and the ai-map then degrades to heuristic text for good, on the
  // bundled default route, with nothing in the log pointing at max_tokens.
  const fetchFn = async () => jsonRes({
    choices: [{ finish_reason: 'length', message: { content: '{"subs": {"wf:1": "half a sen' } }],
  });
  const llm = makeLlm(fetchFn, { base: AI, key: 'k', model: 'm', maxTokens: 3000 });
  await assert.rejects(() => llm('prompt'), /truncated/i);
});

// ---- feed documents ----------------------------------------------------------
//
// The server is the sole publisher of map.json/forms.json, so these are direct
// shape assertions.
test('map.json entries carry the mermaid node id back to the raw n8n workflow', async () => {
  // site/map.html keys its dialog off entries[].nid and early-returns without
  // them — this is the payload that makes the Map tab clickable.
  const { map, forms } = await buildAll(core, null, { now: 0, aiConfigured: false, llm: null });
  const { entries } = feedDocuments({ map, forms }, '2026-08-06T00:00:00.000Z')['map.json'];
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.match(e.nid, /^wf_/);
    assert.ok(e.id !== undefined && e.name && typeof e.sub === 'string');
    assert.ok(map.mermaid.includes(e.nid), 'every entry names a node the diagram drew');
  }
});

test('feedDocuments stamps both feeds with the caller\'s single generated_at', async () => {
  const { map, forms } = await buildAll(core, null, { now: 0, aiConfigured: false, llm: null });
  const docs = feedDocuments({ map, forms }, 'STAMP');
  assert.equal(docs['map.json'].generated_at, 'STAMP');
  assert.equal(docs['forms.json'].generated_at, 'STAMP');
});

// ---- apiGet header ----------------------------------------------------------
test('apiGet sends the key in X-N8N-API-KEY (header, not query) and throws on non-2xx', async () => {
  let sawHeader = null;
  const ok = async (url, opts) => { sawHeader = opts.headers['X-N8N-API-KEY']; return jsonRes({ data: [] }); };
  await apiGet(ok, N8N, 'my-key', '/api/v1/workflows');
  assert.equal(sawHeader, 'my-key');
  await assert.rejects(() => apiGet(async () => jsonRes({}, 500), N8N, 'k', '/api/v1/workflows'));
});

// ---- executions reuse -------------------------------------------------------
test('fetchStatus reuses pre-fetched executions instead of issuing a second GET', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return jsonRes({ data: [] }); };
  const executions = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' }];
  const { status } = await fetchStatus(fetchFn, N8N, 'k', { now: Date.now(), executions });
  assert.equal(calls, 0, 'the watchdog and status.json must share one executions fetch');
  assert.equal(status.executions.recent, 1);
});

test('fetchExecutions returns the raw execution list via a GET', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push({ url, method: opts.method });
    return jsonRes({ data: [{ workflowId: 'a', status: 'error' }] });
  };
  const out = await fetchExecutions(fetchFn, N8N, 'k');
  assert.equal(out.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.match(seen[0].url, /\/api\/v1\/executions\?limit=250/);
});

test('fetchExecutions returns an empty list when the executions API is disabled', async () => {
  const fetchFn = async () => jsonRes({ message: 'not found' }, 404);
  assert.deepEqual(await fetchExecutions(fetchFn, N8N, 'k'), []);
});

test('fetchExecutions honors a caller-supplied window size', async () => {
  const paths = [];
  const fetchFn = async (url) => { paths.push(new URL(url).search); return jsonRes({ data: [] }); };
  // Deliberately not 250: that is the default now, so it would pass without
  // the caller's value ever being read.
  await fetchExecutions(fetchFn, N8N, 'k', 120);
  assert.deepEqual(paths, ['?limit=120']);
});

test('fetchExecutions clamps the window to the n8n API cap of 250', async () => {
  const paths = [];
  const fetchFn = async (url) => { paths.push(new URL(url).search); return jsonRes({ data: [] }); };
  await fetchExecutions(fetchFn, N8N, 'k', 1000);
  assert.deepEqual(paths, ['?limit=250']);
});

test('fetchExecutions floors a nonsensical window to 1', async () => {
  const paths = [];
  const fetchFn = async (url) => { paths.push(new URL(url).search); return jsonRes({ data: [] }); };
  await fetchExecutions(fetchFn, N8N, 'k', 0);
  assert.deepEqual(paths, ['?limit=1']);
});

test('fetchStatus fallback fetch uses the same caller-supplied window size', async () => {
  const paths = [];
  const fetchFn = async (url) => { paths.push(new URL(url).search); return jsonRes({ data: [] }); };
  await fetchStatus(fetchFn, N8N, 'k', { limit: 120 });
  assert.deepEqual(paths, ['?limit=120']);
});

// ---- apiGetPaged (shared pager) ----------------------------------------------
test('apiGetPaged follows nextCursor to the end and passes params through', async () => {
  const pages = { '': { data: ['a'], nextCursor: 'c1' }, c1: { data: ['b'], nextCursor: null } };
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => pages[new URL(url).searchParams.get('cursor') || ''] };
  };
  const seen = [];
  for await (const page of apiGetPaged(fetchFn, N8N, 'k', '/api/v1/things', { limit: '250' })) {
    seen.push(page.data[0]);
  }
  assert.deepEqual(seen, ['a', 'b']);
  assert.match(urls[0], /limit=250/);
  assert.match(urls[1], /cursor=c1/);
});

test('apiGetPaged throws on a repeated cursor instead of paging forever', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: [], nextCursor: 'same' }) });
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const page of apiGetPaged(fetchFn, N8N, 'k', '/api/v1/things')) { /* drain */ }
  }, /repeated cursor/);
});

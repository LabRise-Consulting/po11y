import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recentExecutions } from './db.mjs';
import { route } from './http.mjs';

const ctx = (over = {}) => ({
  db: openDb(':memory:'),
  scope: 'default',
  ingestToken: 'sekrit',
  health: () => ({ ok: true, consecutiveFailures: 0, lastSuccess: 'x', lastError: null }),
  feeds: () => ({ 'status.json': { generated_at: 'x' }, 'forms.json': { forms: [] } }),
  ...over,
});
const req = (method, url, body = null, headers = {}) => ({ method, url, body, headers });
const auth = { authorization: 'Bearer sekrit' };
const EVENT = JSON.stringify({
  eventName: 'n8n.workflow.success',
  ts: '2026-08-11T02:00:05.000Z',
  payload: { executionId: '9', workflowId: 'wf1' },
});

test('flat feed paths serve the built document as JSON, marked as server-served', async () => {
  const res = await route(req('GET', '/status.json'), ctx());
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['x-po11y-source'], 'po11y-server');
  assert.deepEqual(JSON.parse(res.body), { generated_at: 'x' });
});

test('the scoped path serves the document for this server own scope', async () => {
  const res = await route(req('GET', '/status/example/status.json'), ctx({ scope: 'example' }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { generated_at: 'x' });
});

test('another instance scope 404s rather than serving this instance data', async () => {
  const res = await route(req('GET', '/status/other/status.json'), ctx({ scope: 'example' }));
  assert.equal(res.status, 404);
});

test('a scope key with illegal characters 404s', async () => {
  const res = await route(req('GET', '/status/..%2fetc/status.json'), ctx());
  assert.equal(res.status, 404);
});

test('an unknown feed name 404s', async () => {
  assert.equal((await route(req('GET', '/alert-state.json'), ctx())).status, 404);
});

// A cold store's ai-map.json defaults to null (index.mjs seedCache) until the
// first rebuild completes. Serving 200 with a JSON body of `null` there would
// be a lie files mode never told — a missing feed FILE 404s.
test('a null feed document 404s instead of serving a body of literal null', async () => {
  const c = ctx({ feeds: () => ({ 'status.json': { generated_at: 'x' }, 'ai-map.json': null }) });
  const res = await route(req('GET', '/ai-map.json'), c);
  assert.equal(res.status, 404);
});

test('a null feed document 404s on the scoped path too', async () => {
  const c = ctx({
    scope: 'example',
    feeds: () => ({ 'status.json': { generated_at: 'x' }, 'ai-map.json': null }),
  });
  const res = await route(req('GET', '/status/example/ai-map.json'), c);
  assert.equal(res.status, 404);
});

test('POST /ingest with a valid token stores the execution and answers 204', async () => {
  const c = ctx();
  const res = await route(req('POST', '/ingest', EVENT, auth), c);
  assert.equal(res.status, 204);
  assert.equal(recentExecutions(c.db).length, 1);
});

test('POST /ingest without a token is rejected and stores nothing', async () => {
  const c = ctx();
  assert.equal((await route(req('POST', '/ingest', EVENT), c)).status, 401);
  assert.equal((await route(req('POST', '/ingest', EVENT, { authorization: 'Bearer nope' }), c)).status, 401);
  assert.equal(recentExecutions(c.db).length, 0);
});

test('ingest is disabled entirely when no token is configured', async () => {
  const c = ctx({ ingestToken: '' });
  const res = await route(req('POST', '/ingest', EVENT, auth), c);
  assert.equal(res.status, 404, 'an unconfigured ingest must not be a writable endpoint');
  assert.equal(recentExecutions(c.db).length, 0);
});

test('GET /ingest is rejected', async () => {
  assert.equal((await route(req('GET', '/ingest', null, auth), ctx())).status, 405);
});

test('malformed ingest bodies answer 400 and store nothing', async () => {
  const c = ctx();
  const res = await route(req('POST', '/ingest', 'not json', auth), c);
  assert.equal(res.status, 400);
  assert.equal(recentExecutions(c.db).length, 0);
});

test('an oversized ingest body is refused with 413', async () => {
  const c = ctx();
  const res = await route(req('POST', '/ingest', 'x'.repeat(200), auth), { ...c, maxBodyBytes: 100 });
  assert.equal(res.status, 413);
});

test('healthz reports ok while polls succeed', async () => {
  const res = await route(req('GET', '/healthz'), ctx());
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('healthz answers 503 after three consecutive failures, like the collector', async () => {
  const res = await route(req('GET', '/healthz'), ctx({
    health: () => ({ ok: false, consecutiveFailures: 3, lastSuccess: null, lastError: 'x' }),
  }));
  assert.equal(res.status, 503);
});

test('POST /mcp dispatches a JSON-RPC message through ctx.mcpDispatch', async () => {
  const c = ctx({ mcpDispatch: async (msg) => ({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) });
  const res = await route(
    req('POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })), c);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).result, { ok: true });
});

test('the trailing-slash /mcp/ path dispatches too (nginx proxies both)', async () => {
  const c = ctx({ mcpDispatch: async () => ({ jsonrpc: '2.0', id: 1, result: {} }) });
  assert.equal((await route(req('POST', '/mcp/', '{"jsonrpc":"2.0","id":1,"method":"ping"}'), c)).status, 200);
});

test('GET /mcp answers 405 with an Allow header', async () => {
  const c = ctx({ mcpDispatch: async () => null });
  const res = await route(req('GET', '/mcp'), c);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('unparseable JSON answers a -32700 rpc error over HTTP 200', async () => {
  const c = ctx({ mcpDispatch: async () => null });
  const res = await route(req('POST', '/mcp', 'not json'), c);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).error.code, -32700);
});

test('a JSON-RPC batch is refused with -32600', async () => {
  const c = ctx({ mcpDispatch: async () => null });
  const res = await route(req('POST', '/mcp', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), c);
  assert.equal(JSON.parse(res.body).error.code, -32600);
});

test('a notification answers 202 with no body', async () => {
  const c = ctx({ mcpDispatch: async () => null });
  const res = await route(
    req('POST', '/mcp', '{"jsonrpc":"2.0","method":"notifications/initialized"}'), c);
  assert.equal(res.status, 202);
  assert.equal(res.body, '');
});

test('a dispatcher throw becomes -32603, not an HTTP failure', async () => {
  const c = ctx({ mcpDispatch: async () => { throw new Error('boom'); } });
  const res = await route(req('POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"ping"}'), c);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).error.code, -32603);
});

test('/mcp 404s when no dispatcher is wired', async () => {
  assert.equal((await route(req('POST', '/mcp', '{}'), ctx())).status, 404);
});

const fetchStub = (calls, { status = 200, body = '{"data":[]}' } = {}) => async (url, init) => {
  calls.push({ url, init });
  return { status, headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) }, text: async () => body };
};

test('/n8n-table/data-tables GET rewrites onto /api/v1 with the key injected and query preserved', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k123', fetchFn: fetchStub(calls) });
  const res = await route(req('GET', '/n8n-table/data-tables/42/rows?limit=250&sortBy=id%3Adesc'), c);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls[0].url, 'http://n8n:5678/api/v1/data-tables/42/rows?limit=250&sortBy=id%3Adesc');
  assert.equal(calls[0].init.headers['X-N8N-API-KEY'], 'k123');
  assert.equal((calls[0].init.method || 'GET'), 'GET');
});

test('a non-data-tables path under /n8n-table/ is 403, never proxied', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k', fetchFn: fetchStub(calls) });
  assert.equal((await route(req('GET', '/n8n-table/workflows'), c)).status, 403);
  assert.equal((await route(req('GET', '/n8n-table/'), c)).status, 403);
  assert.equal(calls.length, 0);
});

test('an unanchored prefix match is not enough — data-tablesEVIL and data-tables-evil are 403, never proxied', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k', fetchFn: fetchStub(calls) });
  assert.equal((await route(req('GET', '/n8n-table/data-tablesEVIL/rows'), c)).status, 403);
  assert.equal((await route(req('GET', '/n8n-table/data-tables-evil/rows'), c)).status, 403);
  assert.equal(calls.length, 0);
});

test('the bare /n8n-table/data-tables path (list tables, no sub-path) is proxied, not refused', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k', fetchFn: fetchStub(calls) });
  const res = await route(req('GET', '/n8n-table/data-tables'), c);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'http://n8n:5678/api/v1/data-tables');
});

test('a dot-segment escape out of data-tables is 403', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k', fetchFn: fetchStub(calls) });
  assert.equal((await route(req('GET', '/n8n-table/data-tables/../workflows'), c)).status, 403);
  assert.equal((await route(req('GET', '/n8n-table/data-tables/%2e%2e/workflows'), c)).status, 403);
  assert.equal(calls.length, 0);
});

test('non-GET methods under /n8n-table/ are 403 (limit_except parity)', async () => {
  const calls = [];
  const c = ctx({ n8nBase: 'http://n8n:5678', readKey: 'k', fetchFn: fetchStub(calls) });
  assert.equal((await route(req('POST', '/n8n-table/data-tables/42/rows', '{}'), c)).status, 403);
  assert.equal(calls.length, 0);
});

test('an upstream failure on /n8n-table is 502, not the handler catch-all 500', async () => {
  // nginx answered 502 for this route before the proxy moved into the server.
  // A rejected fetch (connection refused, or the N8N_TIMEOUT_MS abort) escaping
  // into makeRequestHandler's catch-all would blame the po11y server for an
  // n8n outage, and smoke check 11 accepts anything but 403/000 so it would
  // not notice.
  const c = ctx({
    n8nBase: 'http://n8n:5678', readKey: 'k',
    fetchFn: async () => { throw new Error('fetch failed: ECONNREFUSED'); },
  });
  const res = await route(req('GET', '/n8n-table/data-tables/42/rows'), c);
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /upstream/);
});

test('a body-phase upstream failure on /n8n-table is 502 too, not 500', async () => {
  // The outbound fetch carries AbortSignal.timeout(N8N_TIMEOUT_MS), which
  // aborts the whole exchange — so headers can land inside the deadline and
  // the body still reject after it. Reading the body outside the catch put
  // that case back on the handler's 500 path.
  const c = ctx({
    n8nBase: 'http://n8n:5678', readKey: 'k',
    fetchFn: async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    }),
  });
  const res = await route(req('GET', '/n8n-table/data-tables/42/rows'), c);
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).reason, /timeout/i);
});

test('the upstream status passes through (a 401 from n8n stays a 401)', async () => {
  const c = ctx({
    n8nBase: 'http://n8n:5678', readKey: '',
    fetchFn: fetchStub([], { status: 401, body: '{"message":"unauthorized"}' }),
  });
  assert.equal((await route(req('GET', '/n8n-table/data-tables/42/rows'), c)).status, 401);
});

test('GET /metrics answers the Prometheus exposition as text', async () => {
  const res = await route(req('GET', '/metrics'), {
    ...ctx(), metricsText: () => '# HELP po11y_n8n_up x\npo11y_n8n_up 1\n',
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  assert.match(res.body, /po11y_n8n_up 1/);
});

test('/metrics is GET-only', async () => {
  const res = await route(req('POST', '/metrics'), { ...ctx(), metricsText: () => '' });
  assert.equal(res.status, 405);
});

test('/metrics is absent when the context supplies no renderer, rather than answering empty', async () => {
  const res = await route(req('GET', '/metrics'), ctx());
  assert.equal(res.status, 404);
});

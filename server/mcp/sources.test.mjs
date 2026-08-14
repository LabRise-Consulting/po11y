import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSelect, makeGrafana, unavailable, makePrometheus, makeN8n, makeDataTables,
  makeCachedFeeds, makeStore,
} from './sources.mjs';
import { openDb, upsertExecutions, upsertWorkflows } from '../db.mjs';

test('unavailable names the variable to set, and is not an empty result', () => {
  const out = unavailable('po11y_sql', 'GRAFANA_URL');
  assert.equal(out.error, 'unavailable');
  assert.match(out.reason, /GRAFANA_URL/);
});

test('prometheus: query hits /api/v1/query and returns the result', async () => {
  let seen = '';
  const fetchFn = async (u) => { seen = u; return { ok: true, json: async () => ({ status: 'success', data: { result: [] } }) }; };
  const prom = makePrometheus({ url: 'http://prom:9090', fetchFn });
  await prom.query('up');
  assert.match(seen, /\/api\/v1\/query\?query=up/);
});

test('prometheus: a non-2xx names the source and status, never the URL credentials', async () => {
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const prom = makePrometheus({ url: 'http://user:pw@prom:9090', fetchFn });
  await assert.rejects(() => prom.query('up'), (e) => {
    assert.match(e.message, /prometheus/);
    assert.match(e.message, /503/);
    assert.ok(!e.message.includes('pw'));
    return true;
  });
});

test('n8n: every call is a GET and carries the key in the header only', async () => {
  const calls = [];
  const fetchFn = async (u, opts) => { calls.push({ u, opts }); return { ok: true, json: async () => ({ data: [] }) }; };
  const n8n = makeN8n({ url: 'http://n8n:5678', apiKey: 'SECRET', fetchFn });
  await n8n.get('/api/v1/executions?limit=1');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers['X-N8N-API-KEY'], 'SECRET');
  assert.ok(!calls[0].u.includes('SECRET'));
});

test('n8n: unavailable without both url and key', () => {
  assert.equal(makeN8n({ url: '', apiKey: 'k' }).available(), false);
  assert.equal(makeN8n({ url: 'http://n8n:5678', apiKey: '' }).available(), false);
  assert.equal(makeN8n({ url: 'http://n8n:5678', apiKey: 'k' }).available(), true);
});

test('assertSelect accepts a single SELECT and strips a trailing semicolon', () => {
  assert.equal(assertSelect('  SELECT 1;  '), 'SELECT 1');
});

test('assertSelect rejects every non-SELECT statement', () => {
  for (const sql of ['DELETE FROM execution_entity', 'update x set y=1',
    'INSERT INTO t VALUES (1)', 'DROP TABLE t', 'TRUNCATE t']) {
    assert.throws(() => assertSelect(sql), /single SELECT/);
  }
});

test('assertSelect rejects a stacked statement', () => {
  assert.throws(() => assertSelect('SELECT 1; DROP TABLE t'), /single statement/);
});

test('assertSelect rejects SELECT ... INTO (table creation)', () => {
  assert.throws(() => assertSelect('SELECT * INTO evil FROM execution_entity'), /not read-only/);
});

test('assertSelect rejects select ... into (temp table)', () => {
  assert.throws(() => assertSelect('select id into temp t from x'), /not read-only/);
});

test('assertSelect accepts SELECT with identifier containing into', () => {
  assert.equal(assertSelect('SELECT into_count FROM t'), 'SELECT into_count FROM t');
});

test('grafana: query posts rawSql to /api/ds/query and flattens the frame', async () => {
  let body = null;
  const fetchFn = async (u, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ results: { A: { frames: [{
      schema: { fields: [{ name: 'id' }, { name: 'status' }] },
      data: { values: [[1, 2], ['success', 'error']] },
    }] } } }) };
  };
  const g = makeGrafana({ url: 'http://grafana:3000', datasourceUid: 'n8n-postgres', fetchFn });
  const out = await g.query('SELECT id, status FROM execution_entity');
  assert.equal(body.queries[0].datasource.uid, 'n8n-postgres');
  assert.deepEqual(out.columns, ['id', 'status']);
  assert.deepEqual(out.rows, [[1, 'success'], [2, 'error']]);
});

test('grafana: a write statement never reaches the network', async () => {
  let called = false;
  const g = makeGrafana({ url: 'http://grafana:3000', datasourceUid: 'x',
    fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(() => g.query('DELETE FROM execution_entity'));
  assert.equal(called, false);
});

test('datatables: every request is a GET', async () => {
  // makeDataTables is the second hand-built fetch path to n8n (in Mode B it
  // targets the REMOTE n8n with N8N_READ_API_KEY). The GET-only invariant is
  // asserted for makeN8n above; without this twin assertion a write verb could
  // creep in here unnoticed.
  const calls = [];
  const fetchFn = async (u, opts) => { calls.push({ u, opts }); return { ok: true, json: async () => ({ data: [] }) }; };
  const t = makeDataTables({ n8nUrl: 'http://n8n:5678', readKey: 'READKEY', fetchFn });
  await t.fetchJson('/n8n-table/data-tables/42/rows');
  await t.fetchJson('https://feeds.example.com/rows.json');
  for (const c of calls) assert.equal(c.opts.method, 'GET');
});

test('datatables: a /n8n-table/ path is rewritten onto the n8n API and carries the key', async () => {
  const calls = [];
  const fetchFn = async (u, opts) => { calls.push({ u, opts }); return { ok: true, json: async () => ({ data: [] }) }; };
  const t = makeDataTables({ n8nUrl: 'http://n8n:5678', readKey: 'READKEY', fetchFn });
  await t.fetchJson('/n8n-table/data-tables/42/rows?limit=250');
  assert.equal(calls[0].u, 'http://n8n:5678/api/v1/data-tables/42/rows?limit=250');
  assert.equal(calls[0].opts.headers['X-N8N-API-KEY'], 'READKEY');
});

test('datatables: an absolute endpoint never receives n8n\'s key', async () => {
  // A tab's endpoint may be any static JSON on any host (docs/configuration.md)
  // and the browser fetches it same-origin with no key at all. Attaching the
  // read key here would hand an n8n credential to whatever host the config
  // names.
  const calls = [];
  const fetchFn = async (u, opts) => { calls.push({ u, opts }); return { ok: true, json: async () => ({ items: [] }) }; };
  const t = makeDataTables({ n8nUrl: 'http://n8n:5678', readKey: 'READKEY', fetchFn });
  await t.fetchJson('https://feeds.example.com/rows.json');
  assert.equal(calls[0].u, 'https://feeds.example.com/rows.json');
  assert.equal(calls[0].opts.headers['X-N8N-API-KEY'], undefined);
  assert.ok(!JSON.stringify(calls[0]).includes('READKEY'));
});

test('datatables: a relative endpoint that is not a proxy path is refused, not aimed at n8n', async () => {
  let called = false;
  const t = makeDataTables({ n8nUrl: 'http://n8n:5678', readKey: 'READKEY',
    fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(() => t.fetchJson('/feeds/rows.json'), /n8n-table/);
  assert.equal(called, false);
});

test('grafana: the service-account token never appears in an error', async () => {
  const g = makeGrafana({ url: 'http://grafana:3000', token: 'glsa_TOPSECRET',
    datasourceUid: 'x', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(() => g.query('SELECT 1'), (e) => {
    assert.ok(!e.message.includes('TOPSECRET'));
    assert.match(e.message, /401/);
    return true;
  });
});

test('makeCachedFeeds serves the live cached object and a build-relative age', () => {
  let cached = { 'ai-map.json': null, 'notifications.json': [] };
  let builtAt = null;
  const feeds = makeCachedFeeds({ getFeeds: () => cached, getBuiltAtMs: () => builtAt });
  assert.equal(feeds.readSafe('ai-map.json'), null);
  assert.equal(feeds.ageSeconds('ai-map.json'), null);
  cached = { ...cached, 'ai-map.json': { nodes: [] } };
  builtAt = Date.now() - 5000;
  assert.deepEqual(feeds.readSafe('ai-map.json'), { nodes: [] });
  assert.ok(feeds.ageSeconds('ai-map.json') >= 5);
});

test('makeCachedFeeds is unavailable until a build has run, whatever the cold-start defaults are', () => {
  // The regression this pins: notifications.json's cold-start default is [],
  // not null, so a feeds adapter that reported itself available before the
  // first rebuild handed po11y_incidents an empty ARRAY — which it correctly
  // read as "a watchdog ran and found nothing". On a serving-only server no
  // rebuild ever runs, so that answer was permanent and false.
  const cached = { 'ai-map.json': null, 'notifications.json': [] };
  let builtAt = null;
  const feeds = makeCachedFeeds({ getFeeds: () => cached, getBuiltAtMs: () => builtAt });

  assert.equal(feeds.available(), false);
  assert.equal(feeds.readSafe('notifications.json'), null, 'the [] default must not read as a verdict');
  assert.throws(() => feeds.read('notifications.json'), /has not been built yet/);

  builtAt = Date.now();
  assert.equal(feeds.available(), true);
  assert.deepEqual(feeds.readSafe('notifications.json'), []);
});

test('makeCachedFeeds counts a warm persisted cache as built, so a restart keeps serving it', () => {
  // seedBuiltAt (cache.mjs) hands index.mjs a stamp from the previous run. A
  // rule of "this process has rebuilt" rather than "a build has ever happened"
  // would hide a real last-good ai-map for as long as the store stayed cold.
  const cached = { 'ai-map.json': { nodes: [{ id: 'wf:1' }] }, 'notifications.json': [] };
  const builtAt = Date.now() - 3_600_000;
  const feeds = makeCachedFeeds({ getFeeds: () => cached, getBuiltAtMs: () => builtAt });
  assert.equal(feeds.available(), true);
  assert.deepEqual(feeds.readSafe('ai-map.json'), { nodes: [{ id: 'wf:1' }] });
  assert.ok(feeds.ageSeconds('ai-map.json') >= 3600, 'and reports the real, honest age');
});

test('makeStore reads executions and workflows from the sqlite store', async () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: '1', workflowId: 'a', status: 'error', startedAt: '2026-08-01T00:00:00.000Z' }]);
  upsertWorkflows(db, [{ id: 'a', name: 'Ingest', active: true, nodes: [], connections: {} }]);
  const store = makeStore({ db, enabled: true });
  assert.equal(store.available(), true);
  assert.equal((await store.recent({ workflowId: 'a' }))[0].id, '1');
  assert.equal((await store.workflows())[0].name, 'Ingest');
});

test('makeStore is unavailable when sync is disabled, however many rows are already in it', async () => {
  // Serving-only mode: no key, so index.mjs arms no sync or poll timer and
  // nothing writes this store. Rows may still be there from a keyed run, and
  // they are exactly as misleading as no rows — both mean "I cannot see".
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: '1', workflowId: 'a', status: 'error', startedAt: '2026-08-01T00:00:00.000Z' }]);
  assert.equal(makeStore({ db, enabled: false }).available(), false);
  assert.equal(makeStore({ db, enabled: true }).available(), true);
});

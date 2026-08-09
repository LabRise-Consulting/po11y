import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSelect, makeGrafana, makeFeeds, unavailable, detectSources, makePrometheus, makeN8n, makeDataTables } from './sources.mjs';

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-mcp-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ generated_at: '2026-08-01T00:00:00Z' }));
  return dir;
}

test('feeds: available only when at least one feed FILE exists, not just the dir', () => {
  assert.equal(makeFeeds({ statusDir: fixtureDir() }).available(), true);
  assert.equal(makeFeeds({ statusDir: '/nope/not/here' }).available(), false);
  // The mount point exists in every deployment — a scoped layout where all
  // collectors publish into subdirs leaves it empty, and "available" then
  // made every feed tool describe a healthy-empty instance.
  const empty = mkdtempSync(join(tmpdir(), 'po11y-mcp-empty-'));
  assert.equal(makeFeeds({ statusDir: empty }).available(), false);
});

test('feeds: read parses a feed, readSafe swallows a missing one', () => {
  const feeds = makeFeeds({ statusDir: fixtureDir() });
  assert.equal(feeds.read('status.json').generated_at, '2026-08-01T00:00:00Z');
  assert.equal(feeds.readSafe('missing.json'), null);
});

test('feeds: ageSeconds reports how stale the file is', () => {
  const feeds = makeFeeds({ statusDir: fixtureDir() });
  assert.ok(feeds.ageSeconds('status.json') >= 0);
  assert.equal(feeds.ageSeconds('missing.json'), null);
});

test('unavailable names the variable to set, and is not an empty result', () => {
  const out = unavailable('po11y_sql', 'GRAFANA_URL');
  assert.equal(out.error, 'unavailable');
  assert.match(out.reason, /GRAFANA_URL/);
});

test('detectSources reports feeds off when STATUS_DIR does not exist', async () => {
  const sources = await detectSources({ STATUS_DIR: '/nope/not/here' });
  assert.equal(sources.feeds.available(), false);
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

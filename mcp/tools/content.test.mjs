import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetsTool, rowsTool, rowTool, todayIso } from './content.mjs';

const CONFIG = { tabs: [
  { id: 'orders', label: 'Orders', src: '/site/list.html', list: {
    title: 'Orders',
    endpoint: '/n8n-table/data-tables/42/rows?sortBy=id:desc',
    defaultSort: 'day', defaultRange: '7d',
    mapping: { title: 'title', url: 'url', score: 'score', day: 'firstSeen',
               badge: 'source', meta: ['customer', 'region'] },
  } },
  { id: 'about', label: 'About', src: '/site/about.html' },
] };

const ROWS = [
  { id: 3, title: 'Widget A', url: 'https://x/3', score: 9, firstSeen: '2026-08-01T09:00:00Z', source: 'storeA', customer: 'ACME', region: 'DE' },
  { id: 2, title: 'Widget B', url: 'https://x/2', score: 4, firstSeen: '2026-07-31T09:00:00Z', source: 'storeB', customer: 'Beta', region: 'NL' },
];
const tables = { available: () => true, base: 'http://n8n:5678',
  fetchJson: async () => ({ data: ROWS, nextCursor: null }) };
const off = { available: () => false };

test('datasets: lists every list tab with its field meanings', async () => {
  const out = await datasetsTool({ datatables: tables }, CONFIG).handler({});
  assert.equal(out.datasets.length, 1);
  assert.equal(out.datasets[0].id, 'orders');
  assert.equal(out.datasets[0].fields.title, 'title');
  assert.deepEqual(out.datasets[0].fields.meta, ['customer', 'region']);
  assert.match(out.datasets[0].source, /data-tables\/42/);
});

test('datasets: a config with no list tabs says so', async () => {
  const out = await datasetsTool({ datatables: tables }, { tabs: [] }).handler({});
  assert.equal(out.datasets.length, 0);
  assert.match(out.summary, /no list/i);
});

test('rows: returns mapped card fields, newest first', async () => {
  const out = await rowsTool({ datatables: tables }, CONFIG).handler({ dataset: 'orders' });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].title, 'Widget A');
  assert.equal(out.rows[0].badge, 'storeA');
  // The browser needs normalizeRows' `raw` copy; a model does not, and it
  // roughly doubles the token cost of a page.
  assert.equal(out.rows[0].raw, undefined);
});

test('rows: minScore filters', async () => {
  const out = await rowsTool({ datatables: tables }, CONFIG).handler({ dataset: 'orders', minScore: 5 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].score, 9);
});

test('rows: match filters case-insensitively across title and meta', async () => {
  const out = await rowsTool({ datatables: tables }, CONFIG).handler({ dataset: 'orders', match: 'beta' });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].title, 'Widget B');
});

test('datasets: a config that is not an object (JSON.parse("null")) degrades to zero, not a crash', async () => {
  // registry.mjs normalizes this before it reaches here, but datasets()/find()
  // guard defensively too: a future caller (or a registry bug) must not turn
  // a malformed config.json into an unhandled TypeError that escapes as a
  // raw JSON-RPC -32603.
  const out = await datasetsTool({ datatables: tables }, null).handler({});
  assert.equal(out.datasets.length, 0);
});

test('rows: an unknown dataset lists the known ones', async () => {
  const out = await rowsTool({ datatables: tables }, CONFIG).handler({ dataset: 'nope' });
  assert.match(out.error, /unknown dataset/);
  assert.deepEqual(out.known, ['orders']);
});

test('rows: a non-object config reports an unknown dataset instead of crashing', async () => {
  const out = await rowsTool({ datatables: tables }, null).handler({ dataset: 'orders' });
  assert.match(out.error, /unknown dataset/);
  assert.deepEqual(out.known, []);
});

test('rows: without the read key it names the variable', async () => {
  const out = await rowsTool({ datatables: off }, CONFIG).handler({ dataset: 'orders' });
  assert.match(out.reason, /N8N_READ_API_KEY/);
});

test('rows: a dataset the server cannot fetch says why, instead of naming the read key', async () => {
  // A static-feed tab needs no key at all, so unavailable('…','N8N_READ_API_KEY')
  // would send an operator to set a variable that changes nothing.
  const staticCfg = { tabs: [{ ...CONFIG.tabs[0], list: { ...CONFIG.tabs[0].list,
    endpoint: '/feeds/orders.json' } }] };
  const out = await rowsTool({ datatables: off }, staticCfg).handler({ dataset: 'orders' });
  assert.equal(out.error, 'unsupported endpoint');
  assert.equal(out.dataset, 'orders');
  assert.match(out.reason, /\/n8n-table\//);
  assert.ok(!JSON.stringify(out).includes('N8N_READ_API_KEY'));
});

test('row: an absolute endpoint is refused before any fetch is attempted', async () => {
  let called = false;
  const watcher = { available: () => true, base: 'http://n8n:5678',
    fetchJson: async () => { called = true; return { data: [], nextCursor: null }; } };
  const absoluteCfg = { tabs: [{ ...CONFIG.tabs[0], list: { ...CONFIG.tabs[0].list,
    endpoint: 'https://feeds.example.com/rows.json' } }] };
  const out = await rowTool({ datatables: watcher }, absoluteCfg).handler({ dataset: 'orders', id: 3 });
  assert.equal(out.error, 'unsupported endpoint');
  assert.equal(called, false);
});

test('rows: a negative limit is clamped rather than silently dropping a row', async () => {
  const out = await rowsTool({ datatables: tables }, CONFIG).handler({ dataset: 'orders', limit: -1 });
  assert.equal(out.rows.length, 1);
});

test('rows: an absurd maxPages is clamped to the page budget ceiling', async () => {
  let pages = 0;
  const endless = { available: () => true, base: 'http://n8n:5678',
    fetchJson: async () => { pages++; return { data: ROWS, nextCursor: 'more' }; } };
  const out = await rowsTool({ datatables: endless }, CONFIG)
    .handler({ dataset: 'orders', maxPages: 100000 });
  assert.equal(pages, 50);
  assert.equal(out.truncated, true);
});

test('rows: says when the page budget truncated the answer', async () => {
  const truncating = { available: () => true, base: 'http://n8n:5678',
    fetchJson: async () => ({ data: ROWS, nextCursor: 'more' }) };
  const out = await rowsTool({ datatables: truncating }, CONFIG).handler({ dataset: 'orders', maxPages: 1 });
  assert.equal(out.truncated, true);
  assert.match(out.summary, /truncated/i);
});

test('row: returns one row in full including the detail array', async () => {
  const withDetail = { available: () => true, base: 'http://n8n:5678',
    fetchJson: async () => ({ data: [{ ...ROWS[0],
      detail: JSON.stringify([{ aspect: 'stock', kind: 'fit', assessment: 'in stock' }]) }], nextCursor: null }) };
  const cfg = { tabs: [{ ...CONFIG.tabs[0], list: { ...CONFIG.tabs[0].list,
    mapping: { ...CONFIG.tabs[0].list.mapping, detail: 'detail' } } }] };
  const out = await rowTool({ datatables: withDetail }, cfg).handler({ dataset: 'orders', id: 3 });
  assert.equal(out.row.detail[0].aspect, 'stock');
});

test('row: a truncated walk says so, rather than asserting the row does not exist', async () => {
  // Always offers another page, so loadRows' fixed 8-page budget is spent
  // without ever reaching the id we ask for — the row may exist further
  // back; "not found" would be a false assertion of nonexistence.
  const truncating = { available: () => true, base: 'http://n8n:5678',
    fetchJson: async () => ({ data: ROWS, nextCursor: 'more' }) };
  const out = await rowTool({ datatables: truncating }, CONFIG).handler({ dataset: 'orders', id: 999 });
  assert.match(out.error, /truncated/i);
});

test('todayIso: computes the date in UTC, not the process local timezone', () => {
  // lib/list-rows.mjs's dayOf/rangeCutoff/isoMinus are all UTC-derived from
  // row timestamps; todayIso must agree, or a 'today' range silently drops
  // rows for the last hour or two of each UTC day whenever the container's
  // TZ (docker-compose.yml default: Europe/Berlin) runs ahead of UTC.
  const originalTz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland'; // always ahead of UTC, so a naive
  // local-time read would report the next calendar day for this instant.
  try {
    const now = new Date('2026-08-01T23:30:00Z');
    assert.equal(todayIso(now), '2026-08-01');
  } finally {
    process.env.TZ = originalTz;
  }
});

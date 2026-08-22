import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { sampleTables, parseCount } from './datatables.mjs';

const NOW = Date.parse('2026-08-11T06:00:00.000Z');

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/datatable-rows.json', import.meta.url)), 'utf8'),
);

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const listResponse = (tables) => jsonResponse({ data: tables, nextCursor: null });

test('parseCount reads the count field the probe recorded', () => {
  assert.equal(parseCount({ count: 657, data: [] }), 657);
  assert.equal(parseCount({ data: [{}, {}] }), 2);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount({ nope: true }), null);
});

test('parseCount treats the real fixture page (no count field) as its own row count', () => {
  // The probed n8n build never returns a total — /rows pages carry only
  // {data, nextCursor} — so parseCount's fallback (data.length) is what
  // sampleTables actually exercises on this instance, not the count branch.
  assert.equal(parseCount(FIXTURE), FIXTURE.data.length);
});

test('sampleTables resolves name -> id, stores one sample per target, and is GET-only', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([url, (init?.method || 'GET')]);
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id1', name: 'orders' }]);
    }
    // Mirrors the real probe: a rows page with no `count` field, so the
    // implementation must fall back to summing data.length.
    return jsonResponse({ data: new Array(42).fill({}), nextCursor: null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  assert.equal(n, 1);
  assert.ok(calls.every(([, m]) => m === 'GET'));
  const row = { ...db.prepare('SELECT key, rows FROM datatable_counts').get() };
  assert.deepEqual(row, { key: 'orders', rows: 42 });
});

test('sampleTables trusts an authoritative count field when a build supplies one', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id1', name: 'orders' }]);
    }
    // Some n8n builds may include a total alongside the first page — if so,
    // trust it and do not page further (an empty data[] here would otherwise
    // read as zero rows).
    return jsonResponse({ count: 657, data: [] });
  };
  await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  const row = db.prepare('SELECT rows FROM datatable_counts').get();
  assert.equal(row.rows, 657);
});

test('sampleTables pages through nextCursor and sums across pages', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id1', name: 'orders' }]);
    }
    if (url.includes('cursor=')) {
      return jsonResponse({ data: new Array(17).fill({}), nextCursor: null });
    }
    return jsonResponse({ data: new Array(250).fill({}), nextCursor: 'page2' });
  };
  await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  const row = db.prepare('SELECT rows FROM datatable_counts').get();
  assert.equal(row.rows, 267);
});

test('a target whose rows fetch fails does not abort the others', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id-bad', name: 'bad' }, { id: 'id-good', name: 'good' }]);
    }
    if (url.includes('id-bad')) return { ok: false, status: 404, json: async () => ({}) };
    return jsonResponse({ data: new Array(7).fill({}), nextCursor: null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['bad', 'good'], NOW);
  assert.equal(n, 1);
  const rows = db.prepare('SELECT key, rows FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'good', rows: 7 }]);
});

test('a target name absent from the instance is skipped, not fatal', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id-good', name: 'good' }]);
    }
    return jsonResponse({ data: new Array(3).fill({}), nextCursor: null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['typo_name', 'good'], NOW);
  assert.equal(n, 1);
  const rows = db.prepare('SELECT key FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'good' }]);
});

test('an unreachable listing call yields zero samples rather than throwing', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  assert.equal(n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM datatable_counts').get().n, 0);
});

test('a table that outgrows the page cap stores no sample rather than a capped one', async () => {
  const db = openDb(':memory:');
  let pages = 0;
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id-huge', name: 'orders' }, { id: 'id-good', name: 'invoices' }]);
    }
    if (url.includes('id-huge')) {
      pages += 1;
      return jsonResponse({ data: new Array(250).fill({}), nextCursor: `page${pages}` });
    }
    return jsonResponse({ data: new Array(9).fill({}), nextCursor: null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders', 'invoices'], NOW);
  // A capped count is not a count: it stops rising the moment the table passes
  // the ceiling, and a growth expectation reads that flat line as a dead
  // ingest. Skip the sample instead — same degradation the repeating-cursor
  // case already takes — so the series has a hole rather than a lie.
  assert.equal(n, 1, 'only "invoices" produced a sample this tick');
  const rows = db.prepare('SELECT key, rows FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'invoices', rows: 9 }], 'a capped count must never enter the series');
  // Still bounded: the cap exists so a runaway cursor cannot page forever.
  assert.ok(pages > 0 && pages < 1000, `paging must still stop, got ${pages} pages`);
});

test('a table of tens of thousands of rows still samples exactly', async () => {
  // The ceiling has to sit far above the tables a pack actually watches. A
  // table that merely grows past it is not a runaway cursor, and losing its
  // samples the day it crosses is the same blind spot as capping them.
  const TOTAL = 47_311;
  const db = openDb(':memory:');
  let served = 0;
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id1', name: 'orders' }]);
    }
    const rows = Math.min(250, TOTAL - served);
    served += rows;
    return jsonResponse({ data: new Array(rows).fill({}), nextCursor: served < TOTAL ? `page${served}` : null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  assert.equal(n, 1);
  assert.equal(db.prepare('SELECT rows FROM datatable_counts').get().rows, TOTAL);
});

test('a table stuck on a repeating cursor is skipped for the tick, not counted with an inflated total, and its neighbor still samples', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id-loop', name: 'looping' }, { id: 'id-good', name: 'good' }]);
    }
    if (url.includes('id-loop')) {
      // Never advances: every page (first fetch and every cursor=... refetch)
      // hands back the SAME nextCursor, well short of the PAGE_CAP ceiling —
      // this is the guard apiGetPaged adds, distinct from the cap above.
      return jsonResponse({ data: new Array(5).fill({}), nextCursor: 'stuck' });
    }
    return jsonResponse({ data: new Array(9).fill({}), nextCursor: null });
  };
  const n = await sampleTables(db, fetchFn, 'http://n8n', 'k', ['looping', 'good'], NOW);
  assert.equal(n, 1, 'only "good" produced a sample this tick');
  const rows = db.prepare('SELECT key, rows FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'good', rows: 9 }], '"looping" must not have stored an inflated count');
});

test('a windowed delta over two samples is what an expectation can watch', () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO datatable_counts (key, rows, sampled_at) VALUES (?, ?, ?)');
  ins.run('orders', 100, '2026-08-10T06:00:00.000Z');
  ins.run('orders', 100, '2026-08-11T06:00:00.000Z');
  const delta = db.prepare(
    `SELECT (SELECT rows FROM datatable_counts WHERE key = 'orders' ORDER BY sampled_at DESC LIMIT 1)
          - (SELECT rows FROM datatable_counts WHERE key = 'orders' AND sampled_at <= ? ORDER BY sampled_at DESC LIMIT 1)`,
  ).get('2026-08-10T12:00:00.000Z');
  assert.equal(Object.values(delta)[0], 0, 'a night that wrote nothing must read as zero growth');
});

test('re-sampling the same key at the same instant overwrites rather than duplicates', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (url.includes('/api/v1/data-tables?')) {
      return listResponse([{ id: 'id1', name: 'orders' }]);
    }
    return jsonResponse({ data: new Array(5).fill({}), nextCursor: null });
  };
  await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  await sampleTables(db, fetchFn, 'http://n8n', 'k', ['orders'], NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM datatable_counts').get().n, 1);
});

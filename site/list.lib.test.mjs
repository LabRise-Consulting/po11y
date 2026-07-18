import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows, sortItems, groupByDay } from './list.lib.js';

const mapping = {
  title: 'title', url: 'url', score: 'score', day: 'firstSeen',
  meta: ['customer', 'region', 'units', 'status', 'note'],
};

test('normalizeRows: n8n DataTable {data:[…]} response', () => {
  const payload = { data: [
    { id: 1, title: 'Widget A', url: '/catalogue/widget-a', score: 8,
      firstSeen: '2026-07-15T09:00:00Z', customer: 'ACME', region: 'DE',
      units: 100, status: 'shipped', note: 'priority order' },
  ] };
  const items = normalizeRows(payload, mapping);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Widget A');
  assert.equal(items[0].url, '/catalogue/widget-a');
  assert.equal(items[0].score, 8);
  assert.equal(items[0].day, '2026-07-15');            // date-only bucket
  assert.equal(items[0].meta.customer, 'ACME');
  assert.equal(items[0].meta.units, 100);
});

test('normalizeRows: plain array payload', () => {
  const items = normalizeRows([{ title: 'X', url: '/p/x', score: 3, firstSeen: '2026-07-14T00:00:00Z' }], mapping);
  assert.equal(items.length, 1);
  assert.equal(items[0].day, '2026-07-14');
});

test('normalizeRows: {items:[…]} payload and missing fields tolerated', () => {
  const items = normalizeRows({ items: [{ title: 'Y' }] }, mapping);
  assert.equal(items[0].title, 'Y');
  assert.equal(items[0].score, null);
  assert.equal(items[0].day, 'unknown');
});

test('sortItems by score desc, nulls last', () => {
  const out = sortItems([{ score: 3 }, { score: null }, { score: 9 }], 'score');
  assert.deepEqual(out.map((i) => i.score), [9, 3, null]);
});

test('sortItems by day desc, unknown last', () => {
  const out = sortItems([{ day: '2026-07-10' }, { day: 'unknown' }, { day: '2026-07-15' }], 'day');
  assert.deepEqual(out.map((i) => i.day), ['2026-07-15', '2026-07-10', 'unknown']);
});

test('groupByDay labels Today/Yesterday and orders newest first', () => {
  const today = '2026-07-15';
  const items = [
    { day: '2026-07-15', title: 'a' },
    { day: '2026-07-14', title: 'b' },
    { day: '2026-07-10', title: 'c' },
  ];
  const groups = groupByDay(items, today);
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', '2026-07-10']);
  assert.equal(groups[0].items.length, 1);
});

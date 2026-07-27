import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows, sortItems, groupByDay, parseDetail, RANGES, rangeCutoff, filterByRange,
  windowComplete, dedupeById } from './list.lib.js';

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

test('parseDetail: JSON string, array, and junk', () => {
  const json = '[{"aspect":"Python","kind":"fit","assessment":"core"},{"aspect":"on-call","kind":"gap","assessment":"real — disliked"}]';
  const out = parseDetail(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'fit');
  assert.equal(out[1].kind, 'gap');
  assert.equal(out[1].assessment, 'real — disliked');
  // already-parsed array passes through; unknown kind defaults to fit
  assert.equal(parseDetail([{ aspect: 'x', kind: 'weird', assessment: 'y' }])[0].kind, 'fit');
  // junk / empty ⇒ null so the card stays non-expandable
  assert.equal(parseDetail('not json'), null);
  assert.equal(parseDetail(''), null);
  assert.equal(parseDetail(null), null);
  assert.equal(parseDetail('[]'), null);
});

test('normalizeRows: detail column parsed when mapped', () => {
  const m = { title: 'title', detail: 'detail' };
  const rows = { data: [{ title: 'Job', detail: '[{"aspect":"a","kind":"gap","assessment":"debatable"}]' }] };
  const items = normalizeRows(rows, m);
  assert.equal(items[0].detail.length, 1);
  assert.equal(items[0].detail[0].kind, 'gap');
  // no detail mapping ⇒ null
  assert.equal(normalizeRows(rows, { title: 'title' })[0].detail, null);
});

test('normalizeRows: badge maps a provenance column onto its own field', () => {
  const m = { ...mapping, badge: 'source' };
  const items = normalizeRows([{ title: 'X', source: 'adzuna' }], m);
  assert.equal(items[0].badge, 'adzuna');
});

test('normalizeRows: badge is null when unmapped or empty, never "null"', () => {
  assert.equal(normalizeRows([{ title: 'X', source: 'adzuna' }], mapping)[0].badge, null);
  assert.equal(normalizeRows([{ title: 'X', source: '' }], { ...mapping, badge: 'source' })[0].badge, null);
  assert.equal(normalizeRows([{ title: 'X' }], { ...mapping, badge: 'source' })[0].badge, null);
});

test('RANGES exposes the four window keys in display order', () => {
  assert.deepEqual(RANGES.map((r) => r.key), ['all', 'today', '7d', '30d']);
});

test('rangeCutoff: rolling windows inclusive of today, null for all', () => {
  const today = '2026-07-26';
  assert.equal(rangeCutoff('all', today), null);
  assert.equal(rangeCutoff('today', today), '2026-07-26');
  assert.equal(rangeCutoff('7d', today), '2026-07-20');    // today + 6 previous days
  assert.equal(rangeCutoff('30d', today), '2026-06-27');   // crosses the month boundary
});

test('rangeCutoff: unknown key falls open to all', () => {
  assert.equal(rangeCutoff('quarter', '2026-07-26'), null);
  assert.equal(rangeCutoff(undefined, '2026-07-26'), null);
});

test('filterByRange: cutoff day is included, the day before is not', () => {
  const today = '2026-07-26';
  const items = [
    { day: '2026-07-26', title: 'today' },
    { day: '2026-07-20', title: 'on the cutoff' },
    { day: '2026-07-19', title: 'one day too old' },
  ];
  assert.deepEqual(filterByRange(items, '7d', today).map((i) => i.title), ['today', 'on the cutoff']);
  assert.deepEqual(filterByRange(items, 'today', today).map((i) => i.title), ['today']);
  assert.equal(filterByRange(items, 'all', today).length, 3);
});

test('filterByRange: unknown-day rows survive only under all', () => {
  const items = [{ day: '2026-07-26' }, { day: 'unknown' }];
  assert.deepEqual(filterByRange(items, 'today', '2026-07-26').map((i) => i.day), ['2026-07-26']);
  assert.equal(filterByRange(items, 'all', '2026-07-26').length, 2);
});

test('filterByRange: leaves the input array untouched', () => {
  const items = [{ day: '2026-07-26' }, { day: '2026-01-01' }];
  filterByRange(items, 'today', '2026-07-26');
  assert.equal(items.length, 2);
});

test('windowComplete: true once a row older than the cutoff has been seen', () => {
  const today = '2026-07-26';
  // Nothing older than the cutoff yet ⇒ the window may extend past this page.
  assert.equal(windowComplete([{ day: '2026-07-26' }, { day: '2026-07-20' }], '7d', today), false);
  // A row before the cutoff proves the newest-first feed has passed the edge.
  assert.equal(windowComplete([{ day: '2026-07-26' }, { day: '2026-07-19' }], '7d', today), true);
});

test('windowComplete: an unbounded range is never complete', () => {
  assert.equal(windowComplete([{ day: '2019-01-01' }], 'all', '2026-07-26'), false);
});

test('windowComplete: unknown-day rows never signal completion', () => {
  assert.equal(windowComplete([{ day: 'unknown' }], 'today', '2026-07-26'), false);
});

test('dedupeById: keeps the first occurrence and preserves order', () => {
  const out = dedupeById([{ id: 1, t: 'a' }, { id: 2, t: 'b' }, { id: 1, t: 'a again' }]);
  assert.deepEqual(out.map((i) => i.t), ['a', 'b']);
});

test('dedupeById: rows without an id are all kept', () => {
  const out = dedupeById([{ id: null, t: 'a' }, { id: null, t: 'b' }, { id: 3, t: 'c' }]);
  assert.deepEqual(out.map((i) => i.t), ['a', 'b', 'c']);
});

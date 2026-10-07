import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, upsertExecutions, getKv, setKv } from './db.mjs';
import { loadPack, evaluate, reconcileExpectations, toNotifications } from './expectations.mjs';

const NOW = Date.parse('2026-08-11T06:00:00.000Z');

const PACK = JSON.stringify({
  expectations: [
    { name: 'nightly ingest ran', kind: 'min-count', min: 1, windowMinutes: 1560,
      sql: "SELECT COUNT(*) FROM executions WHERE workflow_id = 'wf1' AND status = 'success' AND started_at >= ?" },
    { name: 'ingest is fresh', kind: 'max-age-minutes', maxAgeMinutes: 1560,
      sql: "SELECT MAX(started_at) FROM executions WHERE workflow_id = 'wf1'" },
  ],
});

const seed = (startedAt) => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: '1', workflowId: 'wf1', status: 'success', startedAt }]);
  return db;
};

test('loadPack rejects an unknown kind loudly', () => {
  assert.throws(() => loadPack(JSON.stringify({ expectations: [{ name: 'x', kind: 'vibes', sql: 'SELECT 1' }] })),
    /unknown expectation kind/);
});

test('loadPack rejects anything that is not a single SELECT', () => {
  const bad = (sql) => JSON.stringify({ expectations: [{ name: 'x', kind: 'min-count', min: 1, sql }] });
  assert.throws(() => loadPack(bad('DELETE FROM executions')), /must be a single SELECT/);
  assert.throws(() => loadPack(bad('SELECT 1; DROP TABLE executions')), /must be a single SELECT/);
  assert.doesNotThrow(() => loadPack(bad('SELECT COUNT(*) FROM executions')));
  assert.doesNotThrow(() => loadPack(bad('WITH x AS (SELECT 1) SELECT COUNT(*) FROM x')));
});

test('loadPack rejects an expectation missing the threshold its kind compares against', () => {
  // A misspelled threshold key is the likeliest authoring mistake in a
  // hand-written pack, and it is the one that fails silently at load: `n >=
  // undefined` is false forever, so the expectation reports a permanent
  // failure ("0 < undefined") that no data can clear. Catch it at load.
  assert.throws(() => loadPack(JSON.stringify({ expectations: [
    { name: 'x', kind: 'min-count', minimum: 1, sql: 'SELECT COUNT(*) FROM executions' }] })),
  /missing min/);
  assert.throws(() => loadPack(JSON.stringify({ expectations: [
    { name: 'x', kind: 'max-age-minutes', maxAge: 60, sql: 'SELECT MAX(started_at) FROM executions' }] })),
  /missing maxAgeMinutes/);
  assert.doesNotThrow(() => loadPack(JSON.stringify({ expectations: [
    { name: 'x', kind: 'min-count', min: 0, sql: 'SELECT COUNT(*) FROM executions' }] })),
  'a threshold of 0 is a real threshold, not a missing one');
});

test('loadPack rejects a placeholder count that does not match the window', () => {
  const e = (extra) => JSON.stringify({ expectations: [{ name: 'x', kind: 'min-count', min: 1, ...extra }] });
  assert.throws(() => loadPack(e({ sql: 'SELECT COUNT(*) FROM executions WHERE started_at >= ?' })),
    /one \? placeholder/);
  assert.throws(() => loadPack(e({ windowMinutes: 60, sql: 'SELECT COUNT(*) FROM executions' })),
    /one \? placeholder/);
});

test('a satisfied pack reports every expectation ok', () => {
  const results = evaluate(seed('2026-08-11T02:00:00.000Z'), loadPack(PACK), NOW);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
});

test('min-count fails when the query returns zero', () => {
  const db = openDb(':memory:');
  const [count] = evaluate(db, loadPack(PACK), NOW);
  assert.equal(count.ok, false);
  assert.match(count.detail, /0 < 1/);
});

test('a success outside the window does not satisfy a windowed min-count', () => {
  const [count] = evaluate(seed('2026-08-01T02:00:00.000Z'), loadPack(PACK), NOW);
  assert.equal(count.ok, false, 'a run from ten days ago must not count as last night');
});

test('max-age fails when the newest row is older than the window', () => {
  const [, fresh] = evaluate(seed('2026-08-09T02:00:00.000Z'), loadPack(PACK), NOW);
  assert.equal(fresh.ok, false);
  assert.match(fresh.detail, /older than 1560 min/);
});

test('a null timestamp is stale, not fresh', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: '1', workflowId: 'wf1', status: 'success', startedAt: null }]);
  const [, fresh] = evaluate(db, loadPack(PACK), NOW);
  assert.equal(fresh.ok, false);
});

test('a broken query fails its expectation instead of the whole evaluation', () => {
  const pack = loadPack(JSON.stringify({ expectations: [
    { name: 'typo', kind: 'min-count', min: 1, sql: 'SELECT COUNT(*) FROM nosuchtable' },
    { name: 'fine', kind: 'min-count', min: 0, sql: 'SELECT COUNT(*) FROM executions' },
  ] }));
  const [broken, fine] = evaluate(openDb(':memory:'), pack, NOW);
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /query failed/);
  assert.equal(fine.ok, true);
});

test('toNotifications renders a firing entry in the dashboard feed contract', () => {
  const notes = toNotifications([{ name: 'b', detail: 'broken', kind: 'firing' }], NOW);
  assert.equal(notes.length, 1);
  assert.deepEqual(Object.keys(notes[0]).sort(), ['message', 'name', 'rule', 'status', 'title', 'ts']);
  assert.equal(notes[0].status, 'failure');
  assert.match(notes[0].title, /Expectation failed: b/);
  assert.match(notes[0].message, /broken/);
  assert.equal(notes[0].ts, new Date(NOW).toISOString());
});

test('toNotifications renders a resolved entry as a success notification', () => {
  const [note] = toNotifications([{ name: 'b', detail: 'fine', kind: 'resolved' }], NOW);
  assert.equal(note.status, 'success');
  assert.match(note.title, /Expectation recovered: b/);
});

// ---- reconcileExpectations: gate notifications on state transition ---------
// This is the fix for the flood the review caught in production: evaluate()
// re-reports a persistently failing expectation on every rebuild, and without
// gating, toNotifications([...]) turned that into 46 identical feed entries.

const ok = (name) => ({ name, ok: true, detail: 'fine' });
const bad = (name, detail = 'broken') => ({ name, ok: false, detail });

test('an ok->fail transition fires exactly once', () => {
  const first = reconcileExpectations([bad('x')], null, { now: NOW });
  assert.equal(first.fire.length, 1);
  assert.equal(first.fire[0].kind, 'firing');
  assert.equal(first.state.x.failing, true);

  // Same failure, immediately again: still within the renotify window (0 here
  // means "never renotify"), so it must not fire a second time.
  const second = reconcileExpectations([bad('x')], first.state, { now: NOW, renotifyMin: 0 });
  assert.equal(second.fire.length, 0, 'a steady failure must not re-fire every rebuild');
});

test('a steady failure re-fires only once the renotify window has elapsed', () => {
  const first = reconcileExpectations([bad('x')], null, { now: NOW, renotifyMin: 60 });
  const soon = reconcileExpectations([bad('x')], first.state, {
    now: NOW + 30 * 60_000, renotifyMin: 60,
  });
  assert.equal(soon.fire.length, 0, '30 minutes into a 60-minute window must stay quiet');

  const due = reconcileExpectations([bad('x')], first.state, {
    now: NOW + 61 * 60_000, renotifyMin: 60,
  });
  assert.equal(due.fire.length, 1);
  assert.equal(due.fire[0].kind, 'firing');
});

test('never fires while ok', () => {
  const { fire, state } = reconcileExpectations([ok('x')], null, { now: NOW });
  assert.deepEqual(fire, []);
  assert.deepEqual(state, {}, 'an ok expectation is never tracked in state');
});

test('a fail->ok transition fires one recovery entry', () => {
  const failing = reconcileExpectations([bad('x')], null, { now: NOW });
  const recovered = reconcileExpectations([ok('x')], failing.state, { now: NOW });
  assert.equal(recovered.fire.length, 1);
  assert.equal(recovered.fire[0].kind, 'resolved');
  assert.equal(recovered.fire[0].name, 'x');
  assert.deepEqual(recovered.state, {}, 'a recovered expectation is dropped, not tombstoned');
});

test('corrupt or malformed prevState is tolerated, not fatal', () => {
  for (const garbage of ['not an object', 42, [], undefined]) {
    const { fire } = reconcileExpectations([bad('x')], garbage, { now: NOW });
    assert.equal(fire.length, 1, `garbage prevState ${JSON.stringify(garbage)} must start over, not throw`);
  }
});

test('reconciliation state round-trips through kv across two calls', () => {
  // Mirrors the pattern index.mjs runs on every rebuild: read the persisted
  // state (corrupt -> start over, same as alerts.mjs), reconcile, persist.
  const db = openDb(':memory:');
  const read = () => { try { return JSON.parse(getKv(db, 'expectation-state') ?? 'null'); } catch { return null; } };

  const first = reconcileExpectations([bad('x')], read(), { now: NOW, renotifyMin: 60 });
  setKv(db, 'expectation-state', JSON.stringify(first.state));
  assert.equal(first.fire.length, 1, 'first sight of the failure notifies');

  const second = reconcileExpectations([bad('x')], read(), { now: NOW + 1000, renotifyMin: 60 });
  setKv(db, 'expectation-state', JSON.stringify(second.state));
  assert.equal(second.fire.length, 0, 'the persisted state survived the round trip and suppressed the repeat');
});

// ---- nullIsPending: NULL means "cannot be computed", not "counted zero" -----
const one = (extra) => loadPack(JSON.stringify({ expectations: [
  { name: 'x', kind: 'min-count', min: 1, ...extra }] }));

test('loadPack rejects a non-boolean nullIsPending', () => {
  assert.throws(() => one({ nullIsPending: 'yes', sql: 'SELECT 1' }), /nullIsPending/);
  assert.doesNotThrow(() => one({ nullIsPending: true, sql: 'SELECT 1' }));
  assert.doesNotThrow(() => one({ sql: 'SELECT 1' }), 'absent is the default');
});

test('loadPack rejects nullIsPending on a max-age expectation, where it does nothing', () => {
  assert.throws(() => loadPack(JSON.stringify({ expectations: [
    { name: 'x', kind: 'max-age-minutes', maxAgeMinutes: 60, nullIsPending: true,
      sql: 'SELECT MAX(started_at) FROM executions' }] })), /nullIsPending/);
});

test('a NULL min-count still fails when the expectation did not opt in', () => {
  // SUM over an empty set is NULL in SQLite, and an operator who wrote it
  // means "nothing happened" — the failure expectation packs exist to catch.
  const db = seed('2026-08-11T05:00:00.000Z');
  const pack = one({ sql: "SELECT SUM(1) FROM executions WHERE status = 'error'" });
  const [r] = evaluate(db, pack, NOW);
  assert.deepEqual([r.ok, r.detail], [false, '0 < 1']);
});

test('an opted-in expectation reports NULL as pending, not as a failure', () => {
  const db = seed('2026-08-11T05:00:00.000Z');
  const pack = one({ nullIsPending: true, sql: "SELECT SUM(1) FROM executions WHERE status = 'error'" });
  const [r] = evaluate(db, pack, NOW);
  assert.equal(r.pending, true);
  assert.equal(r.ok, undefined, 'pending is a third outcome, not a quiet pass');
  assert.match(r.detail, /no baseline sample yet/);
});

test('a genuine zero still fails even with nullIsPending set', () => {
  const db = seed('2026-08-11T05:00:00.000Z');
  const pack = one({ nullIsPending: true, sql: "SELECT COUNT(*) FROM executions WHERE status = 'error'" });
  const [r] = evaluate(db, pack, NOW);
  assert.deepEqual([r.ok, r.detail], [false, '0 < 1']);
});

test('a broken query fails rather than going pending', () => {
  const db = seed('2026-08-11T05:00:00.000Z');
  const pack = one({ nullIsPending: true, sql: 'SELECT nope FROM executions' });
  const [r] = evaluate(db, pack, NOW);
  assert.equal(r.ok, false);
  assert.match(r.detail, /query failed/);
});

test('a pending result notifies nothing and starts no state', () => {
  const { fire, state } = reconcileExpectations(
    [{ name: 'x', pending: true, detail: 'no baseline sample yet' }], null, { now: NOW },
  );
  assert.deepEqual(fire, []);
  assert.deepEqual(state, {});
});

test('a pending result carries a prior failure forward instead of resolving it', () => {
  // Preserving the entry matters twice: nothing publishes a recovery the data
  // does not support, and a failure that returns is not re-announced as new.
  const prev = { x: { failing: true, lastNotifiedAt: '2026-08-11T05:00:00.000Z' } };
  const { fire, state } = reconcileExpectations(
    [{ name: 'x', pending: true, detail: 'no baseline sample yet' }], prev, { now: NOW, renotifyMin: 1 },
  );
  assert.deepEqual(fire, [], 'no recovery, and no renotify either');
  assert.deepEqual(state, prev, 'the failure is still tracked');
});

// ---- the shipped pack ------------------------------------------------------
const shippedPack = () => loadPack(readFileSync(new URL('./packs/example.json', import.meta.url), 'utf8'));
const growth = (db, now) => evaluate(db, shippedPack(), now).find((r) => /orders grew/.test(r.name));
const withSamples = (...samples) => {
  const db = seed('2026-08-11T05:00:00.000Z');
  for (const [rows, sampledAt] of samples) {
    db.prepare('INSERT INTO datatable_counts (key, rows, sampled_at) VALUES (?, ?, ?)').run('orders', rows, sampledAt);
  }
  return db;
};

test('the shipped growth expectation is pending on a store with no baseline yet', () => {
  const r = growth(withSamples([120, '2026-08-11T05:00:00.000Z']), NOW);
  assert.equal(r.pending, true);
  assert.equal(r.ok, undefined);
});

test('the shipped growth expectation passes once a baseline straddles the window', () => {
  const db = withSamples([100, '2026-08-09T00:00:00.000Z'], [120, '2026-08-11T05:00:00.000Z']);
  assert.equal(growth(db, NOW).ok, true);
});

test('the shipped growth expectation still fails on a warmed store that did not grow', () => {
  const db = withSamples([120, '2026-08-09T00:00:00.000Z'], [120, '2026-08-11T05:00:00.000Z']);
  assert.equal(growth(db, NOW).ok, false);
});

// ---- structured evidence (#17) ----------------------------------------------
test('a min-count result carries its threshold, the observed value and the window', () => {
  const db = withSamples([120, '2026-08-11T05:00:00.000Z'], [120, '2026-08-09T00:00:00.000Z']);
  const r = growth(db, NOW);
  assert.deepEqual([r.threshold, r.observed, r.window], [{ min: 1 }, { value: 0 }, { minutes: 1560 }]);
});

test('a max-age result carries its threshold and the observed age', () => {
  const db = seed('2026-08-11T05:00:00.000Z');
  const pack = loadPack(JSON.stringify({ expectations: [{
    name: 'fresh', kind: 'max-age-minutes', maxAgeMinutes: 30, sql: 'SELECT MAX(started_at) FROM executions' }] }));
  const [r] = evaluate(db, pack, NOW);
  assert.deepEqual([r.threshold, r.observed, r.window], [{ maxAgeMinutes: 30 }, { ageMin: 60 }, undefined]);
});

test('a failed query carries a threshold but no observed value', () => {
  const db = seed('2026-08-11T05:00:00.000Z');
  const [r] = evaluate(db, one({ sql: 'SELECT nope FROM executions' }), NOW);
  assert.deepEqual(r.threshold, { min: 1 });
  assert.equal(r.observed, undefined);
});

test('the evidence survives reconciliation into the feed entry', () => {
  const result = { name: 'x', ok: false, detail: '0 < 1', threshold: { min: 1 }, observed: { value: 0 }, window: { minutes: 60 } };
  const { fire } = reconcileExpectations([result], null, { now: NOW });
  const [n] = toNotifications(fire, NOW);
  assert.deepEqual(
    [n.rule, n.name, n.threshold, n.observed, n.window],
    ['expectation', 'x', { min: 1 }, { value: 0 }, { minutes: 60 }],
  );
});

test('a recovery entry carries rule and name', () => {
  const [n] = toNotifications([{ name: 'x', detail: '3 >= 1', kind: 'resolved', threshold: { min: 1 }, observed: { value: 3 } }], NOW);
  assert.deepEqual([n.rule, n.name, n.status], ['expectation', 'x', 'success']);
  assert.deepEqual(n.observed, { value: 3 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb, openReadOnlyDb, upsertExecutions, recentExecutions,
  pruneExecutions, getKv, setKv, recordTableCount, pruneDatatableCounts,
  upsertWorkflows, allWorkflows, errorTotals, executionTotals, lastSuccessByWorkflow,
  oldestRunningByWorkflow,
} from './db.mjs';
import { FAILED_STATUSES, FINISHED_STATUSES } from './exec-status.mjs';

const exec = (id, over = {}) => ({
  id, workflowId: 'wf1', workflowName: 'Ingest', status: 'success',
  startedAt: '2026-08-11T02:00:00.000Z', stoppedAt: '2026-08-11T02:00:05.000Z',
  createdAt: '2026-08-11T02:00:00.000Z', mode: 'trigger', ...over,
});

test('a pushed event without a workflowId must not erase the one poll-fill stored', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [exec('1', { status: 'running', stoppedAt: null })]);

  // Exactly what parseEvent() emits for an n8n.workflow.success event whose
  // payload carries only executionId: every unknown field is null. Those nulls
  // are "the push did not say", not "the value is gone" — the poll-filled
  // workflow association has to survive them, or summarizeExecutions() (which
  // skips rows with an empty workflowId) stops counting this success and the
  // stale-workflow alert fires for a workflow that is succeeding.
  upsertExecutions(db, [{
    id: '1', workflowId: null, workflowName: null, status: 'success',
    startedAt: null, stoppedAt: '2026-08-11T02:00:09.000Z', createdAt: null, mode: 'trigger',
  }]);

  const [row] = recentExecutions(db);
  assert.equal(row.workflowId, 'wf1', 'the pushed null must not have erased the workflow association');
  assert.equal(row.status, 'success');
  assert.equal(row.stoppedAt, '2026-08-11T02:00:09.000Z');
});

test('reopening an already-migrated file preserves its rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'po11y.db');

  const first = openDb(path);
  upsertExecutions(first, [exec('1')]);
  first.close();

  const second = openDb(path);
  assert.deepEqual(recentExecutions(second).map((r) => r.id), ['1']);
  second.close();
});

test('a read-only handle sees the rows and refuses to write', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'po11y.db');

  const rw = openDb(path);
  upsertExecutions(rw, [exec('1')]);

  const ro = openReadOnlyDb(path);
  assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM executions').get().n, 1);
  assert.throws(() => ro.prepare('DELETE FROM executions').run());
  ro.close();
  rw.close();
});

test('executions round-trip in n8n API shape', () => {
  const db = openDb(':memory:');
  assert.equal(upsertExecutions(db, [exec('1'), exec('2')]), 2);
  const rows = recentExecutions(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], exec('2'));
});

test('re-ingesting the same id updates rather than duplicates', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [exec('1', { status: 'running', stoppedAt: null })]);
  upsertExecutions(db, [exec('1')]);
  const rows = recentExecutions(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success');
});

test('recentExecutions orders newest first and honours the limit', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    exec('1', { startedAt: '2026-08-11T01:00:00.000Z' }),
    exec('2', { startedAt: '2026-08-11T03:00:00.000Z' }),
    exec('3', { startedAt: '2026-08-11T02:00:00.000Z' }),
  ]);
  assert.deepEqual(recentExecutions(db, 2).map((r) => r.id), ['2', '3']);
});

test('pruneExecutions drops rows older than the cutoff and keeps the rest', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    exec('old', { startedAt: '2026-06-01T00:00:00.000Z' }),
    exec('new', { startedAt: '2026-08-11T02:00:00.000Z' }),
  ]);
  assert.equal(pruneExecutions(db, '2026-07-01T00:00:00.000Z'), 1);
  assert.deepEqual(recentExecutions(db).map((r) => r.id), ['new']);
});

test('a row with no timestamps at all is pruned on its seen_at, not kept forever', () => {
  const db = openDb(':memory:');
  upsertExecutions(
    db,
    [exec('x', { startedAt: null, stoppedAt: null, createdAt: null })],
    '2026-06-01T00:00:00.000Z',
  );
  assert.equal(pruneExecutions(db, '2026-07-01T00:00:00.000Z'), 1);
});

test('recordTableCount overwrites the same (key, sampled_at) rather than duplicating', () => {
  const db = openDb(':memory:');
  recordTableCount(db, 'orders', 100, '2026-08-11T06:00:00.000Z');
  recordTableCount(db, 'orders', 105, '2026-08-11T06:00:00.000Z');
  const rows = db.prepare('SELECT key, rows, sampled_at FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'orders', rows: 105, sampled_at: '2026-08-11T06:00:00.000Z' }]);
});

test('recordTableCount keeps distinct samples for the same key at different times', () => {
  const db = openDb(':memory:');
  recordTableCount(db, 'orders', 100, '2026-08-10T06:00:00.000Z');
  recordTableCount(db, 'orders', 110, '2026-08-11T06:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM datatable_counts').get().n, 2);
});

test('pruneDatatableCounts drops samples older than the cutoff and keeps the rest', () => {
  const db = openDb(':memory:');
  recordTableCount(db, 'orders', 90, '2026-06-01T00:00:00.000Z');
  recordTableCount(db, 'orders', 100, '2026-08-11T02:00:00.000Z');
  assert.equal(pruneDatatableCounts(db, '2026-07-01T00:00:00.000Z'), 1);
  const rows = db.prepare('SELECT key FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ key: 'orders' }]);
});

test('kv round-trips and overwrites', () => {
  const db = openDb(':memory:');
  assert.equal(getKv(db, 'alert-state'), null);
  setKv(db, 'alert-state', '{"a":1}');
  setKv(db, 'alert-state', '{"a":2}');
  assert.equal(getKv(db, 'alert-state'), '{"a":2}');
});

// ---- status regression guard: poll truth wins, except 'running' can't
// un-terminate a settled row -------------------------------------------------
// A late or re-delivered push 'started' event must not regress a terminal row
// (success/error/crashed) back to 'running' — if the row has since aged out of
// the poll window it would stay wrong forever and eventually trip a false
// stuck-execution alert.

test('a late running upsert does not regress a terminal row', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [exec('1', { status: 'success' })]);
  upsertExecutions(db, [exec('1', { status: 'running', stoppedAt: null })]);
  const [row] = recentExecutions(db);
  assert.equal(row.status, 'success', 'poll truth must not be undone by a stale running push');
  assert.equal(row.stoppedAt, '2026-08-11T02:00:05.000Z', 'stoppedAt from the terminal row must survive too');
});

test('every other transition still lets the new status win, including running->success', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [exec('1', { status: 'running', stoppedAt: null })]);
  upsertExecutions(db, [exec('1', { status: 'success' })]);
  assert.equal(recentExecutions(db)[0].status, 'success');
});

test('error and crashed rows are just as protected from a late running upsert', () => {
  const db = openDb(':memory:');
  for (const terminal of ['error', 'crashed']) {
    upsertExecutions(db, [exec(terminal, { status: terminal })]);
    upsertExecutions(db, [exec(terminal, { status: 'running', stoppedAt: null })]);
    assert.equal(recentExecutions(db).find((r) => r.id === terminal).status, terminal);
  }
});

// ---- batch upserts run in one transaction (perf: one fsync per batch) ------

test('upsertExecutions still returns the correct row count inside its transaction', () => {
  const db = openDb(':memory:');
  assert.equal(upsertExecutions(db, [exec('1'), exec('2'), { id: null }, exec('3')]), 3);
});

test('upsertWorkflows still returns the correct row count inside its transaction', () => {
  const db = openDb(':memory:');
  const wf = (id) => ({ id, name: id, active: true });
  assert.equal(upsertWorkflows(db, [wf('a'), wf('b'), { id: null }]), 2);
  assert.equal(allWorkflows(db).length, 2);
});

test('a failure mid-batch rolls back the whole upsertExecutions call, not a partial write', () => {
  const db = openDb(':memory:');
  // workflowId is bound as-is when not nullish (r.workflowId ?? null), and
  // node:sqlite's bind only accepts number/string/bigint/null/Buffer — an
  // object throws a TypeError. The earlier row in the same batch must not
  // remain committed once that later row blows up the transaction.
  assert.throws(() => upsertExecutions(db, [exec('1'), exec('2', { workflowId: {} })]));
  assert.equal(recentExecutions(db).length, 0, 'the transaction must have rolled back');
});

test('recentExecutions filters by workflowId and status without changing the default shape', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    { id: '1', workflowId: 'a', status: 'success', startedAt: '2026-08-01T00:00:00.000Z' },
    { id: '2', workflowId: 'b', status: 'error', startedAt: '2026-08-02T00:00:00.000Z' },
    { id: '3', workflowId: 'a', status: 'error', startedAt: '2026-08-03T00:00:00.000Z' },
  ]);
  assert.deepEqual(recentExecutions(db, 10).map((r) => r.id), ['3', '2', '1']);
  assert.deepEqual(recentExecutions(db, 10, { workflowId: 'a' }).map((r) => r.id), ['3', '1']);
  assert.deepEqual(recentExecutions(db, 10, { workflowId: 'a', status: 'error' }).map((r) => r.id), ['3']);
  assert.deepEqual(recentExecutions(db, 10, { status: 'error' }).map((r) => r.id), ['3', '2']);
});

test('recentExecutions ordering is served by the executions_recent expression index', () => {
  const db = openDb(':memory:');
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT id, workflow_id, workflow_name, status, started_at, stopped_at, created_at, mode
     FROM executions ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT 100`,
  ).all().map((r) => r.detail).join(' ');
  assert.match(plan, /executions_recent/, `expected the expression index in: ${plan}`);
});

test('a failed execution increments the workflow error total exactly once', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error', startedAt: '2026-08-14T10:00:00.000Z' }]);
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error', startedAt: '2026-08-14T10:00:00.000Z' }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]]);
});

test('a running execution that later fails is counted when it fails, not before', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'running', startedAt: '2026-08-14T10:00:00.000Z' }]);
  assert.deepEqual([...errorTotals(db)], []);
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error', startedAt: '2026-08-14T10:00:00.000Z' }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]]);
});

test('a push event with no workflow id is counted once the poll fills the id in', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: null, status: 'error' }]);
  assert.deepEqual([...errorTotals(db)], [], 'no workflow to attribute it to yet');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error' }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]]);
});

test('pruning executions does not decrease the error total', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error', createdAt: '2026-01-01T00:00:00.000Z' }]);
  pruneExecutions(db, '2026-06-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT count(*) AS n FROM executions').get().n, 0, 'row really was pruned');
  assert.deepEqual([...errorTotals(db)], [['w1', 1]], 'the counter survives the prune');
});

// The UPDATE trigger's WHEN guard is the whole design of the counter: it must
// suppress the re-seen failure (covered above) WITHOUT suppressing a genuine
// second failure of the same workflow. Only the pair proves it — a guard that
// counted nothing on update would pass the exactly-once test alone.
test('a workflow that fails, succeeds, then fails again increments twice', () => {
  const db = openDb(':memory:');
  const at = (t) => `2026-08-14T${t}:00.000Z`;

  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'error', startedAt: at('10:00') }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]]);

  upsertExecutions(db, [{ id: 'e2', workflowId: 'w1', status: 'running', startedAt: at('10:05') }]);
  upsertExecutions(db, [{ id: 'e2', workflowId: 'w1', status: 'success', startedAt: at('10:05') }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]], 'a success must not count');

  upsertExecutions(db, [{ id: 'e3', workflowId: 'w1', status: 'running', startedAt: at('10:10') }]);
  upsertExecutions(db, [{ id: 'e3', workflowId: 'w1', status: 'error', startedAt: at('10:10') }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 2]], 'a genuine re-failure must count again');

  // And re-seeing that third row on the next poll still must not.
  upsertExecutions(db, [{ id: 'e3', workflowId: 'w1', status: 'error', startedAt: at('10:10') }]);
  assert.deepEqual([...errorTotals(db)], [['w1', 2]]);
});

// exec-status.mjs is the single definition of "this run failed" and db.mjs
// composes the trigger SQL from it. If someone ever hand-writes the list back
// into the schema, this fails instead of the counter silently ignoring a newly
// added status.
test('the counter triggers are built from FAILED_STATUSES, not a fourth copy of the list', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
    .map((r) => r.name);
  assert.deepEqual(names, [
    'executions_failed_insert', 'executions_failed_update',
    'executions_finished_insert', 'executions_finished_update',
  ]);

  const sqlOf = (name) => db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(name).sql;
  // Every quoted lowercase literal in these triggers is a status literal; the
  // only other quoted strings are the COALESCE ''s, which do not match.
  const statusesIn = (name) => new Set([...sqlOf(name).matchAll(/'([a-z]+)'/g)].map((m) => m[1]));

  for (const name of ['executions_failed_insert', 'executions_failed_update']) {
    const quoted = statusesIn(name);
    for (const status of FAILED_STATUSES) {
      assert.ok(quoted.has(status), `${name} does not mention FAILED_STATUSES entry '${status}'`);
    }
    for (const status of quoted) {
      assert.ok(FAILED_STATUSES.includes(status),
        `${name} mentions '${status}', which is not in FAILED_STATUSES — the list has diverged again`);
    }
  }

  for (const name of ['executions_finished_insert', 'executions_finished_update']) {
    const quoted = statusesIn(name);
    for (const status of FINISHED_STATUSES) {
      assert.ok(quoted.has(status), `${name} does not mention FINISHED_STATUSES entry '${status}'`);
    }
    for (const status of quoted) {
      assert.ok(FINISHED_STATUSES.includes(status),
        `${name} mentions '${status}', which is not in FINISHED_STATUSES — the list has diverged again`);
    }
  }
});

// --- finished-execution counter ---------------------------------------------
//
// The denominator under the error counter. It has to count the same population
// the error counter does, or the ratio of the two is not a failure rate of
// anything: same exactly-once trigger design, same monotonicity across prunes,
// and a status set that CONTAINS every failed status.

test('a finished execution increments the workflow execution total exactly once', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success', startedAt: '2026-08-14T10:00:00.000Z' }]);
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success', startedAt: '2026-08-14T10:00:00.000Z' }]);
  assert.deepEqual([...executionTotals(db)], [['w1', 1]]);
});

test('a running execution is counted when it finishes, not before', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'running' }]);
  assert.deepEqual([...executionTotals(db)], [], 'a run in flight has not finished');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success' }]);
  assert.deepEqual([...executionTotals(db)], [['w1', 1]]);
});

// The invariant that makes errors/executions meaningful: every failure is also
// a finished execution, so the ratio can never exceed 1.
test('success, error and crashed all count as finished, so errors are a subset', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'success' },
    { id: 'e2', workflowId: 'w1', status: 'error' },
    { id: 'e3', workflowId: 'w1', status: 'crashed' },
  ]);
  assert.deepEqual([...executionTotals(db)], [['w1', 3]]);
  assert.deepEqual([...errorTotals(db)], [['w1', 2]]);
});

// canceled is a human stopping the run — exec-status.mjs calls it an intent,
// not a fault. Counting it in the denominator would make every cancellation
// look like a small drop in success rate.
test('a canceled execution is not counted — it never finished on its own', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'canceled' },
    { id: 'e2', workflowId: 'w1', status: 'waiting' },
    { id: 'e3', workflowId: 'w1', status: 'new' },
  ]);
  assert.deepEqual([...executionTotals(db)], []);
});

test('pruning executions does not decrease the execution total', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success', createdAt: '2026-01-01T00:00:00.000Z' }]);
  pruneExecutions(db, '2026-06-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT count(*) AS n FROM executions').get().n, 0, 'row really was pruned');
  assert.deepEqual([...executionTotals(db)], [['w1', 1]], 'the counter survives the prune');
});

test('an execution with no workflow id joins the execution total once the poll fills the id in', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: null, status: 'success' }]);
  assert.deepEqual([...executionTotals(db)], [], 'no workflow to attribute it to yet');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success' }]);
  assert.deepEqual([...executionTotals(db)], [['w1', 1]]);
});

// The upgrade path, and the reason this counter cannot simply start at zero.
// workflow_error_totals is already populated on every existing store; a fresh
// denominator starting from 0 means the first finished run computes
// 1 - 4/1 = -300% success. The table is therefore backfilled the one time it
// is created, from the failures already counted plus the successes still
// retained, which keeps errors <= executions from the very first scrape.
test('an existing store backfills the execution counter rather than starting it at zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-backfill-'));
  const path = join(dir, 'store.db');
  try {
    let db = openDb(path);
    upsertExecutions(db, [
      { id: 'e1', workflowId: 'w1', status: 'error' },
      { id: 'e2', workflowId: 'w1', status: 'crashed' },
      { id: 'e3', workflowId: 'w1', status: 'success' },
      { id: 'e4', workflowId: 'w2', status: 'success' },
    ]);
    assert.deepEqual([...errorTotals(db)], [['w1', 2]]);

    // Rewind to a store written before this counter existed.
    db.exec('DROP TRIGGER executions_finished_insert');
    db.exec('DROP TRIGGER executions_finished_update');
    db.exec('DROP TABLE workflow_execution_totals');
    db.close();

    db = openDb(path);
    const runs = executionTotals(db);
    assert.equal(runs.get('w1'), 3, 'two counted failures plus the one retained success');
    assert.equal(runs.get('w2'), 1);
    for (const [id, errors] of errorTotals(db)) {
      assert.ok((runs.get(id) || 0) >= errors,
        `${id}: ${errors} errors against ${runs.get(id)} executions would put the failure rate above 100%`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the backfill runs once, not on every open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-backfill-once-'));
  const path = join(dir, 'store.db');
  try {
    let db = openDb(path);
    upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success' }]);
    db.close();

    db = openDb(path);
    assert.deepEqual([...executionTotals(db)], [['w1', 1]], 'a reopen must not re-count retained rows');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The mirror of the error counter's guard test: suppressing the re-seen row
// must not also suppress the next genuine run.
test('two runs of the same workflow increment the execution total twice', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'running' }]);
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success' }]);
  upsertExecutions(db, [{ id: 'e1', workflowId: 'w1', status: 'success' }]);
  assert.deepEqual([...executionTotals(db)], [['w1', 1]], 're-seeing a finished run must not count');

  upsertExecutions(db, [{ id: 'e2', workflowId: 'w1', status: 'running' }]);
  upsertExecutions(db, [{ id: 'e2', workflowId: 'w1', status: 'error' }]);
  assert.deepEqual([...executionTotals(db)], [['w1', 2]]);
});

test('crashed counts as failed, success does not', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'crashed' },
    { id: 'e2', workflowId: 'w1', status: 'success' },
  ]);
  assert.deepEqual([...errorTotals(db)], [['w1', 1]]);
});

test('lastSuccessByWorkflow reports the most recent success only', () => {
  const db = openDb(':memory:');
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'success', stoppedAt: '2026-08-14T10:00:00.000Z' },
    { id: 'e2', workflowId: 'w1', status: 'success', stoppedAt: '2026-08-14T12:00:00.000Z' },
    { id: 'e3', workflowId: 'w1', status: 'error', stoppedAt: '2026-08-14T13:00:00.000Z' },
  ]);
  assert.deepEqual([...lastSuccessByWorkflow(db)], [['w1', Date.parse('2026-08-14T12:00:00.000Z')]]);
});

test('oldestRunningByWorkflow measures the oldest running execution, and ignores settled ones', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'running', startedAt: '2026-08-14T11:00:00.000Z' },
    { id: 'e2', workflowId: 'w1', status: 'running', startedAt: '2026-08-14T11:30:00.000Z' },
    { id: 'e3', workflowId: 'w2', status: 'success', startedAt: '2026-08-14T09:00:00.000Z' },
  ]);
  assert.deepEqual([...oldestRunningByWorkflow(db, now)], [['w1', 3600]]);
});

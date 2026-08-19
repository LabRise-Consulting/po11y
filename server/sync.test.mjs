import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, allWorkflows, recentExecutions, recordTableCount, getKv,
} from './db.mjs';
import {
  syncWorkflows, pollFill, pruneOlderThan, assertGetOnly, withTimeout, POLL_LAST_SUCCESS_KEY,
} from './sync.mjs';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('assertGetOnly rejects any non-GET call', async () => {
  const wrapped = assertGetOnly(async () => jsonResponse({}));
  await assert.rejects(() => wrapped('http://n8n/api/v1/x', { method: 'POST' }),
    /GET-only/);
  await assert.doesNotReject(() => wrapped('http://n8n/api/v1/x'));
  await assert.doesNotReject(() => wrapped('http://n8n/api/v1/x', { method: 'GET' }));
});

// A fetch with no deadline never fails, it just never returns — and a tick
// that never returns is a loop that never ticks again (timers.mjs re-arms only
// after a tick settles). The timeout is what turns "n8n stalled" into a
// logged failure the health counters can see.
test('withTimeout aborts a fetch that never answers', async () => {
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  await assert.rejects(() => withTimeout(hanging, 20)('http://n8n/api/v1/workflows'),
    (e) => e.name === 'TimeoutError');
});

test('withTimeout gives every call its own deadline', async () => {
  // A signal created once at wrap time would fire ms after the *server*
  // started and abort every call from then on.
  const wrapped = withTimeout(async () => jsonResponse({ data: [] }), 40);
  await wrapped('http://n8n/api/v1/workflows');
  await new Promise((r) => { setTimeout(r, 60); });
  await assert.doesNotReject(() => wrapped('http://n8n/api/v1/workflows'));
});

test('syncWorkflows stores the full workflow documents', async () => {
  const db = openDb(':memory:');
  const wf = { id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} };
  const fetchFn = async () => jsonResponse({ data: [wf], nextCursor: null });
  assert.equal(await syncWorkflows(db, fetchFn, 'http://n8n', 'k'), 1);
  assert.deepEqual(allWorkflows(db), [wf]);
});

test('syncWorkflows propagates an n8n outage so health can see it', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(() => syncWorkflows(db, fetchFn, 'http://n8n', 'k'), /502/);
});

// ---- syncWorkflows prunes workflows n8n no longer reports -------------------
// A workflow deleted or archived on n8n must not survive in the store forever:
// map.json/forms.json would keep rendering it (a form button that 404s in
// n8n) and the stale-workflow alert would fire for it with no recovery.

// now1/now2 are passed explicitly (syncWorkflows accepts an optional `now`,
// same injection pattern as pruneOlderThan/upsertExecutions) so two syncs in
// the same test cannot land the same millisecond stamp and defeat the
// seen_at < stamp prune below by accident.
const NOW1 = Date.parse('2026-08-13T02:00:00.000Z');
const NOW2 = Date.parse('2026-08-13T03:00:00.000Z');

test('a workflow present in one sync and absent from the next is gone afterward', async () => {
  const db = openDb(':memory:');
  const wf1 = { id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} };
  const wf2 = { id: 'wf2', name: 'Report', active: true, nodes: [], connections: {} };

  await syncWorkflows(db, async () => jsonResponse({ data: [wf1, wf2], nextCursor: null }), 'http://n8n', 'k', NOW1);
  assert.deepEqual(allWorkflows(db).map((w) => w.id).sort(), ['wf1', 'wf2']);

  // wf2 was deleted/archived on n8n: the next full sync no longer reports it.
  await syncWorkflows(db, async () => jsonResponse({ data: [wf1], nextCursor: null }), 'http://n8n', 'k', NOW2);
  assert.deepEqual(allWorkflows(db).map((w) => w.id), ['wf1']);
});

test('an empty workflow list is never read as "n8n deleted everything"', async () => {
  const db = openDb(':memory:');
  const wf1 = { id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} };
  await syncWorkflows(db, async () => jsonResponse({ data: [wf1], nextCursor: null }), 'http://n8n', 'k', NOW1);

  // fetchAllWorkflows only pushes when the page carries a `data` array, so a
  // 200 whose body has none (a proxy rewriting the response, a gateway error
  // page served with the wrong status, a key scoped away from workflows)
  // returns [] instead of throwing. Pruning on that empties map.json/forms.json
  // AND makes evaluateAlerts() iterate nothing, so reconcileAlerts resolves
  // every open alert — a false all-clear, the one outcome alerts.mjs says must
  // never happen.
  await syncWorkflows(db, async () => jsonResponse({ nextCursor: null }), 'http://n8n', 'k', NOW2);
  assert.deepEqual(allWorkflows(db).map((w) => w.id), ['wf1'],
    'an empty fetch must not have pruned the store');
});

test('a failed fetch leaves the store untouched — an outage is not a mass delete', async () => {
  const db = openDb(':memory:');
  const wf1 = { id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} };
  await syncWorkflows(db, async () => jsonResponse({ data: [wf1], nextCursor: null }), 'http://n8n', 'k', NOW1);

  const failing = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(() => syncWorkflows(db, failing, 'http://n8n', 'k', NOW2), /502/);
  assert.deepEqual(allWorkflows(db).map((w) => w.id), ['wf1'], 'the failed sync must not have pruned anything');
});

test('of two workflows, only the one missing from the refetch is deleted', async () => {
  const db = openDb(':memory:');
  const wf1 = { id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} };
  const wf2 = { id: 'wf2', name: 'Report', active: true, nodes: [], connections: {} };
  await syncWorkflows(db, async () => jsonResponse({ data: [wf1, wf2], nextCursor: null }), 'http://n8n', 'k', NOW1);

  const wf1Renamed = { ...wf1, name: 'Ingest v2' };
  await syncWorkflows(db, async () => jsonResponse({ data: [wf1Renamed], nextCursor: null }), 'http://n8n', 'k', NOW2);

  const remaining = allWorkflows(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'wf1');
  assert.equal(remaining[0].name, 'Ingest v2', 'the surviving row must still be the freshly refetched one');
});

test('pollFill is idempotent across overlapping windows', async () => {
  const db = openDb(':memory:');
  const page = { data: [
    { id: '1', workflowId: 'wf1', status: 'success', startedAt: '2026-08-11T02:00:00.000Z' },
    { id: '2', workflowId: 'wf1', status: 'error', startedAt: '2026-08-11T02:05:00.000Z' },
  ] };
  const fetchFn = async () => jsonResponse(page);
  await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  assert.equal(recentExecutions(db).length, 2);
});

// n8n's public API leaves in-flight executions OUT of the default listing:
// GET /executions?limit=N returns only finished ones, and a running execution
// is reachable only via ?status=running. Polling the default list alone
// therefore never learns that anything is running — which silently emptied
// po11y_workflow_running_seconds, the watchdog's `stuck` rule and the
// dashboard's live indicator on every poll-driven deployment.
test('pollFill records executions that only the running listing returns', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => jsonResponse({
    data: String(url).includes('status=running')
      ? [{ id: '9', workflowId: 'wf1', status: 'running', startedAt: '2026-08-11T02:10:00.000Z' }]
      : [{ id: '1', workflowId: 'wf1', status: 'success', startedAt: '2026-08-11T02:00:00.000Z' }],
  });
  const { ok } = await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  assert.equal(ok, true);
  const stored = recentExecutions(db);
  assert.deepEqual(stored.map((e) => [e.id, e.status]).sort(),
    [['1', 'success'], ['9', 'running']]);
});

// The running listing is a supplement, not the poll's evidence of life: losing
// it must not take down the executions poll, the stamp, or the tick behind it.
test('pollFill survives a failing running listing and keeps the finished window', async () => {
  const db = openDb(':memory:');
  const fetchFn = async (url) => {
    if (String(url).includes('status=running')) throw new Error('running listing refused');
    return jsonResponse({ data: [{ id: '1', workflowId: 'wf1', status: 'success', startedAt: '2026-08-11T02:00:00.000Z' }] });
  };
  const { ok, error } = await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  assert.equal(ok, true, 'the finished window arrived, so the poll succeeded');
  assert.equal(error, null);
  assert.equal(recentExecutions(db).length, 1);
});

// po11y_poll_last_success_timestamp_seconds exists to say "the poll stopped
// working". These assert the store itself, not a call count: after a failed
// poll the stored value must be the OLD one (see syncExecutions in sync.mjs
// for why the stamp is owned there).
const AT_10 = Date.parse('2026-08-14T10:00:00.000Z');
const AT_11 = Date.parse('2026-08-14T11:00:00.000Z');
const oneExecution = () => jsonResponse({ data: [
  { id: '1', workflowId: 'wf1', status: 'success', startedAt: '2026-08-14T09:59:00.000Z' },
] });

test('an unreachable n8n leaves the stored poll-last-success stamp to age', async () => {
  const db = openDb(':memory:');

  const good = await pollFill(db, oneExecution, 'http://n8n', 'k', 100, AT_10);
  assert.equal(good.ok, true);
  assert.equal(getKv(db, POLL_LAST_SUCCESS_KEY), '2026-08-14T10:00:00.000Z');

  const refused = async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:5678'); };
  const bad = await pollFill(db, refused, 'http://n8n', 'k', 100, AT_11);
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /ECONNREFUSED/);
  assert.equal(getKv(db, POLL_LAST_SUCCESS_KEY), '2026-08-14T10:00:00.000Z',
    'a failed poll must not refresh the stamp — this is what lets Po11yPollStalled fire');
});

test('a revoked API key leaves the stored poll-last-success stamp to age', async () => {
  const db = openDb(':memory:');
  await pollFill(db, oneExecution, 'http://n8n', 'k', 100, AT_10);

  const unauthorized = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const bad = await pollFill(db, unauthorized, 'http://n8n', 'k', 100, AT_11);
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /401/);
  assert.equal(getKv(db, POLL_LAST_SUCCESS_KEY), '2026-08-14T10:00:00.000Z');
});

// A 200 whose body carries no `data` array is a non-answer too — a proxy
// rewriting the response, an error page served with the wrong status, a key
// scoped away from executions. It is NOT an idle instance: that answers
// {data: []}, which the positive case below proves still counts as a success.
test('a 200 with no data array is a non-answer and does not refresh the stamp', async () => {
  const db = openDb(':memory:');
  await pollFill(db, oneExecution, 'http://n8n', 'k', 100, AT_10);

  const noData = async () => jsonResponse({ message: 'unauthorized' });
  const bad = await pollFill(db, noData, 'http://n8n', 'k', 100, AT_11);
  assert.equal(bad.ok, false);
  assert.equal(getKv(db, POLL_LAST_SUCCESS_KEY), '2026-08-14T10:00:00.000Z');
});

test('an instance with no executions at all still counts as a successful poll', async () => {
  const db = openDb(':memory:');
  const empty = async () => jsonResponse({ data: [] });
  const res = await pollFill(db, empty, 'http://n8n', 'k', 100, AT_11);
  assert.equal(res.ok, true);
  assert.equal(res.n, 0);
  assert.equal(getKv(db, POLL_LAST_SUCCESS_KEY), '2026-08-14T11:00:00.000Z');
});

test('a pushed running row is completed by a later poll of the same id', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => jsonResponse({ data: [
    { id: '1', workflowId: 'wf1', status: 'success', startedAt: '2026-08-11T02:00:00.000Z',
      stoppedAt: '2026-08-11T02:00:09.000Z' },
  ] });
  await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  const [row] = recentExecutions(db);
  assert.equal(row.status, 'success');
  assert.equal(row.stoppedAt, '2026-08-11T02:00:09.000Z');
});

test('pruneOlderThan removes exactly what falls outside the retention window', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => jsonResponse({ data: [
    { id: 'old', workflowId: 'wf1', status: 'success', startedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'new', workflowId: 'wf1', status: 'success', startedAt: '2026-08-11T02:00:00.000Z' },
  ] });
  await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  assert.equal(pruneOlderThan(db, 30, Date.parse('2026-08-12T00:00:00.000Z')), 1);
  assert.deepEqual(recentExecutions(db).map((r) => r.id), ['new']);
});

test('pruneOlderThan also bounds the datatable_counts series under the same cutoff', async () => {
  const db = openDb(':memory:');
  recordTableCount(db, 'orders', 90, '2026-06-01T00:00:00.000Z');
  recordTableCount(db, 'orders', 100, '2026-08-11T02:00:00.000Z');
  const removed = pruneOlderThan(db, 30, Date.parse('2026-08-12T00:00:00.000Z'));
  assert.equal(removed, 1);
  const rows = db.prepare('SELECT rows FROM datatable_counts').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ rows: 100 }]);
});

test('retention of 0 days is a kill switch, not "delete everything"', async () => {
  const db = openDb(':memory:');
  const fetchFn = async () => jsonResponse({ data: [
    { id: 'old', workflowId: 'wf1', status: 'success', startedAt: '2020-01-01T00:00:00.000Z' },
  ] });
  await pollFill(db, fetchFn, 'http://n8n', 'k', 100);
  assert.equal(pruneOlderThan(db, 0, Date.parse('2026-08-12T00:00:00.000Z')), 0);
  assert.equal(recentExecutions(db).length, 1);
});

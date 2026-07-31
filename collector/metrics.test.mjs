import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLabelValue, accumulateErrors, buildSnapshot, renderMetrics } from './metrics.mjs';

// ---- escapeLabelValue -------------------------------------------------------

test('label values escape backslash, quote and newline', () => {
  assert.equal(escapeLabelValue('plain'), 'plain');
  assert.equal(escapeLabelValue('a"b'), 'a\\"b');
  assert.equal(escapeLabelValue('a\\b'), 'a\\\\b');
  assert.equal(escapeLabelValue('a\nb'), 'a\\nb');
  // Backslash must be escaped BEFORE the quote, or the escape of the quote
  // gets re-escaped and the exposition is corrupt.
  assert.equal(escapeLabelValue('a\\"b'), 'a\\\\\\"b');
});

test('a non-string label value does not throw', () => {
  assert.equal(escapeLabelValue(42), '42');
  assert.equal(escapeLabelValue(null), 'null');
});

// ---- accumulateErrors -------------------------------------------------------

test('errors accumulate monotonically as the window slides', () => {
  const a = accumulateErrors(null, [
    { id: '1', workflowId: 'w1', status: 'error' },
    { id: '2', workflowId: 'w1', status: 'success' },
  ]);
  assert.equal(a.totals.get('w1'), 1);

  // Same window again — the already-counted execution must not count twice.
  const b = accumulateErrors(a, [
    { id: '1', workflowId: 'w1', status: 'error' },
    { id: '2', workflowId: 'w1', status: 'success' },
  ]);
  assert.equal(b.totals.get('w1'), 1);

  // Execution 1 has aged out of the window; a new error arrives. The total
  // must go UP, never back down to the window count.
  const c = accumulateErrors(b, [
    { id: '3', workflowId: 'w1', status: 'error' },
  ]);
  assert.equal(c.totals.get('w1'), 2);
});

test('an execution that turns from running into error is counted once, when it errors', () => {
  const a = accumulateErrors(null, [{ id: '9', workflowId: 'w1', status: 'running' }]);
  assert.equal(a.totals.get('w1'), undefined);

  const b = accumulateErrors(a, [{ id: '9', workflowId: 'w1', status: 'error' }]);
  assert.equal(b.totals.get('w1'), 1);

  const c = accumulateErrors(b, [{ id: '9', workflowId: 'w1', status: 'error' }]);
  assert.equal(c.totals.get('w1'), 1);
});

test('crashed executions increment the error counter, canceled ones do not', () => {
  const a = accumulateErrors(null, [
    { id: '1', workflowId: 'w1', status: 'crashed' },
    { id: '2', workflowId: 'w1', status: 'error' },
    { id: '3', workflowId: 'w1', status: 'canceled' },
    { id: '4', workflowId: 'w1', status: 'waiting' },
  ]);
  assert.equal(a.totals.get('w1'), 2);
});

test('an execution that turns from running into crashed is counted once', () => {
  const a = accumulateErrors(null, [{ id: '9', workflowId: 'w1', status: 'running' }]);
  const b = accumulateErrors(a, [{ id: '9', workflowId: 'w1', status: 'crashed' }]);
  const c = accumulateErrors(b, [{ id: '9', workflowId: 'w1', status: 'crashed' }]);
  assert.equal(b.totals.get('w1'), 1);
  assert.equal(c.totals.get('w1'), 1);
});

test('the counted set is pruned to the current window so memory stays bounded', () => {
  const a = accumulateErrors(null, [{ id: '1', workflowId: 'w1', status: 'error' }]);
  assert.equal(a.counted.size, 1);
  const b = accumulateErrors(a, [{ id: '2', workflowId: 'w1', status: 'success' }]);
  assert.equal(b.counted.size, 0); // id 1 left the window
  assert.equal(b.totals.get('w1'), 1); // ...but its contribution survives
});

test('executions missing an id or workflowId are skipped, not counted', () => {
  const a = accumulateErrors(null, [
    { workflowId: 'w1', status: 'error' },
    { id: '5', status: 'error' },
    { id: '6', workflowId: 'w2', status: 'error' },
  ]);
  assert.equal(a.totals.get('w1'), undefined);
  assert.equal(a.totals.get('w2'), 1);
});

test('a non-array execution list is tolerated', () => {
  const a = accumulateErrors(null, null);
  assert.equal(a.totals.size, 0);
  assert.equal(a.counted.size, 0);
});

// ---- buildSnapshot ----------------------------------------------------------

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

test('snapshot carries one entry per current workflow, zero-filled', () => {
  const summary = new Map();
  const snap = buildSnapshot(
    [{ id: 'w1', name: 'Nightly sync' }],
    summary,
    new Map(),
    { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW },
  );
  assert.equal(snap.n8nUp, 1);
  assert.equal(snap.pollLastSuccessMs, NOW);
  assert.deepEqual(snap.workflows, [
    { id: 'w1', name: 'Nightly sync', errorsTotal: 0, lastOkAtMs: null, runningSeconds: 0 },
  ]);
});

test('running seconds report the OLDEST running execution, in seconds not minutes', () => {
  const summary = new Map([['w1', {
    id: 'w1', name: 'Nightly sync', count: 2, errors: 0, lastAt: null, lastOkAt: null,
    running: [
      { id: '1', startedAt: '2026-07-29T11:59:30.000Z', ageMin: 0 },
      { id: '2', startedAt: '2026-07-29T11:30:00.000Z', ageMin: 30 },
    ],
  }]]);
  const snap = buildSnapshot([{ id: 'w1', name: 'Nightly sync' }], summary, new Map(), { now: NOW });
  assert.equal(snap.workflows[0].runningSeconds, 1800);
});

test('last success is a millisecond-precise epoch, and null when there is none', () => {
  const summary = new Map([['w1', {
    id: 'w1', name: 'n', count: 1, errors: 0, lastAt: null,
    lastOkAt: '2026-07-29T11:00:00.000Z', running: [],
  }]]);
  const snap = buildSnapshot([{ id: 'w1', name: 'n' }], summary, new Map(), { now: NOW });
  assert.equal(snap.workflows[0].lastOkAtMs, Date.parse('2026-07-29T11:00:00.000Z'));

  const bare = buildSnapshot([{ id: 'w2', name: 'm' }], new Map(), new Map(), { now: NOW });
  assert.equal(bare.workflows[0].lastOkAtMs, null);
});

test('totals for workflows that no longer exist are dropped from the snapshot', () => {
  const totals = new Map([['w1', 4], ['deleted', 99]]);
  const snap = buildSnapshot([{ id: 'w1', name: 'n' }], new Map(), totals, { now: NOW });
  assert.equal(snap.workflows.length, 1);
  assert.equal(snap.workflows[0].errorsTotal, 4);
});

test('a workflow with no name falls back to its id', () => {
  const snap = buildSnapshot([{ id: 'w1' }], new Map(), new Map(), { now: NOW });
  assert.equal(snap.workflows[0].name, 'w1');
});

// ---- renderMetrics ----------------------------------------------------------

test('exposition has HELP and TYPE for every metric and ends with a newline', () => {
  const out = renderMetrics({ n8nUp: 1, pollLastSuccessMs: NOW, workflows: [] });
  for (const m of [
    'po11y_n8n_up',
    'po11y_poll_last_success_timestamp_seconds',
    'po11y_workflow_errors_total',
    'po11y_workflow_last_success_timestamp_seconds',
    'po11y_workflow_running_seconds',
  ]) {
    assert.match(out, new RegExp(`^# HELP ${m} `, 'm'), `missing HELP for ${m}`);
    assert.match(out, new RegExp(`^# TYPE ${m} `, 'm'), `missing TYPE for ${m}`);
  }
  assert.match(out, /^# TYPE po11y_workflow_errors_total counter$/m);
  assert.match(out, /^# TYPE po11y_n8n_up gauge$/m);
  assert.ok(out.endsWith('\n'));
});

test('timestamps render as unix SECONDS, not milliseconds', () => {
  const out = renderMetrics({ n8nUp: 1, pollLastSuccessMs: NOW, workflows: [] });
  assert.match(out, /^po11y_poll_last_success_timestamp_seconds 1785326400$/m);
});

test('a poll that has never succeeded emits no last-success series', () => {
  const out = renderMetrics({ n8nUp: 0, pollLastSuccessMs: null, workflows: [] });
  assert.match(out, /^po11y_n8n_up 0$/m);
  assert.doesNotMatch(out, /^po11y_poll_last_success_timestamp_seconds \d/m);
});

test('per-workflow series carry both id and name labels', () => {
  const out = renderMetrics({
    n8nUp: 1,
    pollLastSuccessMs: NOW,
    workflows: [{ id: 'w1', name: 'Nightly sync', errorsTotal: 3, lastOkAtMs: NOW, runningSeconds: 12 }],
  });
  assert.match(out, /^po11y_workflow_errors_total\{workflow_id="w1",workflow_name="Nightly sync"\} 3$/m);
  assert.match(out, /^po11y_workflow_running_seconds\{workflow_id="w1",workflow_name="Nightly sync"\} 12$/m);
  assert.match(out, /^po11y_workflow_last_success_timestamp_seconds\{workflow_id="w1",workflow_name="Nightly sync"\} 1785326400$/m);
});

test('a workflow that never succeeded omits only its last-success series', () => {
  const out = renderMetrics({
    n8nUp: 1,
    pollLastSuccessMs: NOW,
    workflows: [{ id: 'w1', name: 'n', errorsTotal: 0, lastOkAtMs: null, runningSeconds: 0 }],
  });
  assert.match(out, /^po11y_workflow_errors_total\{workflow_id="w1",workflow_name="n"\} 0$/m);
  assert.doesNotMatch(out, /^po11y_workflow_last_success_timestamp_seconds\{/m);
});

test('a workflow name containing a quote cannot break out of the label', () => {
  const out = renderMetrics({
    n8nUp: 1,
    pollLastSuccessMs: NOW,
    workflows: [{ id: 'w1', name: 'say "hi"', errorsTotal: 0, lastOkAtMs: null, runningSeconds: 0 }],
  });
  assert.match(out, /workflow_name="say \\"hi\\""/);
  // Every non-comment line must have balanced, escaped quoting: exactly two
  // label values per series line.
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const unescaped = line.replace(/\\\\/g, '').replace(/\\"/g, '');
    assert.equal((unescaped.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${line}`);
  }
});

// ---- integration: the shape index.mjs serves --------------------------------
// index.mjs is a daemon with top-level side effects (it binds a port and polls
// on import), so it is not importable under test. This asserts the contract the
// handler must satisfy, against the same functions the handler composes.

test('a full poll composes into a scrapeable document', () => {
  const executions = [
    { id: '1', workflowId: 'w1', status: 'error', startedAt: '2026-07-29T11:00:00.000Z' },
    { id: '2', workflowId: 'w1', status: 'success', startedAt: '2026-07-29T11:30:00.000Z' },
    { id: '3', workflowId: 'w2', status: 'running', startedAt: '2026-07-29T11:00:00.000Z' },
  ];
  const summary = new Map([
    ['w1', { id: 'w1', name: 'A', count: 2, errors: 1, lastAt: '2026-07-29T11:30:00.000Z', lastOkAt: '2026-07-29T11:30:00.000Z', running: [] }],
    ['w2', { id: 'w2', name: 'B', count: 1, errors: 0, lastAt: '2026-07-29T11:00:00.000Z', lastOkAt: null, running: [{ id: '3', startedAt: '2026-07-29T11:00:00.000Z', ageMin: 60 }] }],
  ]);
  const counters = accumulateErrors(null, executions);
  const snap = buildSnapshot(
    [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }],
    summary, counters.totals,
    { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW },
  );
  const out = renderMetrics(snap);

  assert.match(out, /^po11y_n8n_up 1$/m);
  assert.match(out, /^po11y_workflow_errors_total\{workflow_id="w1",workflow_name="A"\} 1$/m);
  assert.match(out, /^po11y_workflow_errors_total\{workflow_id="w2",workflow_name="B"\} 0$/m);
  assert.match(out, /^po11y_workflow_running_seconds\{workflow_id="w2",workflow_name="B"\} 3600$/m);
  // w2 has never succeeded -> no last-success series for it, but w1 has one.
  assert.match(out, /^po11y_workflow_last_success_timestamp_seconds\{workflow_id="w1",workflow_name="A"\} /m);
  assert.doesNotMatch(out, /^po11y_workflow_last_success_timestamp_seconds\{workflow_id="w2"/m);
});

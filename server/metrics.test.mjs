import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertExecutions, upsertWorkflows } from './db.mjs';
import { buildSnapshot, renderMetrics, escapeLabelValue } from './metrics.mjs';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

function seeded() {
  const db = openDb(':memory:');
  upsertWorkflows(db, [{ id: 'w1', name: 'Nightly sync', active: true }]);
  upsertExecutions(db, [
    { id: 'e1', workflowId: 'w1', status: 'success', stoppedAt: '2026-08-14T11:00:00.000Z' },
    { id: 'e2', workflowId: 'w1', status: 'error', stoppedAt: '2026-08-14T11:30:00.000Z' },
    { id: 'e3', workflowId: 'w1', status: 'running', startedAt: '2026-08-14T11:45:00.000Z' },
  ]);
  return db;
}

test('the snapshot is driven by the workflow list, so a deleted workflow stops being exported', () => {
  const db = seeded();
  upsertExecutions(db, [{ id: 'e9', workflowId: 'gone', status: 'error' }]);
  const snap = buildSnapshot(db, { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW });
  assert.deepEqual(snap.workflows.map((w) => w.id), ['w1']);
});

test('the snapshot carries the store-derived numbers', () => {
  const snap = buildSnapshot(seeded(), { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW });
  assert.deepEqual(snap.workflows[0], {
    id: 'w1',
    name: 'Nightly sync',
    errorsTotal: 1,
    lastOkAtMs: Date.parse('2026-08-14T11:00:00.000Z'),
    runningSeconds: 900,
  });
});

test('an unreachable n8n renders po11y_n8n_up 0 and omits the poll timestamp entirely', () => {
  const text = renderMetrics(buildSnapshot(seeded(), { now: NOW, n8nUp: 0, pollLastSuccessMs: null }));
  assert.match(text, /^po11y_n8n_up 0$/m);
  assert.doesNotMatch(text, /po11y_poll_last_success_timestamp_seconds \d/,
    'a missing timestamp must be absent, never 0 — 0 is 1970 and reads as "last succeeded 56 years ago"');
});

test('every series carries HELP and TYPE exactly once', () => {
  const text = renderMetrics(buildSnapshot(seeded(), { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW }));
  for (const name of ['po11y_n8n_up', 'po11y_poll_last_success_timestamp_seconds',
    'po11y_workflow_errors_total', 'po11y_workflow_last_success_timestamp_seconds',
    'po11y_workflow_running_seconds']) {
    assert.equal((text.match(new RegExp(`^# HELP ${name} `, 'gm')) || []).length, 1, name);
    assert.equal((text.match(new RegExp(`^# TYPE ${name} `, 'gm')) || []).length, 1, name);
  }
});

test('label values are escaped so a quote or newline in a workflow name cannot break the format', () => {
  assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});

test('workflow series carry both the workflow_id and the workflow_name label', () => {
  const text = renderMetrics(buildSnapshot(seeded(), { now: NOW, n8nUp: 1, pollLastSuccessMs: NOW }));
  assert.match(text, /po11y_workflow_errors_total\{workflow_id="w1",workflow_name="Nightly sync"\} 1/);
});

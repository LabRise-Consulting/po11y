import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from './events.mjs';

test('workflow-finished event becomes one execution row', () => {
  const rows = parseEvent({
    eventName: 'n8n.workflow.success',
    ts: '2026-08-11T02:00:05.000Z',
    payload: {
      executionId: '4711', workflowId: 'wf1', workflowName: 'Ingest',
      isManual: false, success: true,
    },
  });
  assert.deepEqual(rows, [{
    id: '4711', workflowId: 'wf1', workflowName: 'Ingest', status: 'success',
    startedAt: null, stoppedAt: '2026-08-11T02:00:05.000Z',
    createdAt: null, mode: 'trigger',
  }]);
});

test('workflow-failed maps to the error status the feed builders expect', () => {
  const [row] = parseEvent({
    eventName: 'n8n.workflow.failed',
    ts: '2026-08-11T02:00:05.000Z',
    payload: { executionId: '4712', workflowId: 'wf1', isManual: true },
  });
  assert.equal(row.status, 'error');
  assert.equal(row.mode, 'manual');
});

test('workflow-started produces a running row with startedAt set', () => {
  const [row] = parseEvent({
    eventName: 'n8n.workflow.started',
    ts: '2026-08-11T02:00:00.000Z',
    payload: { executionId: '4713', workflowId: 'wf1' },
  });
  assert.equal(row.status, 'running');
  assert.equal(row.startedAt, '2026-08-11T02:00:00.000Z');
  assert.equal(row.stoppedAt, null);
});

test('node-level and unknown events are ignored, not errors', () => {
  assert.deepEqual(parseEvent({ eventName: 'n8n.node.started', payload: {} }), []);
  assert.deepEqual(parseEvent({ eventName: 'something.else' }), []);
});

test('malformed input returns no rows instead of throwing', () => {
  for (const bad of [null, undefined, 'string', 42, [], {}, { payload: null }]) {
    assert.deepEqual(parseEvent(bad), []);
  }
});

test('an event with no executionId is dropped', () => {
  assert.deepEqual(parseEvent({ eventName: 'n8n.workflow.success', payload: { workflowId: 'wf1' } }), []);
});

// ---- ts normalization --------------------------------------------------
// A numeric epoch-ms ts stored unconverted becomes a SQLite INTEGER, which
// sorts below every TEXT started_at/stopped_at — windowed SQL never matches
// it and pruneExecutions deletes it on the very next tick.

test('a numeric epoch-ms ts is converted to ISO', () => {
  const [row] = parseEvent({
    eventName: 'n8n.workflow.success',
    ts: Date.parse('2026-08-11T02:00:05.000Z'),
    payload: { executionId: '1', workflowId: 'wf1' },
  });
  assert.equal(row.stoppedAt, '2026-08-11T02:00:05.000Z');
});

test('a valid ISO ts is kept as-is, not reformatted', () => {
  const iso = '2026-08-11T02:00:05.123+02:00';
  const [row] = parseEvent({
    eventName: 'n8n.workflow.success',
    ts: iso,
    payload: { executionId: '1', workflowId: 'wf1' },
  });
  assert.equal(row.stoppedAt, iso);
});

test('a garbage ts becomes null rather than a bad string', () => {
  const [row] = parseEvent({
    eventName: 'n8n.workflow.success',
    ts: 'not a timestamp',
    payload: { executionId: '1', workflowId: 'wf1' },
  });
  assert.equal(row.stoppedAt, null);
});

test('NaN and Infinity are not treated as epoch ms', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const [row] = parseEvent({
      eventName: 'n8n.workflow.success',
      ts: bad,
      payload: { executionId: '1', workflowId: 'wf1' },
    });
    assert.equal(row.stoppedAt, null);
  }
});

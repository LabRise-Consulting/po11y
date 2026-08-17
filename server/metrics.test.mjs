import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertExecutions, upsertWorkflows } from './db.mjs';
import { buildSnapshot, renderMetrics, escapeLabelValue, aiMapLlmUpFrom } from './metrics.mjs';

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

test('an ai-map build that got LLM prose renders po11y_ai_map_llm_up 1', () => {
  const text = renderMetrics(buildSnapshot(seeded(), {
    now: NOW, n8nUp: 1, pollLastSuccessMs: NOW, aiMapLlmUp: 1,
  }));
  assert.match(text, /^po11y_ai_map_llm_up 1$/m);
});

test('an ai-map build that fell back to the heuristic renders po11y_ai_map_llm_up 0', () => {
  const text = renderMetrics(buildSnapshot(seeded(), {
    now: NOW, n8nUp: 1, pollLastSuccessMs: NOW, aiMapLlmUp: 0,
  }));
  assert.match(text, /^po11y_ai_map_llm_up 0$/m);
});

// Absent, not 0. A deployment with OMNIROUTE_ENABLED=false and no AI_MAP_* has
// no LLM to be down, and exporting 0 there would leave any alert on this series
// firing forever on a stack that is working exactly as configured. Same reason
// po11y_poll_last_success_timestamp_seconds is omitted rather than zeroed.
test('no configured LLM omits po11y_ai_map_llm_up entirely rather than reporting it down', () => {
  const text = renderMetrics(buildSnapshot(seeded(), {
    now: NOW, n8nUp: 1, pollLastSuccessMs: NOW, aiMapLlmUp: null,
  }));
  assert.doesNotMatch(text, /^po11y_ai_map_llm_up /m);
  assert.doesNotMatch(text, /^# TYPE po11y_ai_map_llm_up /m,
    'the HELP/TYPE header must go with the sample, not linger without one');
});

test('po11y_ai_map_llm_up carries HELP and TYPE exactly once when it is exported', () => {
  const text = renderMetrics(buildSnapshot(seeded(), {
    now: NOW, n8nUp: 1, pollLastSuccessMs: NOW, aiMapLlmUp: 0,
  }));
  assert.equal((text.match(/^# HELP po11y_ai_map_llm_up /gm) || []).length, 1);
  assert.equal((text.match(/^# TYPE po11y_ai_map_llm_up gauge$/gm) || []).length, 1);
});

test('an unconfigured LLM has no up/down state to report', () => {
  assert.equal(aiMapLlmUpFrom({ aiConfigured: false, degraded: null }), null);
  assert.equal(aiMapLlmUpFrom({ aiConfigured: false, degraded: 'LLM POST -> 503' }), null,
    'a stale degraded reason must not resurrect the series after the LLM is switched off');
});

test('a configured LLM reports up when the build actually published from the LLM', () => {
  assert.equal(aiMapLlmUpFrom({ aiConfigured: true, action: 'publish', degraded: null }), 1);
});

test('a configured LLM reports down when the build recorded a degraded reason', () => {
  assert.equal(aiMapLlmUpFrom({
    aiConfigured: true, action: 'publish', degraded: 'LLM POST -> 503',
  }), 0);
});

// The false all-clear this metric exists to avoid. buildAiMap returns early on
// republish/keep-annotated/skip-fresh WITHOUT calling the LLM, so `degraded` is
// null on those rebuilds no matter how dead the gateway is. Reading that as "up"
// makes an exhausted provider look healthy for as long as the workflow set is
// unchanged — which, on a stable stack, is indefinitely.
for (const action of ['republish', 'keep-annotated', 'skip-fresh']) {
  test(`a '${action}' rebuild made no LLM call, so it keeps the previous reading`, () => {
    assert.equal(aiMapLlmUpFrom({ aiConfigured: true, action, degraded: null, previous: 0 }), 0,
      'a known-down LLM must not be cleared by a rebuild that never called it');
    assert.equal(aiMapLlmUpFrom({ aiConfigured: true, action, degraded: null, previous: 1 }), 1);
  });
}

test('a rebuild that made no LLM call and has no previous reading reports nothing', () => {
  assert.equal(aiMapLlmUpFrom({
    aiConfigured: true, action: 'republish', degraded: null, previous: null,
  }), null);
});

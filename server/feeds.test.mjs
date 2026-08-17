import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertWorkflows, upsertExecutions } from './db.mjs';
import { buildFeeds, nextAiMap } from './feeds.mjs';
import { buildAll, feedDocuments, fetchStatus } from './n8n.mjs';

const WF = {
  id: 'wf1',
  name: 'Ingest',
  active: true,
  nodes: [{ name: 'ft', type: 'n8n-nodes-base.formTrigger', parameters: { path: 'ingest-form', formTitle: 'Ingest' } }],
  connections: {},
};
const EXECS = [
  { id: '2', workflowId: 'wf1', workflowName: 'Ingest', status: 'error', startedAt: '2026-08-11T02:05:00.000Z', stoppedAt: '2026-08-11T02:05:01.000Z', createdAt: null, mode: 'trigger' },
  { id: '1', workflowId: 'wf1', workflowName: 'Ingest', status: 'success', startedAt: '2026-08-11T02:00:00.000Z', stoppedAt: '2026-08-11T02:00:01.000Z', createdAt: null, mode: 'trigger' },
];
const STAMP = '2026-08-11T03:00:00.000Z';
const NOW = Date.parse(STAMP);

const seed = () => {
  const db = openDb(':memory:');
  upsertWorkflows(db, [WF]);
  upsertExecutions(db, EXECS);
  return db;
};

test('map.json and forms.json match what the collector builds from the same input', async () => {
  const { feeds } = await buildFeeds(seed(), { stamp: STAMP, now: NOW });
  const built = await buildAll([WF], null, { now: NOW });
  const expected = feedDocuments(built, STAMP);
  assert.deepEqual(feeds['map.json'], expected['map.json']);
  assert.deepEqual(feeds['forms.json'], expected['forms.json']);
});

test('forms.json carries the form-trigger button the dashboard renders', async () => {
  const { feeds } = await buildFeeds(seed(), { stamp: STAMP, now: NOW });
  assert.deepEqual(feeds['forms.json'].forms.map((f) => f.path), ['ingest-form']);
});

// The point of this test is the ROUND TRIP: `expected` is computed from the raw
// rows, `feeds` from the same rows after a store write+read. Comparing the
// server against its own output would pass even if the store dropped a column.
test('status.json survives the store round-trip unchanged', async () => {
  const { feeds } = await buildFeeds(seed(), { stamp: STAMP, now: NOW });
  const names = new Map([['wf1', 'Ingest']]);
  const { status } = await fetchStatus(null, '', '', { executions: EXECS, names });
  assert.deepEqual(feeds['status.json'], { generated_at: STAMP, ...status });
  assert.equal(feeds['status.json'].executions.recent, 2);
  assert.equal(feeds['status.json'].executions.errors, 1);
  assert.equal(feeds['status.json'].executions.byWorkflow[0].name, 'Ingest');
});

test('an empty store still yields a timestamped status document', async () => {
  const { feeds } = await buildFeeds(openDb(':memory:'), { stamp: STAMP, now: NOW });
  assert.equal(feeds['status.json'].generated_at, STAMP);
  assert.deepEqual(feeds['forms.json'].forms, []);
});

test('the first build publishes a stamped ai-map', async () => {
  const { aiMap } = await buildFeeds(seed(), { stamp: STAMP, now: NOW });
  assert.ok(aiMap, 'expected a first-run ai-map');
  assert.equal(aiMap.generated_at, STAMP);
});

test('a build that skips republishing keeps the previous ai-map', async () => {
  const db = seed();
  const first = await buildFeeds(db, { stamp: STAMP, now: NOW });
  const second = await buildFeeds(db, {
    stamp: '2026-08-11T03:10:00.000Z',
    now: NOW + 600_000,
    prevAiMap: first.aiMap,
  });
  // Same structure inside the freshness window -> the builder publishes nothing.
  assert.equal(second.aiMap, null);
  assert.deepEqual(nextAiMap(first.aiMap, second.aiMap), first.aiMap);
});

test('nextAiMap prefers a fresh build, falls back to previous, then to null', () => {
  assert.deepEqual(nextAiMap({ a: 1 }, { b: 2 }), { b: 2 });
  assert.deepEqual(nextAiMap({ a: 1 }, null), { a: 1 });
  assert.equal(nextAiMap(null, null), null);
});

// po11y_ai_map_llm_up cannot tell "the LLM answered" from "no LLM call was made
// this rebuild" unless the action reaches the caller. Without it the metric
// reports a dead gateway as up on every republish.
test('buildFeeds reports the ai-map action, not only its degraded reason', async () => {
  const { aiAction } = await buildFeeds(seed(), { stamp: STAMP, now: NOW });
  assert.equal(typeof aiAction, 'string', 'the caller needs the action to read the LLM outcome');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incidentsTool, graphTool, executionsTool, failureTool, workflowTool, promqlTool, sqlTool,
  describeShape } from './ops.mjs';
import { buildAiMap } from '../../lib/build-ai-map.mjs';

const feedsWith = (files) => ({
  available: () => true,
  read: (n) => files[n],
  readSafe: (n) => files[n] ?? null,
  ageSeconds: () => 42,
});
const noFeeds = { available: () => false };

test('incidents: ranks failures above recoveries and reports feed age', async () => {
  const tool = incidentsTool({ feeds: feedsWith({ 'notifications.json': [
    { ts: '2026-08-01T10:00:00Z', title: 'recovered: HN notify', status: 'success' },
    { ts: '2026-08-01T09:00:00Z', title: 'failing: Maps', status: 'failure', message: '5 errors' },
  ] }) });
  const out = await tool.handler({});
  assert.equal(out.incidents[0].status, 'failure');
  assert.equal(out.open, 1);
  assert.equal(out.feed_age_seconds, 42);
});

test('incidents: an empty feed says so explicitly rather than returning []', async () => {
  const tool = incidentsTool({ feeds: feedsWith({ 'notifications.json': [] }) });
  const out = await tool.handler({});
  assert.equal(out.open, 0);
  assert.match(out.summary, /no open/i);
});

test('incidents: without the feed volume it reports unavailability, not silence', async () => {
  const out = await incidentsTool({ feeds: noFeeds }).handler({});
  assert.equal(out.error, 'unavailable');
  assert.match(out.reason, /STATUS_DIR/);
});

test('incidents: open counts the full backlog, not just the limit-capped page', async () => {
  const tool = incidentsTool({ feeds: feedsWith({ 'notifications.json': [
    { ts: '2026-08-01T08:00:00Z', title: 'failing: A', status: 'failure' },
    { ts: '2026-08-01T09:00:00Z', title: 'failing: B', status: 'failure' },
    { ts: '2026-08-01T10:00:00Z', title: 'failing: C', status: 'failure' },
  ] }) });
  const out = await tool.handler({ limit: 2 });
  assert.equal(out.open, 3);
  assert.equal(out.incidents.length, 2);
});

test('incidents: a feed that has never been written is distinguished from an empty one', async () => {
  const tool = incidentsTool({ feeds: feedsWith({}) });
  const out = await tool.handler({});
  assert.match(out.error, /has not been written/);
});

test('incidents: a missing feed names the reason, not just the missing file', async () => {
  // Mode A ships no core workflow that writes notifications.json, so this is
  // the NORMAL answer on a stock Mode A deploy — not a fault. Reporting a bare
  // "has not been written yet" sends an agent hunting for a broken watchdog
  // that was never supposed to be running.
  const out = await incidentsTool({ feeds: feedsWith({}) }).handler({});
  assert.equal(out.open, 0);
  assert.deepEqual(out.incidents, []);
  assert.match(out.reason, /Mode A/, 'says which deployments legitimately lack the feed');
  assert.match(out.reason, /watchdog|ALERTS_ENABLED/, 'and what writes it when they do');
});

test('incidents: a feed that parsed to an object answers, rather than throwing a bare -32603', async () => {
  // A hand-written Mode A Code node can publish {notifications: […]} where the
  // watchdog writes a bare array; the truthiness guard alone lets that reach
  // [...all] and throw.
  const tool = incidentsTool({ feeds: feedsWith({ 'notifications.json': { notifications: [] } }) });
  const out = await tool.handler({});
  assert.match(out.error, /not a feed array/);
  assert.equal(out.open, 0);
  assert.deepEqual(out.incidents, []);
});

// The ai-map fixture is PRODUCED, not hand-written. A hand-written one drifted
// from the real feed for as long as these tools have existed: buildAiMap emits
// edges as [from, to, kind] arrays, the fixture spelled them {from, to, kind},
// and so every graph slice silently returned an empty edge list in production
// while the suite stayed green. Feeding the real builder makes that class of
// drift impossible — if the feed shape changes, these tests change with it.
const AI_MAP = (await buildAiMap([
  {
    id: '1',
    name: 'HN tech news',
    nodes: [
      { name: 'Every 30 min', type: 'n8n-nodes-base.scheduleTrigger',
        parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } } },
      { name: 'Call notify', type: 'n8n-nodes-base.executeWorkflow',
        parameters: { workflowId: { value: '2' } } },
    ],
  },
  {
    id: '2',
    name: 'HN notify',
    nodes: [
      { name: 'When called', type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: {} },
      { name: 'Publish', type: 'n8n-nodes-base.code',
        parameters: { jsCode: "// writes notifications\nfs.writeFileSync('/po11y-status/notifications.json', x);" } },
    ],
  },
], { now: 0, aiConfigured: false, prev: null })).map;

test('graph: whole-instance summary counts nodes and edges', async () => {
  const out = await graphTool({ feeds: feedsWith({ 'ai-map.json': AI_MAP }) }).handler({});
  assert.equal(out.nodes, AI_MAP.nodes.length);
  assert.equal(out.edges, AI_MAP.edges.length);
  assert.ok(out.edges >= 3, 'the fixture really does have a trigger, a call and a feed edge');
});

test('graph: a slice around one node returns its neighbours at the requested depth', async () => {
  const tool = graphTool({ feeds: feedsWith({ 'ai-map.json': AI_MAP }) });
  const out = await tool.handler({ node: 'HN notify', depth: 1 });
  const ids = out.slice.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['f:notifications.json', 'wf:1', 'wf:2']);
});

test('graph: the slice carries the edges between the nodes it kept', async () => {
  // The whole point of the tool: an empty edge list makes the slice unreadable,
  // and that is exactly what it returned before the shape fix.
  const tool = graphTool({ feeds: feedsWith({ 'ai-map.json': AI_MAP }) });
  const out = await tool.handler({ node: 'HN notify', depth: 1 });
  assert.ok(out.slice.edges.length >= 2, 'wf:1->wf:2 and wf:2->f:notifications.json');
  const pairs = out.slice.edges.map(([from, to]) => `${from}->${to}`);
  assert.ok(pairs.includes('wf:1->wf:2'));
  assert.ok(pairs.includes('wf:2->f:notifications.json'));
});

test('graph: depth 2 reaches the trigger behind the calling workflow', async () => {
  const tool = graphTool({ feeds: feedsWith({ 'ai-map.json': AI_MAP }) });
  const out = await tool.handler({ node: 'HN notify', depth: 2 });
  const ids = out.slice.nodes.map((n) => n.id);
  assert.ok(ids.some((id) => id.startsWith('t:1:')), 'the schedule trigger is two hops away');
});

test('graph: an unknown node lists what it could have matched', async () => {
  const out = await graphTool({ feeds: feedsWith({ 'ai-map.json': AI_MAP }) })
    .handler({ node: 'nope' });
  assert.match(out.error, /not found/);
  assert.ok(out.known.length >= 1);
});

const EXEC = {
  id: 77, workflowId: '2', status: 'error', mode: 'trigger', finished: true,
  createdAt: '2026-08-01T09:00:00Z', startedAt: '2026-08-01T09:00:01Z',
  stoppedAt: '2026-08-01T09:00:09Z',
  workflowData: { name: 'HN notify' },
  data: {
    resultData: {
      lastNodeExecuted: 'HTTP Request',
      error: { message: 'connect ECONNREFUSED 10.0.0.5:443', name: 'NodeApiError', httpCode: '503',
               node: { name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest' } },
      runData: { 'HTTP Request': [{ data: { main: [[{ json: { apiKey: 'sk-LEAK', email: 'a@b.c' } }]] } }] },
    },
  },
};

const n8nWith = (byPath) => ({ available: () => true, baseUrl: 'http://n8n:5678',
  get: async (p) => byPath[p.split('?')[0]] ?? byPath[p] });
const off = { available: () => false };

test('describeShape reports structure, never content', () => {
  assert.equal(describeShape({ a: 1, b: 2 }), 'object, 2 keys');
  assert.equal(describeShape([1, 2, 3]), 'array, 3 items');
  assert.equal(describeShape('hello'), 'string, 5 chars');
  assert.equal(describeShape(null), 'null');
});

test('failure: returns the failing node and error text', async () => {
  const tool = failureTool({ n8n: n8nWith({ '/api/v1/executions/77': EXEC }), grafana: off });
  const out = await tool.handler({ executionId: 77 });
  assert.equal(out.failing_node, 'HTTP Request');
  assert.match(out.error.message, /ECONNREFUSED/);
  assert.equal(out.error.http_code, '503');
  assert.equal(out.duration_seconds, 8);
});

test('failure: NEVER leaks payload data — only shapes', async () => {
  const tool = failureTool({ n8n: n8nWith({ '/api/v1/executions/77': EXEC }), grafana: off });
  const text = JSON.stringify(await tool.handler({ executionId: 77 }));
  assert.ok(!text.includes('sk-LEAK'), 'api key from run data leaked');
  assert.ok(!text.includes('a@b.c'), 'email from run data leaked');
  assert.match(text, /object, 2 keys/);
});

test('failure: includes a deep link so the operator can read the real payload', async () => {
  const tool = failureTool({ n8n: n8nWith({ '/api/v1/executions/77': EXEC }), grafana: off });
  const out = await tool.handler({ executionId: 77 });
  assert.match(out.link, /\/executions\/77$/);
});

test('failure: without n8n or grafana it names both variables', async () => {
  const out = await failureTool({ n8n: off, grafana: off }).handler({ executionId: 1 });
  assert.equal(out.error, 'unavailable');
  assert.match(out.reason, /N8N_API_URL/);
});

test('failure: caps an oversized error message rather than returning it whole', async () => {
  const bigMessage = `connect ECONNREFUSED ${'x'.repeat(5000)}`;
  const bigExec = { ...EXEC, data: { resultData: {
    ...EXEC.data.resultData,
    error: { ...EXEC.data.resultData.error, message: bigMessage },
  } } };
  const tool = failureTool({ n8n: n8nWith({ '/api/v1/executions/77': bigExec }), grafana: off });
  const out = await tool.handler({ executionId: 77 });
  assert.ok(out.error.message.length < bigMessage.length);
  assert.match(out.error.message, /truncated/);
});

test('executions: maps the n8n list to a compact table', async () => {
  const tool = executionsTool({ n8n: n8nWith({ '/api/v1/executions': { data: [EXEC] } }) });
  const out = await tool.handler({ limit: 10 });
  assert.equal(out.executions.length, 1);
  assert.deepEqual(Object.keys(out.executions[0]).sort(),
    ['duration_seconds', 'id', 'started_at', 'status', 'workflow', 'workflow_id']);
});

test('executions: carries no payload keys at all', async () => {
  const tool = executionsTool({ n8n: n8nWith({ '/api/v1/executions': { data: [EXEC] } }) });
  const text = JSON.stringify(await tool.handler({}));
  assert.ok(!text.includes('sk-LEAK'));
  assert.ok(!text.includes('runData'));
});

// /api/v1/executions without includeData=true does not reliably carry
// workflowData — this is what a real list response looks like: workflowName
// (if the instance sends it) or just workflowId, no nested workflowData.
const LIST_EXEC = {
  id: 88, workflowId: '3', workflowName: 'Maps sync', status: 'success', mode: 'trigger', finished: true,
  createdAt: '2026-08-01T09:00:00Z', startedAt: '2026-08-01T09:00:01Z', stoppedAt: '2026-08-01T09:00:03Z',
};

test('executions: names the workflow from a list-shaped row (no workflowData)', async () => {
  const tool = executionsTool({ n8n: n8nWith({ '/api/v1/executions': { data: [LIST_EXEC] } }) });
  const out = await tool.handler({});
  assert.equal(out.executions[0].workflow, 'Maps sync');
});

test('executions: falls back to workflowId when even workflowName is absent', async () => {
  const bare = { ...LIST_EXEC, workflowName: undefined };
  const tool = executionsTool({ n8n: n8nWith({ '/api/v1/executions': { data: [bare] } }) });
  const out = await tool.handler({});
  assert.equal(out.executions[0].workflow, '3');
});

test('executions: sanitises a non-numeric limit rather than sending "NaN"', async () => {
  let requested = null;
  const n8n = { available: () => true, baseUrl: 'http://n8n:5678',
    get: async (p) => { requested = p; return { data: [] }; } };
  await executionsTool({ n8n }).handler({ limit: 'not-a-number' });
  assert.ok(!requested.includes('NaN'));
  assert.match(requested, /limit=20/);
});

test('workflow: joins the graph slice with recent runs', async () => {
  const feeds = feedsWith({ 'ai-map.json': AI_MAP });
  const n8n = n8nWith({
    '/api/v1/workflows': { data: [{ id: '2', name: 'HN notify', active: true, nodes: [] }] },
    '/api/v1/executions': { data: [EXEC] },
  });
  const out = await workflowTool({ feeds, n8n, grafana: off }).handler({ workflow: 'HN notify' });
  assert.equal(out.workflow.name, 'HN notify');
  assert.equal(out.workflow.active, true);
  assert.equal(out.recent.total, 1);
  assert.equal(out.recent.errors, 1);
  assert.ok(out.neighbours.nodes.length >= 1);
});

test('workflow: without the feed volume, neighbours reports unavailability, not silence', async () => {
  const n8n = n8nWith({
    '/api/v1/workflows': { data: [{ id: '2', name: 'HN notify', active: true, nodes: [] }] },
    '/api/v1/executions': { data: [] },
  });
  const out = await workflowTool({ feeds: noFeeds, n8n, grafana: off }).handler({ workflow: 'HN notify' });
  assert.equal(out.neighbours.error, 'unavailable');
  assert.match(out.neighbours.reason, /STATUS_DIR/);
});

test('workflow: when ai-map.json has not been written yet, neighbours says so explicitly', async () => {
  const feeds = feedsWith({}); // volume present, file never written
  const n8n = n8nWith({
    '/api/v1/workflows': { data: [{ id: '2', name: 'HN notify', active: true, nodes: [] }] },
    '/api/v1/executions': { data: [] },
  });
  const out = await workflowTool({ feeds, n8n, grafana: off }).handler({ workflow: 'HN notify' });
  assert.match(out.neighbours.error, /ai-map\.json has not been written yet/);
});

test('promql: passes the query through and reports unavailability otherwise', async () => {
  const prom = { available: () => true, query: async (q) => ({ result: [{ metric: { __name__: q } }] }) };
  const out = await promqlTool({ prometheus: prom }).handler({ query: 'up' });
  assert.equal(out.data.result[0].metric.__name__, 'up');
  const off2 = await promqlTool({ prometheus: { available: () => false } }).handler({ query: 'up' });
  assert.match(off2.reason, /PROMETHEUS_URL/);
});

test('sql: rejects a write before touching the network', async () => {
  let called = false;
  const grafana = { available: () => true, query: async () => { called = true; return {}; } };
  const out = await sqlTool({ grafana }).handler({ sql: 'DELETE FROM execution_entity' });
  assert.match(out.error, /SELECT/);
  assert.equal(called, false);
});

test('sql: in Mode B it says the datasource is absent', async () => {
  const out = await sqlTool({ grafana: { available: () => false } }).handler({ sql: 'SELECT 1' });
  assert.match(out.reason, /GRAFANA_URL/);
});

test('sql: success path returns columns, rows and the adapter\'s truncation flag', async () => {
  const grafana = { available: () => true, query: async () => ({
    columns: ['id', 'status'], rows: [[1, 'error'], [2, 'success']], truncated: false,
  }) };
  const out = await sqlTool({ grafana }).handler({ sql: 'SELECT id, status FROM execution_entity' });
  assert.deepEqual(out.columns, ['id', 'status']);
  assert.equal(out.row_count, 2);
  assert.deepEqual(out.rows, [[1, 'error'], [2, 'success']]);
  assert.equal(out.truncated, false);
});

test('sql: a result over the row cap is trimmed and reported as truncated', async () => {
  const rows = [[1], [2], [3]];
  const grafana = { available: () => true, query: async () => ({ columns: ['id'], rows, truncated: false }) };
  const out = await sqlTool({ grafana }).handler({ sql: 'SELECT id FROM execution_entity', limit: 2 });
  assert.equal(out.row_count, 2);
  assert.equal(out.rows.length, 2);
  assert.equal(out.truncated, true);
});

test('sql: the adapter\'s own truncation flag survives even under the cap', async () => {
  const grafana = { available: () => true, query: async () => ({ columns: ['id'], rows: [[1]], truncated: true }) };
  const out = await sqlTool({ grafana }).handler({ sql: 'SELECT id FROM execution_entity' });
  assert.equal(out.truncated, true);
});

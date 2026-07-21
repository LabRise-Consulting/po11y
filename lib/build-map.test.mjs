import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMap } from './build-map.mjs';

const core = JSON.parse(
  readFileSync(new URL('./__fixtures__/core-workflows.json', import.meta.url), 'utf8'),
);

test('output starts with graph TD', () => {
  const { mermaid } = buildMap(core);
  assert.ok(mermaid.startsWith('graph TD\n'));
});

test('a node line per workflow with esc() labels', () => {
  const { mermaid, workflows } = buildMap(core);
  assert.equal(workflows, 2);
  assert.ok(mermaid.includes('  wf_po11ystatuspub00["Po11y - Status publish"]'));
  assert.ok(mermaid.includes('  wf_po11yworkflowmap["Po11y - Maps"]'));
});

test('schedule triggers render every 2 min / every 10 min', () => {
  const { mermaid } = buildMap(core);
  assert.ok(mermaid.includes('(("every 2 min"))'));
  assert.ok(mermaid.includes('(("every 10 min"))'));
});

test('form triggers render form /status-refresh and form /maps-build-now', () => {
  const { mermaid } = buildMap(core);
  assert.ok(mermaid.includes('(("form /status-refresh"))'));
  assert.ok(mermaid.includes('(("form /maps-build-now"))'));
});

test('active workflows get a class active line', () => {
  const { mermaid } = buildMap(core);
  assert.ok(mermaid.includes('  class wf_po11ystatuspub00 active'));
  assert.ok(mermaid.includes('  class wf_po11yworkflowmap active'));
});

test('classDef lines are last', () => {
  const { mermaid } = buildMap(core);
  const lines = mermaid.split('\n');
  assert.equal(lines[lines.length - 2], '  classDef active stroke-width:3px');
  assert.equal(lines[lines.length - 1], '  classDef trigger stroke-dasharray:3 3,font-size:11px');
});

test('edge count matches returned edges', () => {
  const { mermaid, edges } = buildMap(core);
  // one trigger edge per trigger node in the core fixture (2 schedule + 2 form)
  assert.equal(edges, 4);
  const edgeLines = mermaid.split('\n').filter((l) => l.includes('-->') || l.includes('-.->'));
  assert.equal(edgeLines.length, edges);
});

test('archived workflows are excluded (second fixture, inline)', () => {
  const withArchived = [
    ...core,
    {
      id: 'archivedwf',
      name: 'Archived one',
      active: true,
      isArchived: true,
      nodes: [
        {
          name: 'sched',
          type: 'n8n-nodes-base.scheduleTrigger',
          parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
        },
      ],
    },
  ];
  const { mermaid, workflows } = buildMap(withArchived);
  assert.equal(workflows, 2);
  assert.ok(!mermaid.includes('wf_archivedwf'));
  assert.ok(!mermaid.includes('every 5 min'));
});

test('quotes and backticks in a name are replaced by single quotes', () => {
  const wfs = [
    { id: 'qwf', name: 'has "quotes" and `ticks`', active: true, isArchived: false, nodes: [] },
  ];
  const { mermaid } = buildMap(wfs);
  assert.ok(mermaid.includes(`  wf_qwf["has 'quotes' and 'ticks'"]`));
});

test('inactive workflow gets (inactive) suffix and no active class', () => {
  const wfs = [{ id: 'iwf', name: 'Idle', active: false, isArchived: false, nodes: [] }];
  const { mermaid } = buildMap(wfs);
  assert.ok(mermaid.includes('  wf_iwf["Idle (inactive)"]'));
  assert.ok(!mermaid.includes('  class wf_iwf active'));
});

test('executeWorkflow reference (object and string form) produces sub-workflow edges', () => {
  const wfs = [
    {
      id: 'caller',
      name: 'Caller',
      active: true,
      isArchived: false,
      nodes: [
        {
          name: 'call-obj',
          type: 'n8n-nodes-base.executeWorkflow',
          parameters: { workflowId: { value: 'targetObj' } },
        },
        {
          name: 'call-str',
          type: 'n8n-nodes-base.executeWorkflow',
          parameters: { workflowId: 'targetStr' },
        },
      ],
    },
  ];
  const { mermaid } = buildMap(wfs);
  assert.ok(mermaid.includes('  wf_caller -->|sub-workflow| wf_targetObj'));
  assert.ok(mermaid.includes('  wf_caller -->|sub-workflow| wf_targetStr'));
});

test('httpRequest whose url contains another workflow form path produces a dotted http edge', () => {
  const wfs = [
    {
      id: 'provider',
      name: 'Provider',
      active: true,
      isArchived: false,
      nodes: [
        { name: 'ft', type: 'n8n-nodes-base.formTrigger', parameters: { path: 'shared-form' } },
      ],
    },
    {
      id: 'consumer',
      name: 'Consumer',
      active: true,
      isArchived: false,
      nodes: [
        {
          name: 'http',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'http://n8n/form/shared-form' },
        },
      ],
    },
  ];
  const { mermaid } = buildMap(wfs);
  assert.ok(mermaid.includes('  wf_consumer -.->|http| wf_provider'));
});

test('entries: one per non-archived workflow with nid/id/name/sub', () => {
  const { entries } = buildMap(core);
  assert.equal(entries.length, 2);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.deepEqual(byId['po11ystatuspub00'], {
    nid: 'wf_po11ystatuspub00', id: 'po11ystatuspub00', name: 'Po11y - Status publish',
    sub: 'Publish live state for the dashboard. fs is an allowed builtin',
  });
  assert.deepEqual(byId['po11yworkflowmap'], {
    nid: 'wf_po11yworkflowmap', id: 'po11yworkflowmap', name: 'Po11y - Maps',
    sub: 'Build a mermaid graph of every workflow on this instance and how they',
  });
});

test('entries: fallback sub is "<n> nodes" when no // comment', () => {
  const wfs = [{ id: 'plain', name: 'Plain', active: true, isArchived: false,
    nodes: [{ name: 'noop', type: 'n8n-nodes-base.set', parameters: {} }] }];
  const { entries } = buildMap(wfs);
  assert.deepEqual(entries, [{ nid: 'wf_plain', id: 'plain', name: 'Plain', sub: '1 nodes' }]);
});

test('entries: archived workflows excluded', () => {
  const withArchived = [...core,
    { id: 'archivedwf', name: 'Archived one', active: true, isArchived: true, nodes: [] }];
  const { entries } = buildMap(withArchived);
  assert.equal(entries.length, 2);
  assert.ok(!entries.some((e) => e.id === 'archivedwf'));
});

test('entries: sub longer than 90 chars is cut with an ellipsis', () => {
  const long = 'x'.repeat(120);
  const wfs = [{ id: 'longwf', name: 'Long', active: true, isArchived: false,
    nodes: [{ name: 'code', type: 'n8n-nodes-base.code', parameters: { jsCode: `// ${long}\nreturn [];` } }] }];
  const { entries } = buildMap(wfs);
  assert.equal(entries[0].sub, 'x'.repeat(90) + '…');
  assert.equal(entries[0].sub.length, 91);
});

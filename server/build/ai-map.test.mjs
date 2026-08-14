import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAiMap } from './ai-map.mjs';

const core = JSON.parse(
  readFileSync(new URL('./__fixtures__/core-workflows.json', import.meta.url), 'utf8'),
);

const clone = (o) => JSON.parse(JSON.stringify(o));
const HOUR = 3600 * 1000;

// An llm that answers every node id in the given list with a deterministic sub,
// plus a lede/notes for the full-annotation path. Counts its own calls.
function fakeLlm(ids) {
  const fn = async (prompt) => {
    fn.calls++;
    fn.lastPrompt = prompt;
    return JSON.stringify({
      lede: 'llm lede',
      subs: Object.fromEntries(ids.map((id) => [id, 'llm:' + id])),
      notes: [{ title: 'N', text: 'insight text' }],
    });
  };
  fn.calls = 0;
  fn.lastPrompt = null;
  return fn;
}

// Structural-only run (no llm) to enumerate node ids + sigs for a workflow set.
async function structure(wfs) {
  const r = await buildAiMap(wfs, { now: 0, aiConfigured: false, prev: null });
  return r.map;
}

test('1. structure determinism + heuristic model', async () => {
  const a = await buildAiMap(core, { now: 0, aiConfigured: false, prev: null });
  const b = await buildAiMap(core, { now: 0, aiConfigured: false, prev: null });
  assert.equal(a.action, 'publish');
  assert.deepEqual(a.map.nodes, b.map.nodes);
  assert.deepEqual(a.map.edges, b.map.edges);
  assert.deepEqual(a.map.sigs, b.map.sigs);
  assert.ok(Array.isArray(a.map.columns) && a.map.columns.length === 4);
  assert.ok(a.map.kinds && typeof a.map.kinds === 'object');
  assert.ok(Array.isArray(a.map.legend) && a.map.legend.length > 0);
  assert.equal(a.map.model, 'heuristic');
  // no generated_at — caller stamps it
  assert.equal('generated_at' in a.map, false);
});

test('2. unchanged workflows ⇒ zero new LLM calls (flagship)', async () => {
  const ids = (await structure(core)).nodes.map((n) => n.id);
  const llm = fakeLlm(ids);
  const first = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'test-model', llm, prev: null });
  assert.equal(first.action, 'publish');
  assert.equal(llm.calls, 1);

  const prev = clone(first.map);
  prev.generated_at = new Date(0).toISOString();
  const second = await buildAiMap(core, {
    now: 21 * HOUR, aiConfigured: true, model: 'test-model', llm, prev,
  });
  assert.equal(second.action, 'republish');
  assert.equal(llm.calls, 1); // stayed — no new call
});

test('3. skip-fresh: fresh prev + same structure ⇒ no llm', async () => {
  const struct = await structure(core);
  const prev = clone(struct);
  prev.model = 'test-model';
  prev.generated_at = new Date().toISOString(); // relative to now below
  const now = 100 * HOUR;
  prev.generated_at = new Date(now - 1 * HOUR).toISOString(); // 1h old
  const llm = fakeLlm(struct.nodes.map((n) => n.id));
  const r = await buildAiMap(core, { now, aiConfigured: true, model: 'test-model', llm, prev });
  assert.equal(r.action, 'skip-fresh');
  assert.deepEqual(r.summary, { skipped: 'fresh' });
  assert.equal(llm.calls, 0);
});

test('4. differential: one changed workflow ⇒ partial prompt with only changed ids', async () => {
  const allIds = (await structure(core)).nodes.map((n) => n.id);
  const full = fakeLlm(allIds);
  const first = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm: full, prev: null });
  const prev = clone(first.map);
  prev.generated_at = new Date(0).toISOString();

  // Mutate ONE workflow: change a node's jsCode leading comment (po11yworkflowmap).
  const mutated = clone(core);
  const wf2 = mutated.find((w) => w.id === 'po11yworkflowmap');
  const codeNode = wf2.nodes.find((n) => n.name === 'Build + publish map.json');
  codeNode.parameters.jsCode = '// MUTATED leading comment\n' + codeNode.parameters.jsCode;

  // Which ids actually change (sig diff)?
  const mutStruct = await structure(mutated);
  const changedIds = mutStruct.nodes
    .filter((n) => prev.sigs[n.id] !== mutStruct.sigs[n.id])
    .map((n) => n.id);
  assert.ok(changedIds.length > 0 && changedIds.length < allIds.length);
  // sanity: only po11yworkflowmap nodes changed; the other workflow + files unchanged
  assert.ok(changedIds.every((id) => id.includes('po11yworkflowmap')));
  const unchangedId = 'wf:po11ystatuspub00';
  assert.ok(!changedIds.includes(unchangedId));

  const diff = fakeLlm(changedIds);
  const now = 21 * HOUR;
  const r = await buildAiMap(mutated, { now, aiConfigured: true, model: 'm', llm: diff, prev });
  assert.equal(r.action, 'publish');
  assert.equal(diff.calls, 1);
  // partial prompt variant
  assert.ok(diff.lastPrompt.includes('Only the listed node ids changed'));
  // cover-list is EXACTLY the changed ids
  assert.ok(diff.lastPrompt.includes(JSON.stringify(changedIds)));

  const byId = Object.fromEntries(r.map.nodes.map((n) => [n.id, n.sub]));
  // changed node gets llm sub
  for (const id of changedIds) assert.equal(byId[id], 'llm:' + id);
  // unchanged node keeps prev.sub
  const prevSub = Object.fromEntries(prev.nodes.map((n) => [n.id, n.sub]));
  assert.equal(byId[unchangedId], prevSub[unchangedId]);
});

test('5. forced=true with prev annotated ⇒ full re-annotation', async () => {
  const allIds = (await structure(core)).nodes.map((n) => n.id);
  const full = fakeLlm(allIds);
  const first = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm: full, prev: null });
  const prev = clone(first.map);
  prev.generated_at = new Date(0).toISOString();

  const llm = fakeLlm(allIds);
  const r = await buildAiMap(core, {
    now: 1 * HOUR, aiConfigured: true, model: 'm', llm, prev, forced: true,
  });
  assert.equal(r.action, 'publish');
  assert.equal(llm.calls, 1);
  // full (non-partial) prompt covering every node
  assert.ok(llm.lastPrompt.includes('The structure is already decided'));
  assert.ok(!llm.lastPrompt.includes('Only the listed node ids changed'));
  for (const id of allIds) assert.ok(llm.lastPrompt.includes(id));
});

test('6. malformed llm reply ⇒ heuristic fallback + warning, no throw', async () => {
  let calls = 0;
  const llm = async () => { calls++; return 'this is not json at all'; };
  const r = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm, prev: null });
  assert.equal(calls, 1);
  assert.equal(r.action, 'publish');
  assert.equal(r.map.model, 'heuristic');
  assert.equal(r.summary.warnings.length, 1);
  assert.ok(r.summary.warnings[0].includes('annotation unusable'));
});

test('7. keep-annotated: !aiConfigured + annotated prev + same structure', async () => {
  const struct = await structure(core);
  const prev = clone(struct);
  prev.model = 'test-model'; // annotated
  const now = 100 * HOUR;
  prev.generated_at = new Date(now - 50 * HOUR).toISOString(); // stale (not fresh)
  const r = await buildAiMap(core, { now, aiConfigured: false, model: '', prev });
  assert.equal(r.action, 'keep-annotated');
  assert.deepEqual(r.summary, { skipped: 'structure unchanged; keeping annotated map' });
});

test('8. fence-wrapped ```json reply parses fine', async () => {
  const ids = (await structure(core)).nodes.map((n) => n.id);
  const body = JSON.stringify({ lede: 'fenced lede', subs: Object.fromEntries(ids.map((id) => [id, 'x:' + id])), notes: [] });
  const llm = async () => '```json\n' + body + '\n```';
  const r = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'gpt-x', llm, prev: null });
  assert.equal(r.action, 'publish');
  assert.equal(r.map.model, 'gpt-x'); // annotation succeeded (no fallback)
  assert.equal(r.map.lede, 'fenced lede');
  assert.equal((r.summary.warnings || []).length, 0);
  const first = r.map.nodes[0];
  assert.equal(first.sub, 'x:' + first.id);
});

test('9. llm summaries land on wf: nodes only', async () => {
  const ids = (await structure(core)).nodes.map((n) => n.id);
  const llm = async () => JSON.stringify({
    lede: 'l',
    subs: Object.fromEntries(ids.map((id) => [id, 's:' + id])),
    // llm answers for EVERY id — only wf: nodes may take a summary
    summaries: Object.fromEntries(ids.map((id) => [id, 'sum:' + id])),
    notes: [],
  });
  const r = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm, prev: null });
  assert.equal(r.action, 'publish');
  let wfCount = 0;
  for (const n of r.map.nodes) {
    if (n.id.startsWith('wf:')) { wfCount++; assert.equal(n.summary, 'sum:' + n.id); }
    else assert.equal('summary' in n, false);
  }
  assert.ok(wfCount > 0);
});

test('10. heuristic path writes no summary', async () => {
  const r = await buildAiMap(core, { now: 0, aiConfigured: false, prev: null });
  for (const n of r.map.nodes) assert.equal('summary' in n, false);
});

test('11. differential preserves prev summary on unchanged wf nodes', async () => {
  const allIds = (await structure(core)).nodes.map((n) => n.id);
  const full = async () => JSON.stringify({
    lede: 'l',
    subs: Object.fromEntries(allIds.map((id) => [id, 's:' + id])),
    summaries: Object.fromEntries(
      allIds.filter((id) => id.startsWith('wf:')).map((id) => [id, 'first:' + id])),
    notes: [],
  });
  const first = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm: full, prev: null });
  const prev = clone(first.map);
  prev.generated_at = new Date(0).toISOString();

  // Mutate ONE workflow so only its nodes re-annotate (same recipe as test 4).
  const mutated = clone(core);
  const wf2 = mutated.find((w) => w.id === 'po11yworkflowmap');
  const codeNode = wf2.nodes.find((n) => n.name === 'Build + publish map.json');
  codeNode.parameters.jsCode = '// MUTATED leading comment\n' + codeNode.parameters.jsCode;

  const diff = async () => JSON.stringify({
    subs: { 'wf:po11yworkflowmap': 'changed sub' },
    summaries: { 'wf:po11yworkflowmap': 'second:wf:po11yworkflowmap' },
  });
  const r = await buildAiMap(mutated, { now: 21 * HOUR, aiConfigured: true, model: 'm', llm: diff, prev });
  assert.equal(r.action, 'publish');
  const byId = Object.fromEntries(r.map.nodes.map((n) => [n.id, n.summary]));
  assert.equal(byId['wf:po11yworkflowmap'], 'second:wf:po11yworkflowmap'); // re-annotated
  assert.equal(byId['wf:po11ystatuspub00'], 'first:wf:po11ystatuspub00');  // preserved
});

test('12. malformed reply preserves previously published summaries', async () => {
  const allIds = (await structure(core)).nodes.map((n) => n.id);
  const full = async () => JSON.stringify({
    lede: 'l',
    subs: Object.fromEntries(allIds.map((id) => [id, 's:' + id])),
    summaries: Object.fromEntries(
      allIds.filter((id) => id.startsWith('wf:')).map((id) => [id, 'kept:' + id])),
    notes: [],
  });
  const first = await buildAiMap(core, { now: 0, aiConfigured: true, model: 'm', llm: full, prev: null });
  const prev = clone(first.map);
  prev.generated_at = new Date(0).toISOString();

  // Mutate one workflow so its nodes land in target, then feed a broken reply.
  const mutated = clone(core);
  const wf2 = mutated.find((w) => w.id === 'po11yworkflowmap');
  const codeNode = wf2.nodes.find((n) => n.name === 'Build + publish map.json');
  codeNode.parameters.jsCode = '// MUTATED again\n' + codeNode.parameters.jsCode;

  const broken = async () => 'not json';
  const r = await buildAiMap(mutated, { now: 21 * HOUR, aiConfigured: true, model: 'm', llm: broken, prev });
  assert.equal(r.action, 'publish');
  assert.equal(r.summary.warnings.length, 1);
  const byId = Object.fromEntries(r.map.nodes.map((n) => [n.id, n.summary]));
  assert.equal(byId['wf:po11yworkflowmap'], 'kept:wf:po11yworkflowmap'); // restored, not dropped
  assert.equal(byId['wf:po11ystatuspub00'], 'kept:wf:po11ystatuspub00'); // untouched preservation path
});

test('13. a node without a type does not abort the build', async () => {
  // n8n exports have always carried node.type, but a hand-edited or
  // partially-migrated workflow can omit it. A throw here escapes all the way
  // out of the collector's poll and takes map.json/forms.json/status.json down
  // with it, so the digest must tolerate the missing field.
  const wfs = [{ id: 'w1', name: 'Half-written', nodes: [{ name: 'orphan', parameters: {} }] }];
  const r = await buildAiMap(wfs, { now: 0, aiConfigured: false, prev: null });
  assert.equal(r.action, 'publish');
  assert.equal(r.map.nodes.length, 1, 'the workflow itself still renders');
  assert.equal(r.map.nodes[0].id, 'wf:w1');
});

test('15. weeks and months schedules show their interval, not a bare "schedule"', async () => {
  // The interval count was read from a fixed list of four fields, so n8n's
  // weeks and months schedules matched none of them and every one of them
  // rendered as an unlabelled "schedule" — the map said a workflow was on a
  // timer without saying which. map.mjs has the identical table and must
  // stay byte-identical to it (both are inlined into Code nodes).
  const every = async (field, extra) => {
    const wfs = [{
      id: 'w1', name: 'Scheduled', nodes: [{
        name: 'Tick', type: 'n8n-nodes-base.scheduleTrigger',
        parameters: { rule: { interval: [{ field, ...extra }] } },
      }],
    }];
    const r = await buildAiMap(wfs, { now: 0, aiConfigured: false, prev: null });
    return r.map.nodes.find((n) => n.id.startsWith('t:')).tag;
  };
  assert.equal(await every('weeks', { weeksInterval: 2 }), 'every 2 w');
  assert.equal(await every('months', { monthsInterval: 3 }), 'every 3 mo');
  assert.equal(await every('hours', { hoursInterval: 6 }), 'every 6 h');
  assert.equal(await every('minutes', {}), 'schedule', 'no interval at all is still bare');
});

test('14. a workflow without a name still sorts (no localeCompare on undefined)', async () => {
  const wfs = [
    { id: 'w1', nodes: [{ name: 'a', type: 'n8n-nodes-base.noOp', parameters: {} }] },
    { id: 'w2', nodes: [{ name: 'b', type: 'n8n-nodes-base.noOp', parameters: {} }] },
  ];
  const r = await buildAiMap(wfs, { now: 0, aiConfigured: false, prev: null });
  assert.equal(r.action, 'publish');
  assert.equal(r.map.nodes.length, 2);
});

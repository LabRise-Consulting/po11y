// config.json names a Grafana dashboard by uid and then lists panel ids out of
// it. Nothing checked that the pair agreed, and a panel id that does not exist
// renders as an empty box with no error anywhere — the failure mode looks
// exactly like "no data yet".
//
// The read-only topology adds a second way to embed an empty box: it connects
// to no postgres, so a panel backed by the n8n-postgres datasource is inert
// there by construction, however correct its id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { FINISHED_STATUSES } from '../../server/exec-status.mjs';

const JSON_DIR = new URL('./provisioning/dashboards/json/', import.meta.url);
const REPO = new URL('../../', import.meta.url);

const load = (url) => JSON.parse(readFileSync(url, 'utf8'));

const dashboards = readdirSync(JSON_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...load(new URL(f, JSON_DIR)) }));

const byUid = new Map(dashboards.map((d) => [d.uid, d]));

const bundled = load(new URL('config.example.json', REPO));
const readonly = load(new URL('config.readonly.example.json', REPO));

/** Grafana nests panels one level inside a row; flatten so ids are findable. */
const allPanels = (d) => (d.panels || []).flatMap((p) => [p, ...(p.panels || [])]);

/** The panels a config's metrics section actually embeds, resolved for real. */
function embedded(cfg) {
  const g = cfg.metrics?.grafana;
  assert.ok(g?.dashboard, 'config declares no metrics dashboard');
  const dash = byUid.get(g.dashboard);
  assert.ok(dash, `config embeds unknown dashboard uid "${g.dashboard}"`);
  const panels = allPanels(dash);
  return (g.panels || []).map((want) => {
    const found = panels.find((p) => p.id === want.id);
    assert.ok(found, `${dash.file}: no panel id ${want.id} ("${want.title}")`);
    return found;
  });
}

const datasourcesOf = (panel) => [
  panel.datasource,
  ...(panel.targets || []).map((t) => t.datasource),
].filter(Boolean).map((d) => (typeof d === 'string' ? d : d.uid));

const exprsOf = (panel) => (panel.targets || [])
  .map((t) => t.expr || t.rawSql || '')
  .filter(Boolean);

test('every shipped dashboard has a unique uid and a title', () => {
  const seen = new Set();
  for (const d of dashboards) {
    assert.ok(d.uid, `${d.file}: no uid`);
    assert.ok(d.title, `${d.file}: no title`);
    assert.ok(!seen.has(d.uid), `${d.file}: uid "${d.uid}" is already taken`);
    seen.add(d.uid);
  }
});

test('every panel the bundled config embeds exists in the dashboard it names', () => {
  assert.ok(embedded(bundled).length > 0);
});

test('every panel the read-only config embeds exists in the dashboard it names', () => {
  assert.ok(embedded(readonly).length > 0);
});

// The read-only stack has an inert n8n-postgres datasource — provisioned so
// interpolation has something to resolve, wired to nothing. A panel behind it
// cannot ever draw, so embedding one is the same as embedding nothing.
test('the read-only config embeds no postgres-backed panel', () => {
  for (const panel of embedded(readonly)) {
    for (const uid of datasourcesOf(panel)) {
      assert.notEqual(uid, 'n8n-postgres',
        `panel ${panel.id} ("${panel.title}") needs a postgres the read-only stack does not have`);
    }
  }
});

// The regression this file exists for: read-only shipped no failure reporting
// in its metrics row at all, because the only dashboard that had it queried
// postgres. po11y's own exporter carries the numbers over Prometheus.
test('the read-only metrics row reports workflow failures', () => {
  const exprs = embedded(readonly).flatMap(exprsOf);
  assert.ok(exprs.some((e) => e.includes('po11y_workflow_errors_total')),
    'no embedded panel reports failed executions');
});

// A failure count with no denominator cannot be read: "4 failures" is an
// outage at 5 runs and noise at 4000. The executions counter exists to give
// the row that scale, so the row has to actually use it.
test('the read-only metrics row reports a success rate, not just a failure count', () => {
  const exprs = embedded(readonly).flatMap(exprsOf);
  assert.ok(exprs.some((e) => e.includes('po11y_workflow_executions_total')),
    'no embedded panel carries the denominator, so the failure count has no scale');
});

// A percentage of executions needs a denominator of runs that could have
// succeeded. Dividing by COUNT(*) counts `running`, `waiting` and `canceled`
// against the workflow, so the rate reads low whenever anything is in flight —
// and the same dashboard's "Daily success rate trend" already did it the other
// way, so its two success rates disagreed on the same screen.
//
// The expected list comes from server/exec-status.mjs rather than a literal
// here, so the SQL and the server's own counters cannot drift apart.
test('every execution percentage in the bundled dashboard divides by finished runs only', () => {
  const finishedSql = `IN (${FINISHED_STATUSES.map((s) => `'${s}'`).join(', ')})`;
  const dash = byUid.get('adfcxfk');
  assert.ok(dash, 'the bundled execution-analytics dashboard is missing');

  const offenders = [];
  for (const panel of allPanels(dash)) {
    for (const sql of exprsOf(panel)) {
      if (!sql.includes('100.0 *')) continue;
      if (!sql.includes(finishedSql)) offenders.push(`${panel.id} "${panel.title}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `these panels compute a percentage over every status, not just ${finishedSql}`);
});

test('every panel of the po11y dashboard reads Prometheus, not postgres', () => {
  const dash = [...byUid.values()].find((d) => d.file.startsWith('po11y-'));
  assert.ok(dash, 'no po11y-*.json dashboard is shipped');
  for (const panel of allPanels(dash).filter((p) => p.type !== 'row')) {
    assert.deepEqual([...new Set(datasourcesOf(panel))], ['n8n-prometheus'],
      `panel ${panel.id} ("${panel.title}") does not read the prometheus datasource`);
  }
});

test('the po11y dashboard only queries metrics the server actually exports', () => {
  // server/metrics.mjs's META table — the complete set.
  const exported = new Set(
    readFileSync(new URL('server/metrics.mjs', REPO), 'utf8')
      .match(/'po11y_[a-z0-9_]+'/g)
      .map((s) => s.slice(1, -1)),
  );
  const dash = [...byUid.values()].find((d) => d.file.startsWith('po11y-'));
  for (const panel of allPanels(dash)) {
    for (const expr of exprsOf(panel)) {
      for (const name of expr.match(/po11y_[a-z0-9_]+/g) || []) {
        assert.ok(exported.has(name),
          `panel ${panel.id} ("${panel.title}") queries ${name}, which server/metrics.mjs does not export`);
      }
    }
  }
});

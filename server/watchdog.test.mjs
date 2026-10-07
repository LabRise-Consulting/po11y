import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeExecutions, evaluateAlerts, reconcileAlerts, alertsToNotifications, mergeNotifications, envNumber, unreachableAlert, DEFAULT_FEED_MAX , aiMapDegradedAlert, isIgnored } from './watchdog.mjs';

const T = (iso) => new Date(iso).getTime();
const NOW = T('2026-07-28T12:00:00Z');

// ---- summarizeExecutions ----------------------------------------------------
test('lastOkAt tracks the last SUCCESS, not the last execution', () => {
  const execs = [
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T09:00:00Z' },
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' },
  ];
  const s = summarizeExecutions(execs, { now: NOW });
  const a = s.get('a');
  assert.equal(a.lastAt, '2026-07-28T11:00:00Z', 'lastAt is the newest run of any status');
  assert.equal(a.lastOkAt, '2026-07-28T09:00:00Z', 'lastOkAt ignores the newer failure');
});

test('summarizes every workflow, not just the busiest ten', () => {
  const execs = [];
  for (let i = 0; i < 12; i++) {
    execs.push({ workflowId: `w${i}`, status: 'success', startedAt: '2026-07-28T11:00:00Z' });
  }
  // w0 gets extra runs so it would win any "top N by count" truncation.
  for (let i = 0; i < 5; i++) {
    execs.push({ workflowId: 'w0', status: 'success', startedAt: '2026-07-28T11:30:00Z' });
  }
  const s = summarizeExecutions(execs, { now: NOW });
  assert.equal(s.size, 12, 'all 12 workflows present — alerting must not run off a truncated list');
});

test('collects in-flight executions with their age', () => {
  const execs = [
    { id: 'e1', workflowId: 'a', status: 'running', startedAt: '2026-07-28T11:30:00Z' },
    { id: 'e2', workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' },
  ];
  const a = summarizeExecutions(execs, { now: NOW }).get('a');
  assert.deepEqual(a.running, [{ id: 'e1', startedAt: '2026-07-28T11:30:00Z', ageMin: 30 }]);
});

test('resolves workflow names from the supplied id->name map', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' }];
  const names = new Map([['a', 'Nightly sync']]);
  assert.equal(summarizeExecutions(execs, { now: NOW, names }).get('a').name, 'Nightly sync');
});

test('falls back to the raw id when no name is known', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' }];
  assert.equal(summarizeExecutions(execs, { now: NOW }).get('a').name, 'a');
});

test('crashed counts as an error, the same as the Grafana dashboards count it', () => {
  const execs = [
    { workflowId: 'a', status: 'crashed', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:01:00Z' },
  ];
  assert.equal(summarizeExecutions(execs, { now: NOW }).get('a').errors, 2);
});

test('a crashed execution does not refresh lastOkAt', () => {
  const execs = [
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T09:00:00Z' },
    { workflowId: 'a', status: 'crashed', startedAt: '2026-07-28T11:00:00Z' },
  ];
  assert.equal(summarizeExecutions(execs, { now: NOW }).get('a').lastOkAt, '2026-07-28T09:00:00Z');
});

test('canceled is not an error — a human stopping a run is not a failure', () => {
  const execs = [
    { workflowId: 'a', status: 'canceled', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'waiting', startedAt: '2026-07-28T11:01:00Z' },
    { workflowId: 'a', status: 'new', startedAt: '2026-07-28T11:02:00Z' },
  ];
  assert.equal(summarizeExecutions(execs, { now: NOW }).get('a').errors, 0);
});

// ---- evaluateAlerts ---------------------------------------------------------
const wf = (id, name, extra = {}) => ({ id, name, active: true, updatedAt: '2026-01-01T00:00:00Z', ...extra });
const sum = (execs) => summarizeExecutions(execs, { now: NOW });
const rules = (a) => a.map((x) => `${x.rule}:${x.workflowId}`).sort();

test('no alerts when the feature is disabled', () => {
  const s = sum([{ workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' }]);
  const out = evaluateAlerts(s, [wf('a', 'A')], { enabled: false, minErrors: 1 }, { now: NOW });
  assert.deepEqual(out, []);
});

test('failing fires once errors clear BOTH the count floor and the rate floor', () => {
  const execs = [
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:01:00Z' },
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:02:00Z' },
  ];
  const cfg = { enabled: true, minErrors: 2, errorRate: 0.5 };
  assert.deepEqual(rules(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW })), ['failing:a']);
});

test('failing fires on crashed executions alone', () => {
  const execs = [
    { workflowId: 'a', status: 'crashed', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'crashed', startedAt: '2026-07-28T11:01:00Z' },
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:02:00Z' },
  ];
  const cfg = { enabled: true, minErrors: 2, errorRate: 0.5 };
  assert.deepEqual(rules(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW })), ['failing:a']);
});

test('a single error below the count floor is noise, not an alert', () => {
  const execs = [
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:01:00Z' },
  ];
  const cfg = { enabled: true, minErrors: 3, errorRate: 0.1 };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

test('a busy workflow under the rate floor does not alert despite many errors', () => {
  const execs = [];
  for (let i = 0; i < 3; i++) execs.push({ workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' });
  for (let i = 0; i < 97; i++) execs.push({ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' });
  const cfg = { enabled: true, minErrors: 3, errorRate: 0.5 };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

test('stale measures from the last SUCCESS, so a constantly-failing workflow still goes stale', () => {
  const execs = [
    { workflowId: 'a', status: 'success', startedAt: '2026-07-27T11:00:00Z' }, // 25h ago
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:59:00Z' },   // 1m ago
  ];
  const cfg = { enabled: true, staleAfterMin: 1440, minErrors: 99 }; // failing rule muted
  assert.deepEqual(rules(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW })), ['stale:a']);
});

test('stale does not fire while the last success is inside the budget', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' }];
  const cfg = { enabled: true, staleAfterMin: 1440 };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

test('an active workflow with NO executions at all goes stale — the silent-failure case', () => {
  const cfg = { enabled: true, staleAfterMin: 60 };
  const out = evaluateAlerts(new Map(), [wf('a', 'A')], cfg, { now: NOW });
  assert.deepEqual(rules(out), ['stale:a']);
});

test('a workflow activated more recently than its budget is not yet stale', () => {
  const cfg = { enabled: true, staleAfterMin: 60 };
  const fresh = wf('a', 'A', { updatedAt: '2026-07-28T11:30:00Z' }); // 30m old, budget 60m
  assert.deepEqual(evaluateAlerts(new Map(), [fresh], cfg, { now: NOW }), []);
});

test('inactive workflows are never stale', () => {
  const cfg = { enabled: true, staleAfterMin: 60 };
  assert.deepEqual(evaluateAlerts(new Map(), [wf('a', 'A', { active: false })], cfg, { now: NOW }), []);
});

test('stuck fires on an execution running past the budget', () => {
  const execs = [{ id: 'e1', workflowId: 'a', status: 'running', startedAt: '2026-07-28T10:00:00Z' }];
  const cfg = { enabled: true, stuckAfterMin: 60 };
  const out = evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW });
  assert.deepEqual(rules(out), ['stuck:a']);
  assert.match(out[0].message, /e1/, 'names the offending execution so it can be found');
});

test('a young in-flight execution is not stuck', () => {
  const execs = [{ id: 'e1', workflowId: 'a', status: 'running', startedAt: '2026-07-28T11:50:00Z' }];
  const cfg = { enabled: true, stuckAfterMin: 60 };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

test('perWorkflow budgets override the global one, by name or by id', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:00:00Z' }]; // 60m ago
  const cfg = { enabled: true, staleAfterMin: 1440, perWorkflow: { A: { staleAfterMin: 30 } } };
  assert.deepEqual(rules(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW })), ['stale:a']);
});

test('a perWorkflow budget of 0 disables the rule for that workflow', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2026-07-27T00:00:00Z' }];
  const cfg = { enabled: true, staleAfterMin: 60, perWorkflow: { A: { staleAfterMin: 0 } } };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

test('ignored workflows produce no alerts of any kind', () => {
  const execs = [
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:01:00Z' },
  ];
  const cfg = { enabled: true, minErrors: 1, errorRate: 0.1, staleAfterMin: 1, ignore: ['A'] };
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], cfg, { now: NOW }), []);
});

// ---- stale derived from the Schedule Trigger (issue #15) -------------------
// "default budget" below means the rule enabled globally with NO per-workflow
// override — the case the flat budget got wrong every weekend.
const scheduled = (interval, extra = {}) => wf('a', 'A', {
  nodes: [{
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    parameters: { rule: { interval } },
  }],
  ...extra,
});
const cronWf = (expression, extra = {}) => scheduled([{ field: 'cronExpression', expression }], extra);
const ok = (iso) => [{ workflowId: 'a', status: 'success', startedAt: iso }];
const at = (iso) => new Date(iso).getTime();
// The rule on, a generous flat budget that WOULD fire, and `failing` muted.
const DERIVED = { enabled: true, staleAfterMin: 360, staleGraceMin: 15, minErrors: 99 };

test('a Mon-Fri workflow is not stale on Saturday, though the flat budget would fire', () => {
  const now = at('2026-08-01T12:00:00Z'); // Saturday
  const execs = ok('2026-07-31T09:01:00Z'); // Friday's run, ~27h ago
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], DERIVED, { now });
  assert.deepEqual(out, []);
});

test('the same workflow goes stale on Tuesday once the 09:00 run is past its grace', () => {
  const now = at('2026-07-28T09:20:00Z'); // Tuesday, 20 min after the expected run
  const execs = ok('2026-07-27T09:01:00Z'); // Monday succeeded, Tuesday did not
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], DERIVED, { now });
  assert.deepEqual(rules(out), ['stale:a']);
  assert.match(out[0].message, /expected run/i, 'the message says what was expected, not just an age');
});

test('a run that is merely late is inside the grace and does not alert', () => {
  const now = at('2026-07-28T09:10:00Z'); // 10 min after the expected run, grace 15
  const execs = ok('2026-07-27T09:01:00Z');
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], DERIVED, { now });
  assert.deepEqual(out, []);
});

test('a schedule does not switch the rule on by itself — the global budget is the switch', () => {
  const now = at('2026-07-28T09:20:00Z');
  const cfg = { enabled: true, staleAfterMin: 0, minErrors: 99 };
  const out = evaluateAlerts(new Map(), [cronWf('0 9 * * 1-5')], cfg, { now });
  assert.deepEqual(out, []);
});

test('an explicit perWorkflow staleAfterMin overrides the derived budget', () => {
  const now = at('2026-08-01T12:00:00Z'); // Saturday: the derived budget says fine
  const execs = ok('2026-07-31T09:01:00Z');
  const cfg = { ...DERIVED, perWorkflow: { A: { staleAfterMin: 30 } } };
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], cfg, { now });
  assert.deepEqual(rules(out), ['stale:a']);
});

test('an unparseable cron falls back to the flat budget and reports itself once', () => {
  const now = at('2026-07-28T12:00:00Z');
  const seen = [];
  const out = evaluateAlerts(new Map(), [cronWf('every other tuesday')], DERIVED, {
    now, onScheduleError: (e) => seen.push(e),
  });
  assert.deepEqual(rules(out), ['stale:a'], 'the flat budget still applies');
  assert.deepEqual(seen, [{ workflowId: 'a', workflowName: 'A', expression: 'every other tuesday' }]);
});

test('a workflow with no Schedule Trigger keeps the flat budget', () => {
  const now = at('2026-07-28T12:00:00Z');
  const execs = ok('2026-07-28T05:00:00Z'); // 7h ago, flat budget 360 min
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [wf('a', 'A')], DERIVED, { now });
  assert.deepEqual(rules(out), ['stale:a']);
});

test('the instance timezone decides when the expected run was', () => {
  // 06:20Z is 08:20 in Berlin — before the 09:00 run. Read as UTC the workflow
  // would already have missed a 09:00 run yesterday and be stale.
  const now = at('2026-07-28T06:20:00Z');
  const execs = ok('2026-07-27T07:01:00Z'); // Monday 09:01 Berlin
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], DERIVED, {
    now, instanceTimezone: 'Europe/Berlin',
  });
  assert.deepEqual(out, []);
});

test('winter time moves the expected run with the clock', () => {
  // 2026-10-26 is the Monday after the European switch to CET (UTC+1), so the
  // 09:00 Berlin run is 08:00Z. At 08:10Z it is 10 min old and inside grace;
  // reading the zone as summer time would place it an hour earlier and alert.
  const now = at('2026-10-26T08:10:00Z');
  const execs = ok('2026-10-23T07:01:00Z'); // Friday 09:01 CEST
  const out = evaluateAlerts(summarizeExecutions(execs, { now }), [cronWf('0 9 * * 1-5')], DERIVED, {
    now, instanceTimezone: 'Europe/Berlin',
  });
  assert.deepEqual(out, []);
});

test('an interval schedule goes stale after one cadence plus grace', () => {
  const now = at('2026-07-28T12:00:00Z');
  const every30 = scheduled([{ field: 'minutes', minutesInterval: 30 }]);
  const late = summarizeExecutions(ok('2026-07-28T11:10:00Z'), { now }); // 50 min
  assert.deepEqual(rules(evaluateAlerts(late, [every30], DERIVED, { now })), ['stale:a']);
  const fresh = summarizeExecutions(ok('2026-07-28T11:25:00Z'), { now }); // 35 min
  assert.deepEqual(evaluateAlerts(fresh, [every30], DERIVED, { now }), []);
});

test('staleGraceFactor widens the grace in proportion to the cadence', () => {
  const now = at('2026-07-28T12:00:00Z');
  const every30 = scheduled([{ field: 'minutes', minutesInterval: 30 }]);
  const late = summarizeExecutions(ok('2026-07-28T11:10:00Z'), { now }); // 50 min
  const cfg = { ...DERIVED, staleGraceFactor: 1 }; // grace = max(15, 30) = 30
  assert.deepEqual(evaluateAlerts(late, [every30], cfg, { now }), []);
});

test('a perWorkflow staleGraceMin overrides the global grace', () => {
  const now = at('2026-07-28T09:20:00Z');
  const execs = summarizeExecutions(ok('2026-07-27T09:01:00Z'), { now });
  const cfg = { ...DERIVED, perWorkflow: { A: { staleGraceMin: 60 } } };
  assert.deepEqual(evaluateAlerts(execs, [cronWf('0 9 * * 1-5')], cfg, { now }), []);
});

test('a scheduled workflow that has never run goes stale on the derived budget', () => {
  const now = at('2026-07-28T09:20:00Z');
  const out = evaluateAlerts(new Map(), [cronWf('0 9 * * 1-5')], DERIVED, { now });
  assert.deepEqual(rules(out), ['stale:a']);
});

test('staleAfterMin unset means the stale rule is off entirely', () => {
  const execs = [{ workflowId: 'a', status: 'success', startedAt: '2020-01-01T00:00:00Z' }];
  assert.deepEqual(evaluateAlerts(sum(execs), [wf('a', 'A')], { enabled: true }, { now: NOW }), []);
});

// ---- reconcileAlerts (dedupe) ----------------------------------------------
const alert = (rule, id) => ({
  rule, workflowId: id, workflowName: id.toUpperCase(), severity: 'failure',
  title: `${id} bad`, message: 'm', since: null,
});
const iso = (t) => new Date(t).toISOString();

test('a newly-true alert fires', () => {
  const { fire } = reconcileAlerts([alert('failing', 'a')], {}, { now: NOW, renotifyMin: 60 });
  assert.equal(fire.length, 1);
  assert.equal(fire[0].kind, 'firing');
});

test('the same alert does not fire again on the next poll', () => {
  const a = [alert('failing', 'a')];
  const first = reconcileAlerts(a, {}, { now: NOW, renotifyMin: 60 });
  const second = reconcileAlerts(a, first.state, { now: NOW + 10 * 60_000, renotifyMin: 60 });
  assert.deepEqual(second.fire, [], 'still true, already told you — silence');
});

test('a persistent alert re-fires once the renotify window elapses', () => {
  const a = [alert('failing', 'a')];
  const first = reconcileAlerts(a, {}, { now: NOW, renotifyMin: 60 });
  const later = reconcileAlerts(a, first.state, { now: NOW + 61 * 60_000, renotifyMin: 60 });
  assert.equal(later.fire.length, 1);
  assert.equal(later.fire[0].kind, 'firing');
});

test('renotifyMin of 0 means never repeat', () => {
  const a = [alert('failing', 'a')];
  const first = reconcileAlerts(a, {}, { now: NOW, renotifyMin: 0 });
  const muchLater = reconcileAlerts(a, first.state, { now: NOW + 999 * 60_000, renotifyMin: 0 });
  assert.deepEqual(muchLater.fire, []);
});

test('an alert that stops being true emits a recovery and leaves the state', () => {
  const first = reconcileAlerts([alert('failing', 'a')], {}, { now: NOW, renotifyMin: 60 });
  const cleared = reconcileAlerts([], first.state, { now: NOW + 60_000, renotifyMin: 60 });
  assert.equal(cleared.fire.length, 1);
  assert.equal(cleared.fire[0].kind, 'resolved');
  assert.deepEqual(cleared.state, {}, 'resolved keys drop out so a recurrence notifies again');
});

test('a recurrence after a recovery notifies again', () => {
  const a = [alert('failing', 'a')];
  const first = reconcileAlerts(a, {}, { now: NOW, renotifyMin: 999 });
  const cleared = reconcileAlerts([], first.state, { now: NOW + 60_000, renotifyMin: 999 });
  const again = reconcileAlerts(a, cleared.state, { now: NOW + 120_000, renotifyMin: 999 });
  assert.equal(again.fire.length, 1);
  assert.equal(again.fire[0].kind, 'firing');
});

test('state round-trips through JSON — it is persisted between collector restarts', () => {
  const first = reconcileAlerts([alert('failing', 'a')], {}, { now: NOW, renotifyMin: 60 });
  const revived = JSON.parse(JSON.stringify(first.state));
  const second = reconcileAlerts([alert('failing', 'a')], revived, { now: NOW + 60_000, renotifyMin: 60 });
  assert.deepEqual(second.fire, [], 'a restart must not re-spam every open alert');
});

test('a corrupt or missing state file is treated as empty, not fatal', () => {
  assert.equal(reconcileAlerts([alert('failing', 'a')], null, { now: NOW }).fire.length, 1);
});

test('alerts on different rules for one workflow are tracked independently', () => {
  const both = [alert('failing', 'a'), alert('stale', 'a')];
  const first = reconcileAlerts([alert('failing', 'a')], {}, { now: NOW, renotifyMin: 999 });
  const second = reconcileAlerts(both, first.state, { now: NOW + 60_000, renotifyMin: 999 });
  assert.deepEqual(second.fire.map((f) => f.rule), ['stale'], 'only the new rule fires');
});

// ---- alertsToNotifications --------------------------------------------------
test('a firing alert becomes a failure notification', () => {
  const [n] = alertsToNotifications([{ ...alert('failing', 'a'), kind: 'firing' }], { now: NOW });
  assert.equal(n.status, 'failure');
  assert.equal(n.title, 'a bad');
  assert.equal(n.ts, iso(NOW));
});

test('a resolved alert becomes a success notification with recovered wording', () => {
  const [n] = alertsToNotifications([{ ...alert('failing', 'a'), kind: 'resolved' }], { now: NOW });
  assert.equal(n.status, 'success');
  assert.match(n.title, /recovered/i);
});

test('a baseUrl produces a deep link to the workflow in n8n', () => {
  const [n] = alertsToNotifications(
    [{ ...alert('failing', 'a'), kind: 'firing' }],
    { now: NOW, baseUrl: 'https://n8n.example.com/' },
  );
  assert.equal(n.link, 'https://n8n.example.com/workflow/a');
});

test('no baseUrl means no link field rather than a broken one', () => {
  const [n] = alertsToNotifications([{ ...alert('failing', 'a'), kind: 'firing' }], { now: NOW });
  assert.equal('link' in n, false);
});

test('a recovery names the workflow, not its opaque n8n id', () => {
  const a = { ...alert('failing', 'wf-7yZ'), workflowName: 'Nightly sync' };
  const first = reconcileAlerts([a], {}, { now: NOW, renotifyMin: 60 });
  const cleared = reconcileAlerts([], first.state, { now: NOW + 60_000, renotifyMin: 60 });
  assert.equal(cleared.fire[0].workflowName, 'Nightly sync');
});

// ---- mergeNotifications -----------------------------------------------------
test('new notifications land in front of the existing feed', () => {
  const prev = [{ ts: iso(NOW - 60_000), title: 'old', message: 'm', status: 'info' }];
  const fresh = [{ ts: iso(NOW), title: 'new', message: 'm', status: 'failure' }];
  assert.deepEqual(mergeNotifications(fresh, prev, 50).map((n) => n.title), ['new', 'old']);
});

test('the feed is capped so it cannot grow without bound', () => {
  const prev = Array.from({ length: 60 }, (_, i) => ({ ts: iso(NOW), title: `o${i}`, message: 'm', status: 'info' }));
  assert.equal(mergeNotifications([{ ts: iso(NOW), title: 'new', message: 'm', status: 'failure' }], prev, 50).length, 50);
});

test('a corrupt existing feed is discarded rather than crashing the poll', () => {
  const fresh = [{ ts: iso(NOW), title: 'new', message: 'm', status: 'failure' }];
  assert.deepEqual(mergeNotifications(fresh, { not: 'an array' }, 50), fresh);
  assert.deepEqual(mergeNotifications(fresh, null, 50), fresh);
});

test('a cap of 0 or less falls back to the default rather than emptying the feed', () => {
  const fresh = [{ ts: iso(NOW), title: 'new', message: 'm', status: 'failure' }];
  assert.equal(mergeNotifications(fresh, [], 0).length, 1);
});

// ---- envNumber --------------------------------------------------------------
test('envNumber passes through a valid numeric string', () => {
  assert.deepEqual(envNumber('5', 3), { value: 5, invalid: false });
  assert.deepEqual(envNumber('0.25', 1), { value: 0.25, invalid: false });
});

test('envNumber treats unset and empty as "use the default", not as an error', () => {
  assert.deepEqual(envNumber(undefined, 3), { value: 3, invalid: false });
  assert.deepEqual(envNumber('', 3), { value: 3, invalid: false });
});

test('envNumber reports a malformed value instead of yielding NaN', () => {
  // NaN would silently disable the rule: every `errors >= NaN` is false, and the
  // operator gets no hint that their typo turned the watchdog off.
  assert.deepEqual(envNumber('abc', 3), { value: 3, invalid: true });
  assert.deepEqual(envNumber('3 minutes', 3), { value: 3, invalid: true });
});

test('envNumber rejects Infinity, which would disable a budget just as silently', () => {
  assert.deepEqual(envNumber('Infinity', 60), { value: 60, invalid: true });
});

test('envNumber accepts an explicit zero — that is how a rule is turned off', () => {
  assert.deepEqual(envNumber('0', 60), { value: 0, invalid: false });
});

test('envNumber rejects a negative budget rather than firing on every workflow', () => {
  assert.deepEqual(envNumber('-5', 60), { value: 60, invalid: true });
});

// ---- unreachableAlert -------------------------------------------------------
// The three workflow rules can only fire on data the collector managed to
// fetch. When n8n itself is down there IS no data, so every rule goes quiet on
// exactly the outage an operator most wants to hear about.
test('an unreachable n8n produces an alert of its own', () => {
  const a = unreachableAlert(new Error('fetch failed'));
  assert.equal(a.rule, 'unreachable');
  assert.equal(a.severity, 'failure');
  assert.match(a.title, /reach/i);
});

test('the unreachable alert carries no workflow id, so it links nowhere', () => {
  // A `${baseUrl}/workflow/n8n` href would render as a live button that 404s.
  const [n] = alertsToNotifications(
    [{ ...unreachableAlert(new Error('x')), kind: 'firing' }],
    { now: NOW, baseUrl: 'https://n8n.example.com' },
  );
  assert.equal('link' in n, false);
});

test('the unreachable alert keeps the n8n base url out of its published message', () => {
  // Unlike the stderr line, this one lands in notifications.json (web-served)
  // and in the push webhook, so an internal hostname must not ride along.
  const a = unreachableAlert(
    new Error('connect ECONNREFUSED http://n8n.internal:5678/api/v1/workflows'),
    { baseUrl: 'http://n8n.internal:5678/' },
  );
  assert.doesNotMatch(a.message, /n8n\.internal/);
  assert.match(a.message, /ECONNREFUSED/, 'the useful part of the diagnosis survives');
});

test('the unreachable alert dedupes like any other alert', () => {
  const a = [unreachableAlert(new Error('fetch failed'))];
  const first = reconcileAlerts(a, {}, { now: NOW, renotifyMin: 360 });
  const next = reconcileAlerts(a, first.state, { now: NOW + 600_000, renotifyMin: 360 });
  assert.equal(first.fire.length, 1);
  assert.deepEqual(next.fire, [], 'a two-day outage must not post once per poll');
});

test('a poll that succeeds again resolves the unreachable alert', () => {
  const first = reconcileAlerts([unreachableAlert(new Error('down'))], {}, { now: NOW, renotifyMin: 360 });
  const back = reconcileAlerts([], first.state, { now: NOW + 600_000, renotifyMin: 360 });
  assert.equal(back.fire.length, 1);
  assert.equal(back.fire[0].kind, 'resolved');
  assert.match(back.fire[0].title, /n8n/);
});

// ---- reconcileAlerts scoping ------------------------------------------------
test('a scoped pass leaves alerts it cannot see alone', () => {
  // A failed poll knows nothing about workflows. Reconciling the whole state
  // against an empty list would announce every open workflow alert as
  // "recovered" and re-announce it the moment n8n came back.
  const open = reconcileAlerts([alert('failing', 'a')], {}, { now: NOW, renotifyMin: 999 });
  const outage = reconcileAlerts(
    [unreachableAlert(new Error('down'))], open.state,
    { now: NOW + 60_000, renotifyMin: 999, rules: ['unreachable'] },
  );
  assert.deepEqual(outage.fire.map((f) => f.rule), ['unreachable']);
  assert.deepEqual(outage.state['failing:a'], open.state['failing:a'], 'workflow alert untouched');
});

test('an unscoped pass resolves everything, which is what a successful poll means', () => {
  const open = reconcileAlerts(
    [alert('failing', 'a'), unreachableAlert(new Error('down'))], {},
    { now: NOW, renotifyMin: 999 },
  );
  const clean = reconcileAlerts([], open.state, { now: NOW + 60_000, renotifyMin: 999 });
  assert.equal(clean.fire.length, 2);
  assert.deepEqual(clean.state, {});
});

// ---- the notifications cap has one home -------------------------------------
// DEFAULT_FEED_MAX is exported precisely so the copies that CANNOT import it
// are pinned here instead of drifting silently — the cap used to live in four
// places. Only the env-file comment is left: the Code node that inlined its
// own copy (hn-notify.json) wrote the feed to a deleted volume and is gone.
test('.env.example documents the same ALERT_FEED_MAX default the code uses', () => {
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, new RegExp(`default ${DEFAULT_FEED_MAX}\\)`), 'comment names the default');
  assert.match(env, new RegExp(`^ALERT_FEED_MAX=${DEFAULT_FEED_MAX}$`, 'm'));
});

// ---- aiMapDegradedAlert -----------------------------------------------------

test('aiMapDegradedAlert is shaped like every other alert, so reconcile handles it', () => {
  const a = aiMapDegradedAlert('LLM POST -> 503');
  assert.equal(a.rule, 'ai-map-degraded');
  assert.equal(a.workflowId, '', 'no workflow to link to');
  assert.equal(a.workflowName, 'Architecture map');
  assert.equal(a.severity, 'info', 'the map still published — only its prose fell back');
  assert.match(a.message, /503/);
  assert.match(a.message, /heuristic/i, 'must say what the reader is looking at instead');
});

test('aiMapDegradedAlert scrubs the LLM base URL out of the published message', () => {
  const a = aiMapDegradedAlert('POST http://omniroute.internal:20128/v1/chat/completions -> 503',
    { aiBase: 'http://omniroute.internal:20128/v1' });
  assert.ok(!a.message.includes('omniroute.internal'), `internal host leaked: ${a.message}`);
  assert.match(a.message, /the LLM gateway/);
});

test('aiMapDegradedAlert survives a nullish reason rather than printing undefined', () => {
  assert.match(aiMapDegradedAlert(null).message, /unknown error/);
});

test('alertsToNotifications maps severity onto the feed status, and guesses failure', () => {
  const [info] = alertsToNotifications([{ ...aiMapDegradedAlert('503'), kind: 'firing' }]);
  assert.equal(info.status, 'info');
  const [legacy] = alertsToNotifications([{ rule: 'failing', workflowId: 'wf1', workflowName: 'Ingest', title: 't', message: 'm', kind: 'firing' }]);
  assert.equal(legacy.status, 'failure', 'a rule with no severity must not become info');
  const [done] = alertsToNotifications([{ rule: 'ai-map-degraded', workflowId: '', workflowName: 'Architecture map', severity: 'info', kind: 'resolved' }]);
  assert.equal(done.status, 'success', 'a recovery is a recovery whatever the severity was');
});

// ---- ignore added at runtime (#18) ------------------------------------------
test('isIgnored matches a workflow by name or by id', () => {
  assert.equal(isIgnored({ ignore: ['A'] }, { id: 'a', name: 'A' }), true);
  assert.equal(isIgnored({ ignore: ['a'] }, { id: 'a', name: 'A' }), true);
  assert.equal(isIgnored({ ignore: ['B'] }, { id: 'a', name: 'A' }), false);
  assert.equal(isIgnored({}, { id: 'a', name: 'A' }), false);
});

test('an open alert on a workflow that became ignored is dropped, not recovered', () => {
  // Ignoring a workflow is not evidence it recovered; a "recovered" message
  // would be a false all-clear.
  const first = reconcileAlerts([alert('failing', 'a'), alert('stale', 'b')], {}, { now: NOW });
  const next = reconcileAlerts([alert('stale', 'b')], first.state, { now: NOW + 60_000, ignored: new Set(['a']) });
  assert.deepEqual(next.fire, []);
  assert.deepEqual(Object.keys(next.state), ['stale:b']);
});

// ---- structured evidence (#17) ----------------------------------------------
// The message text stays as it is; these fields carry the same evidence for a
// consumer that should not have to parse prose.
const evidence = ({ threshold, observed, window }) => ({ threshold, observed, window });

test('a failing alert carries its thresholds, the observed counts and the window', () => {
  const execs = [
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:00:00Z' },
    { workflowId: 'a', status: 'error', startedAt: '2026-07-28T11:01:00Z' },
    { workflowId: 'a', status: 'success', startedAt: '2026-07-28T11:02:00Z' },
  ];
  const [a] = evaluateAlerts(sum(execs), [wf('a', 'A')], { enabled: true, minErrors: 2, errorRate: 0.5 }, { now: NOW });
  assert.deepEqual(evidence(a), {
    threshold: { minErrors: 2, errorRate: 0.5 },
    observed: { errors: 2, count: 3 },
    window: { executions: 3 },
  });
});

test('a flat-budget stale alert carries the budget and the observed age', () => {
  const s = sum([{ workflowId: 'a', status: 'success', startedAt: '2026-07-28T05:20:00Z' }]);
  const [a] = evaluateAlerts(s, [wf('a', 'A')], { enabled: true, staleAfterMin: 360, minErrors: 99 }, { now: NOW });
  assert.deepEqual(evidence(a), { threshold: { staleAfterMin: 360 }, observed: { ageMin: 400 }, window: undefined });
});

test('a stale alert with no success on record reports a null age, not Infinity', () => {
  const [a] = evaluateAlerts(sum([]), [wf('a', 'A', { updatedAt: null })], { enabled: true, staleAfterMin: 360 }, { now: NOW });
  assert.deepEqual(a.observed, { ageMin: null });
  assert.equal(JSON.parse(JSON.stringify(a)).observed.ageMin, null);
});

test('a schedule-derived stale alert carries the expected run and the grace', () => {
  const [a] = evaluateAlerts(sum(ok('2026-07-27T09:00:00Z')), [cronWf('0 9 * * *')], DERIVED, { now: NOW });
  assert.deepEqual(a.threshold, { expectedAt: '2026-07-28T09:00:00.000Z', graceMin: 15 });
  assert.deepEqual(a.observed, { ageMin: 1620 });
});

test('a cadence-derived stale alert carries the cadence and the grace', () => {
  const [a] = evaluateAlerts(
    sum(ok('2026-07-28T09:00:00Z')),
    [scheduled([{ field: 'hours', hoursInterval: 1 }])], DERIVED, { now: NOW },
  );
  assert.deepEqual(a.threshold, { cadenceMin: 60, graceMin: 15 });
  assert.deepEqual(a.observed, { ageMin: 180 });
});

test('a stuck alert carries its budget and the hung executions', () => {
  const s = sum([{ id: 'e1', workflowId: 'a', status: 'running', startedAt: '2026-07-28T10:00:00Z' }]);
  const [a] = evaluateAlerts(s, [wf('a', 'A')], { enabled: true, stuckAfterMin: 60, minErrors: 99 }, { now: NOW });
  assert.deepEqual(evidence(a), { threshold: { stuckAfterMin: 60 }, observed: { running: 1, oldestAgeMin: 120 }, window: undefined });
});

test('a firing notification carries rule, workflowId, since and the evidence', () => {
  const a = {
    ...alert('failing', 'a'), since: '2026-07-28T09:00:00Z',
    threshold: { minErrors: 3, errorRate: 0.5 }, observed: { errors: 3, count: 5 }, window: { executions: 5 },
  };
  const [n] = alertsToNotifications([{ ...a, kind: 'firing' }], { now: NOW });
  assert.deepEqual(n, {
    ts: iso(NOW), title: 'a bad', message: a.message, status: 'failure',
    rule: 'failing', workflowId: 'a', since: '2026-07-28T09:00:00Z',
    threshold: a.threshold, observed: a.observed, window: a.window,
  });
});

test('a recovery notification carries rule and workflowId too', () => {
  const first = reconcileAlerts([alert('stale', 'a')], {}, { now: NOW });
  const cleared = reconcileAlerts([], first.state, { now: NOW + 60_000 });
  const [n] = alertsToNotifications(cleared.fire, { now: NOW });
  assert.equal(n.rule, 'stale');
  assert.equal(n.workflowId, 'a');
  assert.equal(n.since, iso(NOW));
});

test('an instance-level alert has a rule but no empty workflowId field', () => {
  const [n] = alertsToNotifications([{ ...unreachableAlert(new Error('x')), kind: 'firing' }], { now: NOW });
  assert.equal(n.rule, 'unreachable');
  assert.equal('workflowId' in n, false);
  assert.equal('threshold' in n, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeExecutions, evaluateAlerts, reconcileAlerts, alertsToNotifications, mergeNotifications, envNumber, unreachableAlert, DEFAULT_FEED_MAX } from './watchdog.mjs';

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

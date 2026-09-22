import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedSchedule } from './schedule.mjs';

const T = (iso) => new Date(iso).getTime();
const MIN = 60_000;
const NOW = T('2026-07-28T12:00:00Z'); // a Tuesday

/** A workflow carrying one Schedule Trigger with the given interval entries. */
const sched = (interval, extra = {}) => ({
  id: 'a',
  name: 'A',
  active: true,
  nodes: [{
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    parameters: { rule: { interval } },
  }],
  ...extra,
});

// ---- no schedule ------------------------------------------------------------
test('a workflow with no Schedule Trigger reports no schedule at all', () => {
  const wf = { id: 'a', name: 'A', nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path: 'x' } }] };
  assert.deepEqual(expectedSchedule(wf, { now: NOW }), { kind: 'none', unparseable: null });
});

test('a workflow with no nodes array at all reports no schedule', () => {
  assert.equal(expectedSchedule({ id: 'a', name: 'A' }, { now: NOW }).kind, 'none');
});

// ---- sub-day intervals become a cadence ------------------------------------
test('a minutes interval reports a cadence rather than an exact fire time', () => {
  const out = expectedSchedule(sched([{ field: 'minutes', minutesInterval: 30 }]), { now: NOW });
  assert.equal(out.kind, 'cadence');
  assert.equal(out.cadenceMs, 30 * MIN);
});

test('a seconds interval reports its cadence in milliseconds', () => {
  const out = expectedSchedule(sched([{ field: 'seconds', secondsInterval: 5 }]), { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs], ['cadence', 5_000]);
});

test('an hours interval reports its cadence in milliseconds', () => {
  const out = expectedSchedule(sched([{ field: 'hours', hoursInterval: 6 }]), { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs], ['cadence', 6 * 60 * MIN]);
});

test('an interval with no count falls back to one unit, the way n8n does', () => {
  const out = expectedSchedule(sched([{ field: 'minutes' }]), { now: NOW });
  assert.equal(out.cadenceMs, MIN);
});

// ---- days/weeks/months intervals become an exact fire time -----------------
test('a daily interval reports the most recent fire time, in UTC by default', () => {
  const wf = sched([{ field: 'days', triggerAtHour: 8, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, { now: NOW });
  assert.equal(out.kind, 'fire');
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T08:00:00.000Z');
  assert.equal(out.cadenceMs, 24 * 60 * MIN);
});

test('a daily time still ahead of now resolves to yesterday, not today', () => {
  const wf = sched([{ field: 'days', triggerAtHour: 14, triggerAtMinute: 30 }]);
  const out = expectedSchedule(wf, { now: NOW }); // now is 12:00Z
  assert.equal(new Date(out.at).toISOString(), '2026-07-27T14:30:00.000Z');
});

test('the instance timezone shifts the derived fire time', () => {
  const wf = sched([{ field: 'days', triggerAtHour: 8, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, { instanceTimezone: 'Europe/Berlin', now: NOW });
  // 08:00 CEST (UTC+2) is 06:00Z, not 08:00Z.
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T06:00:00.000Z');
});

test("the workflow's own settings.timezone wins over the instance default", () => {
  const wf = sched(
    [{ field: 'days', triggerAtHour: 8, triggerAtMinute: 0 }],
    { settings: { executionOrder: 'v1', timezone: 'America/New_York' } },
  );
  const out = expectedSchedule(wf, { instanceTimezone: 'Europe/Berlin', now: NOW });
  // 08:00 EDT (UTC-4) is 12:00Z.
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T12:00:00.000Z');
});

test('a weekly interval fires only on the listed weekdays', () => {
  const wf = sched([{ field: 'weeks', triggerAtDay: [1, 3, 5], triggerAtHour: 9, triggerAtMinute: 0 }]);
  // NOW is Tuesday 2026-07-28; the previous listed day is Monday the 27th.
  const out = expectedSchedule(wf, { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-27T09:00:00.000Z');
});

test('a monthly interval fires on its day of the month', () => {
  const wf = sched([{ field: 'months', triggerAtDayOfMonth: 1, triggerAtHour: 6, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-01T06:00:00.000Z');
});

test('a multi-unit day interval has no known phase, so it reports a cadence', () => {
  const wf = sched([{ field: 'days', daysInterval: 3, triggerAtHour: 8, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs], ['cadence', 3 * 24 * 60 * MIN]);
});

// ---- DST ---------------------------------------------------------------------
test('summer time: a 09:00 Berlin schedule is 07:00Z', () => {
  const wf = sched([{ field: 'days', triggerAtHour: 9, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, {
    instanceTimezone: 'Europe/Berlin', now: T('2026-10-23T12:00:00Z'),
  });
  assert.equal(new Date(out.at).toISOString(), '2026-10-23T07:00:00.000Z');
});

test('winter time: the same 09:00 Berlin schedule is 08:00Z after the October switch', () => {
  const wf = sched([{ field: 'days', triggerAtHour: 9, triggerAtMinute: 0 }]);
  const out = expectedSchedule(wf, {
    instanceTimezone: 'Europe/Berlin', now: T('2026-10-26T12:00:00Z'),
  });
  assert.equal(new Date(out.at).toISOString(), '2026-10-26T08:00:00.000Z');
});

// ---- cron expressions --------------------------------------------------------
const cron = (expression, extra = {}) => sched([{ field: 'cronExpression', expression }], extra);

test('a weekday-only cron resolves to this morning on a weekday', () => {
  const out = expectedSchedule(cron('0 9 * * 1-5'), { now: NOW });
  assert.equal(out.kind, 'fire');
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T09:00:00.000Z');
});

test('a weekday-only cron skips the weekend and resolves back to Friday', () => {
  const out = expectedSchedule(cron('0 9 * * 1-5'), { now: T('2026-08-01T12:00:00Z') }); // Saturday
  assert.equal(new Date(out.at).toISOString(), '2026-07-31T09:00:00.000Z');
});

test('weekday names are accepted, the way operators write them', () => {
  const out = expectedSchedule(cron('0 9 * * MON-FRI'), { now: T('2026-08-01T12:00:00Z') });
  assert.equal(new Date(out.at).toISOString(), '2026-07-31T09:00:00.000Z');
});

test('dow 7 means Sunday, the same as 0', () => {
  const out = expectedSchedule(cron('0 9 * * 7'), { now: NOW }); // Tuesday
  assert.equal(new Date(out.at).toISOString(), '2026-07-26T09:00:00.000Z');
});

test("n8n's six-field form reads the leading field as seconds", () => {
  const out = expectedSchedule(cron('30 0 9 * * *'), { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T09:00:30.000Z');
});

test('lists pick the latest listed hour that has already passed', () => {
  const out = expectedSchedule(cron('0 8,20 * * *'), { now: NOW }); // 12:00Z
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T08:00:00.000Z');
});

test('steps are honoured and set the cadence', () => {
  const out = expectedSchedule(cron('*/15 * * * *'), { now: T('2026-07-28T12:07:00Z') });
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T12:00:00.000Z');
  assert.equal(out.cadenceMs, 15 * MIN);
});

test('a ? in the day fields reads as *, for Quartz-style expressions', () => {
  const out = expectedSchedule(cron('0 9 ? * *'), { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T09:00:00.000Z');
});

test('a cron in the workflow timezone is resolved in that timezone', () => {
  const wf = cron('0 9 * * 1-5', { settings: { timezone: 'Europe/Berlin' } });
  const out = expectedSchedule(wf, { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T07:00:00.000Z');
});

test('an unparseable cron is reported rather than guessed at', () => {
  const out = expectedSchedule(cron('every other tuesday'), { now: NOW });
  assert.deepEqual(out, { kind: 'unparseable', unparseable: 'every other tuesday' });
});

test('a cron with an out-of-range field is unparseable, not silently clamped', () => {
  assert.equal(expectedSchedule(cron('0 99 * * *'), { now: NOW }).kind, 'unparseable');
});

// ---- several specs ------------------------------------------------------------
test('the shortest cadence wins when a workflow has several triggers', () => {
  const wf = {
    id: 'a',
    name: 'A',
    nodes: [
      { type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 8 }] } } },
      { type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 10 }] } } },
    ],
  };
  const out = expectedSchedule(wf, { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs], ['cadence', 10 * MIN]);
});

test('an unparseable sibling is reported but does not veto a parseable rule', () => {
  const wf = sched([
    { field: 'cronExpression', expression: 'nonsense' },
    { field: 'minutes', minutesInterval: 10 },
  ]);
  const out = expectedSchedule(wf, { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs, out.unparseable], ['cadence', 10 * MIN, 'nonsense']);
});

test('an unknown timezone falls back to UTC instead of throwing every poll', () => {
  const wf = cron('0 9 * * *', { settings: { timezone: 'Mars/Olympus_Mons' } });
  const out = expectedSchedule(wf, { now: NOW });
  assert.equal(new Date(out.at).toISOString(), '2026-07-28T09:00:00.000Z');
});

test('a cron that can never fire is reported, not turned into a zero budget', () => {
  // 30 February parses cleanly and matches no date there is. A cadence of zero
  // would make the watchdog call the workflow stale on every single poll.
  const out = expectedSchedule(cron('0 9 30 2 *'), { now: NOW });
  assert.deepEqual(out, { kind: 'unparseable', unparseable: '0 9 30 2 *' });
});

test('a cron that can never fire does not veto a usable sibling', () => {
  const wf = sched([
    { field: 'cronExpression', expression: '0 9 30 2 *' },
    { field: 'minutes', minutesInterval: 10 },
  ]);
  const out = expectedSchedule(wf, { now: NOW });
  assert.deepEqual([out.kind, out.cadenceMs, out.unparseable], ['cadence', 10 * MIN, '0 9 30 2 *']);
});

test('an interval unit this module does not know is skipped, not mis-parsed', () => {
  const out = expectedSchedule(sched([{ field: 'fortnights', fortnightsInterval: 1 }]), { now: NOW });
  assert.deepEqual(out, { kind: 'none', unparseable: null });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getKv } from './db.mjs';
import { alertNotifications, unreachableNotifications, n8nReachable } from './alerts.mjs';

const NOW = Date.parse('2026-08-11T06:00:00.000Z');
const WF = [{ id: 'wf1', name: 'Ingest', active: true, nodes: [], connections: {} }];
const CFG = { enabled: true, minErrors: 2, errorRate: 0.5, staleAfterMin: 0, stuckAfterMin: 0, ignore: [] };

const failing = () => ([
  { id: '1', workflowId: 'wf1', status: 'error', startedAt: '2026-08-11T05:00:00.000Z' },
  { id: '2', workflowId: 'wf1', status: 'error', startedAt: '2026-08-11T05:10:00.000Z' },
]);

const call = (db, over = {}) => alertNotifications(db, {
  executions: failing(), workflows: WF, names: new Map([['wf1', 'Ingest']]),
  cfg: CFG, now: NOW, renotifyMin: 360, baseUrl: 'https://n8n.example', ...over,
});

test('a failing workflow produces a notification in the feed contract', () => {
  const db = openDb(':memory:');
  const notes = call(db).notifications;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'failure');
  assert.ok(notes[0].title && notes[0].message && notes[0].ts);
});

test('the same alert does not re-notify on the next evaluation', () => {
  const db = openDb(':memory:');
  assert.equal(call(db).notifications.length, 1);
  assert.equal(call(db).notifications.length, 0, 'reconciliation state must survive inside the store');
  assert.ok(getKv(db, 'alert-state'), 'expected persisted reconciliation state');
});

test('disabled alerting yields nothing and writes no state', () => {
  const db = openDb(':memory:');
  assert.deepEqual(call(db, { cfg: { ...CFG, enabled: false } }), { notifications: [], fire: [] });
  assert.equal(getKv(db, 'alert-state'), null);
});

test('corrupt persisted state is discarded rather than fatal', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('alert-state', 'not json');
  assert.equal(call(db).notifications.length, 1);
});

test('a broken evaluation publishes nothing instead of resolving open alerts', () => {
  const db = openDb(':memory:');
  call(db);
  // workflows:null makes evaluateAlerts throw; the guard must swallow it and
  // return [] — NOT an empty "all clear" that clears the open alert.
  assert.deepEqual(call(db, { workflows: null }), { notifications: [], fire: [] });
  assert.ok(getKv(db, 'alert-state').includes('wf1'), 'open alert state must survive');
});

test('the raw fire array is returned alongside the feed notifications', () => {
  const db = openDb(':memory:');
  const { notifications, fire } = call(db);
  assert.equal(notifications.length, 1);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].rule, 'failing');
  assert.equal(fire[0].kind, 'firing');
});

test('a sync failure publishes an unreachable notification exactly once', () => {
  const db = openDb(':memory:');
  const first = unreachableNotifications(db, {
    error: new Error('fetch failed'), cfg: CFG, now: NOW, renotifyMin: 360, baseUrl: 'https://n8n.example',
  });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.fire[0].rule, 'unreachable');
  const second = unreachableNotifications(db, {
    error: new Error('fetch failed'), cfg: CFG, now: NOW + 60_000, renotifyMin: 360, baseUrl: 'https://n8n.example',
  });
  assert.deepEqual(second, { notifications: [], fire: [] });
});

test('the unreachable pass cannot resolve open workflow alerts', () => {
  const db = openDb(':memory:');
  assert.equal(call(db).notifications.length, 1); // opens failing:wf1
  unreachableNotifications(db, { error: new Error('down'), cfg: CFG, now: NOW + 60_000, renotifyMin: 360 });
  assert.ok(getKv(db, 'alert-state').includes('failing:wf1'), 'workflow alert must survive the scoped pass');
});

test('a workflow-scoped rebuild cannot resolve an open unreachable alert; an unscoped one does', () => {
  const db = openDb(':memory:');
  unreachableNotifications(db, { error: new Error('down'), cfg: CFG, now: NOW, renotifyMin: 360 });
  call(db, { rules: ['failing', 'stale', 'stuck'] });
  assert.ok(getKv(db, 'alert-state').includes('unreachable:'), 'unreachable must survive the scoped pass');
  const resolved = call(db, { now: NOW + 120_000 });
  assert.ok(resolved.fire.some((f) => f.rule === 'unreachable' && f.kind === 'resolved'),
    'the unscoped pass is the recovery signal');
});

test('n8nReachable stays false until the first sync outcome, even with zero recorded failures', () => {
  // The startup-race bug: consecutiveFailures defaults to 0 before any sync
  // has ever run, which must NOT read as "reachable".
  assert.equal(n8nReachable({ syncedOnce: false, consecutiveFailures: 0 }), false);
  assert.equal(n8nReachable({ syncedOnce: true, consecutiveFailures: 0 }), true);
  assert.equal(n8nReachable({ syncedOnce: true, consecutiveFailures: 2 }), false);
});

test('a rebuild racing ahead of the first sync outcome cannot resolve a persisted unreachable alert', () => {
  const db = openDb(':memory:');
  unreachableNotifications(db, { error: new Error('down'), cfg: CFG, now: NOW, renotifyMin: 360 });
  // Mirrors rebuild()'s scoping decision for a rebuild that has never seen a
  // sync outcome — consecutiveFailures still reads its startup default of 0.
  const rules = n8nReachable({ syncedOnce: false, consecutiveFailures: 0 }) ? null : ['failing', 'stale', 'stuck'];
  call(db, { now: NOW + 60_000, rules });
  assert.ok(getKv(db, 'alert-state').includes('unreachable:'), 'must survive a rebuild before the first sync outcome');
});

test('the production call order for a failed sync — scoped alertNotifications then unreachableNotifications — resolves neither', () => {
  const db = openDb(':memory:');
  assert.equal(call(db).notifications.length, 1); // opens failing:wf1
  unreachableNotifications(db, { error: new Error('down'), cfg: CFG, now: NOW, renotifyMin: 360 }); // opens unreachable
  // Mirrors rebuild()'s exact order in server/index.mjs: alertNotifications
  // (scoped) runs first, then unreachableNotifications, both against the same
  // kv row, in one pass.
  call(db, { now: NOW + 60_000, rules: ['failing', 'stale', 'stuck'] });
  unreachableNotifications(db, { error: new Error('still down'), cfg: CFG, now: NOW + 60_000, renotifyMin: 360 });
  assert.ok(getKv(db, 'alert-state').includes('failing:wf1'), 'workflow alert must survive the production order');
  assert.ok(getKv(db, 'alert-state').includes('unreachable:'), 'unreachable alert must survive the production order');
});

// notifications.json parity. The three watchdog rules are pure functions over
// the execution window — the same functions the (now-retired) collector
// daemon ran, so the feed never drifted between publishers during the
// overlap. The only substitution is the state store: alert-state.json on the
// shared volume becomes a kv row.
//
// Guarded the same way the collector daemon guarded it: an evaluation that
// THROWS must publish nothing, because an empty alert list is
// indistinguishable from "everything recovered" and would resolve every open
// alert. A publish failure is a missed notification; a false all-clear is a
// missed outage.
//
// This module computes WHAT to say (notifications for the feed, the
// raw fire array for the chat push); index.mjs owns the actual push through
// server/notify.mjs. Compose maps ALERT_WEBHOOK_URL to exactly one
// process — two pushers means two messages.
import {
  summarizeExecutions, evaluateAlerts, reconcileAlerts, alertsToNotifications, unreachableAlert,
} from './watchdog.mjs';
import { getKv, setKv } from './db.mjs';

const STATE_KEY = 'alert-state';

export function alertNotifications(db, {
  executions, workflows, names = null, cfg, now = Date.now(),
  renotifyMin = 360, baseUrl = '', rules = null, log = console.error,
} = {}) {
  const nothing = { notifications: [], fire: [] };
  if (!cfg?.enabled) return nothing;

  let alerts;
  try {
    if (!Array.isArray(workflows)) throw new Error('workflows must be an array');
    const summary = summarizeExecutions(executions, { now, names });
    alerts = evaluateAlerts(summary, workflows, cfg, { now });
  } catch (e) {
    log(`server: alert evaluation failed — ${e.message}`);
    return nothing;
  }

  try {
    let prevState = null;
    try { prevState = JSON.parse(getKv(db, STATE_KEY) ?? 'null'); } catch { /* corrupt: start over */ }
    const { fire, state } = reconcileAlerts(alerts, prevState, { now, renotifyMin, rules });
    setKv(db, STATE_KEY, JSON.stringify(state));
    return { notifications: alertsToNotifications(fire, { now, baseUrl }), fire };
  } catch (e) {
    log(`server: alert reconciliation failed — ${e.message}`);
    return nothing;
  }
}

/**
 * The "cannot reach n8n at all" alert — the (now-retired) collector daemon's
 * tick() failure path, translated onto the kv state store. Scoped to its own rule so
 * this pass can never resolve workflow alerts it evaluated nothing about; the
 * matching recovery comes from the next UNSCOPED alertNotifications pass,
 * which runs once the sync succeeds again.
 */
export function unreachableNotifications(db, {
  error, cfg, now = Date.now(), renotifyMin = 360, baseUrl = '', log = console.error,
} = {}) {
  const nothing = { notifications: [], fire: [] };
  if (!cfg?.enabled) return nothing;
  try {
    let prevState = null;
    try { prevState = JSON.parse(getKv(db, STATE_KEY) ?? 'null'); } catch { /* corrupt: start over */ }
    const { fire, state } = reconcileAlerts(
      [unreachableAlert(error, { baseUrl })], prevState,
      { now, renotifyMin, rules: ['unreachable'] },
    );
    setKv(db, STATE_KEY, JSON.stringify(state));
    return { notifications: alertsToNotifications(fire, { now, baseUrl }), fire };
  } catch (e) {
    log(`server: unreachable reconciliation failed — ${e.message}`);
    return nothing;
  }
}

/**
 * Whether a rebuild is entitled to run alertNotifications UNSCOPED — i.e.
 * whether it actually KNOWS n8n is reachable, not merely "has recorded no
 * failure yet".
 *
 * `consecutiveFailures` starts at 0 before the first sync has ever run,
 * which reads identically to "healthy" unless "no outcome yet" is tracked as
 * its own state. every()'s first tick fires immediately (server/timers.mjs),
 * and poll-fill's tick always reaches refresh() regardless of whether the
 * sync tick has recorded an outcome: pollFill reports an unreachable n8n as an
 * `{ok: false}` outcome instead of throwing (server/sync.mjs), so the tick runs
 * on to its refresh() either way. Without `syncedOnce`, a rebuild that races
 * ahead of the first sync outcome — or, permanently, a deployment with the
 * sync loop disabled — would call alertNotifications unscoped, and its
 * recovery pass would resolve a persisted 'unreachable' alert it has no
 * actual evidence for.
 *
 * @param {{ syncedOnce: boolean, consecutiveFailures: number }} sync
 * @returns {boolean}
 */
export function n8nReachable({ syncedOnce, consecutiveFailures }) {
  return !!syncedOnce && consecutiveFailures === 0;
}

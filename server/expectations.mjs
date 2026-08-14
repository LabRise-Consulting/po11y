// Data-level alerting. The alert rules this replaces watched execution status,
// which stays green when a nightly ingest succeeds and writes nothing — the
// exact failure mode that went unnoticed for days. These expectations watch the
// rows instead.
//
// Packs are JSON, not YAML, because the repo carries no dependencies and Node
// has no YAML parser. A pack is trusted operator input, but "trusted" is not
// "unchecked": the SQL must be a single SELECT and it runs on a READ-ONLY
// handle (see db.openReadOnlyDb), so a mistyped statement cannot mutate the
// store. Do not accept packs over the network.
//
// windowMinutes is bound from JS as an ISO string rather than expressed with
// SQLite's datetime() — stored stamps are ISO-8601 with a T and a Z, and
// datetime('now') renders neither, so a SQL-side comparison would silently
// compare unlike strings.

const KINDS = new Set(['min-count', 'max-age-minutes']);
const SELECT_ONLY = /^\s*(select|with)\b/i;
const MIN = 60_000;

const placeholders = (sql) => (sql.match(/\?/g) || []).length;

export function loadPack(text) {
  const pack = JSON.parse(text);
  const expectations = Array.isArray(pack?.expectations) ? pack.expectations : [];
  for (const e of expectations) {
    if (!KINDS.has(e?.kind)) throw new Error(`unknown expectation kind: ${e?.kind}`);
    if (typeof e.sql !== 'string' || !e.sql.trim()) throw new Error(`expectation ${e.name}: missing sql`);
    // The threshold each kind compares against. Without this check a misspelled
    // key ("minimum" for "min") loads clean and then compares against
    // undefined, which is false for every value — a permanent failure no data
    // can clear, reported on every rebuild. Fail at load instead, where the
    // operator is still looking at the pack.
    const threshold = e.kind === 'min-count' ? 'min' : 'maxAgeMinutes';
    if (typeof e[threshold] !== 'number' || !Number.isFinite(e[threshold])) {
      throw new Error(`expectation ${e.name}: missing ${threshold} (a ${e.kind} needs a number to compare against)`);
    }
    if (!SELECT_ONLY.test(e.sql) || e.sql.replace(/;\s*$/, '').includes(';')) {
      throw new Error(`expectation ${e.name}: sql must be a single SELECT`);
    }
    const want = e.windowMinutes ? 1 : 0;
    if (placeholders(e.sql) !== want) {
      throw new Error(
        `expectation ${e.name}: windowMinutes and sql disagree — ${want ? 'expected exactly' : 'expected no'} one ? placeholder`,
      );
    }
  }
  return { expectations };
}

const firstValue = (db, sql, params) => {
  const row = db.prepare(sql).get(...params);
  if (!row) return null;
  const values = Object.values(row);
  return values.length ? values[0] : null;
};

export function evaluate(db, pack, now = Date.now()) {
  return pack.expectations.map((e) => {
    const params = e.windowMinutes
      ? [new Date(now - Number(e.windowMinutes) * 60000).toISOString()]
      : [];
    let value;
    try {
      value = firstValue(db, e.sql, params);
    } catch (err) {
      return { name: e.name, ok: false, detail: `query failed — ${err.message}` };
    }
    const window = e.windowMinutes ? ` in the last ${e.windowMinutes} min` : '';
    if (e.kind === 'min-count') {
      // Number(null) is 0, which is the answer we want here — no rows IS the
      // failure — but it is written out so the intent is not read as an
      // accident (the max-age branch below needs the opposite guard).
      const n = Number(value ?? 0);
      return n >= e.min
        ? { name: e.name, ok: true, detail: `${n} >= ${e.min}${window}` }
        : { name: e.name, ok: false, detail: `${n} < ${e.min}${window}` };
    }
    // max-age-minutes: a missing stamp is stale, never fresh. new Date(null) is
    // the epoch, which would read as "infinitely old" by luck rather than by
    // design, so guard it explicitly.
    if (value == null) {
      return { name: e.name, ok: false, detail: `no rows — older than ${e.maxAgeMinutes} min` };
    }
    const ageMin = Math.floor((now - Date.parse(value)) / 60000);
    return ageMin <= e.maxAgeMinutes
      ? { name: e.name, ok: true, detail: `${ageMin} min old` }
      : { name: e.name, ok: false, detail: `${ageMin} min old — older than ${e.maxAgeMinutes} min` };
  });
}

const agoMin = (iso, now) => (iso ? Math.floor((now - new Date(iso).getTime()) / MIN) : Infinity);

/**
 * Gate expectation notifications on state transition, the same discipline
 * reconcileAlerts() applies to watchdog alerts (server/watchdog.mjs). Every
 * rebuild re-evaluates every expectation, and evaluate() re-reports a
 * persistently failing one every single time — without this, a pack with one
 * stuck expectation reproduces the flood that reconcileAlerts was written to
 * prevent (see that function's doc comment).
 *
 * Only failing expectations are tracked in state; a recovered one is dropped
 * rather than tombstoned, so a condition that returns is genuinely new and
 * notifies again — same rule as reconcileAlerts.
 *
 * @param {object[]} results - current output of evaluate()
 * @param {object|null} prevState - state from the previous call, or null/corrupt
 * @param {{ now?: number, renotifyMin?: number }} [opts]
 * @returns {{ fire: object[], state: object }} fire entries carry `kind`
 */
export function reconcileExpectations(results, prevState, { now = Date.now(), renotifyMin = 0 } = {}) {
  const prev = (prevState && typeof prevState === 'object') ? prevState : {};
  const stamp = new Date(now).toISOString();
  const fire = [];
  const state = {};

  for (const r of Array.isArray(results) ? results : []) {
    const was = prev[r.name];
    if (!r.ok) {
      if (!was || !was.failing) {
        fire.push({ name: r.name, detail: r.detail, kind: 'firing' });
        state[r.name] = { failing: true, lastNotifiedAt: stamp };
        continue;
      }
      const due = renotifyMin > 0 && agoMin(was.lastNotifiedAt, now) >= renotifyMin;
      if (due) fire.push({ name: r.name, detail: r.detail, kind: 'firing' });
      state[r.name] = { failing: true, lastNotifiedAt: due ? stamp : was.lastNotifiedAt };
      continue;
    }
    // ok, and it was not tracked as failing: nothing to do, nothing to notify.
    if (was?.failing) {
      fire.push({ name: r.name, detail: r.detail, kind: 'resolved' });
    }
  }
  return { fire, state };
}

/**
 * Render reconciled expectations as notifications.json entries. The contract
 * is the one alertsToNotifications already publishes — { ts, title, message,
 * status } — because app.js renders exactly those fields; an
 * { at, level, text } entry would merge into the feed and draw an empty card.
 *
 * @param {object[]} fire - `fire` from reconcileExpectations
 * @param {number} [now]
 */
export function toNotifications(fire, now = Date.now()) {
  const ts = new Date(now).toISOString();
  return (Array.isArray(fire) ? fire : []).map((r) => (r.kind === 'resolved' ? {
    ts,
    title: `Expectation recovered: ${r.name}`,
    message: 'The condition that triggered this failure is no longer true.',
    status: 'success',
  } : {
    ts,
    title: `Expectation failed: ${r.name}`,
    message: r.detail,
    status: 'failure',
  }));
}

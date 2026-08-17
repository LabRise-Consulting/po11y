// The only code that talks to n8n. Two different data classes, two different
// mechanisms on purpose:
//   structure (workflow definitions) — changes rarely, pull is correct;
//   events (executions) — pushed when the instance can, polled as the baseline
//   that every edition supports.
// Both land in the same store, so the feed builders never learn which arrived
// how.
import { fetchAllWorkflows, fetchExecutions } from './n8n.mjs';
import {
  upsertWorkflows, upsertExecutions, pruneExecutions, pruneDatatableCounts,
  pruneWorkflowsNotSeenSince, setKv,
} from './db.mjs';

const DAY_MS = 86_400_000;

/**
 * kv key holding the ISO stamp of the last executions poll that actually
 * reached n8n. Exported so index.mjs's /metrics reader and pollFill's writer
 * cannot drift onto two spellings of the same key.
 */
export const POLL_LAST_SUCCESS_KEY = 'poll-last-success';

/**
 * Wrap a fetch so the GET-only promise is enforced in code, not just in review.
 * n8n.mjs's apiGet enforces the same invariant for its own calls.
 */
export function assertGetOnly(fetchFn) {
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new Error(`GET-only: refusing ${method} ${url}`);
    }
    return fetchFn(url, init);
  };
}

/**
 * Wrap a fetch so every call carries a deadline. n8n accepting a connection and
 * then never answering is indistinguishable, from here, from a slow instance —
 * both hang forever, and Node's fetch has no default timeout. The tick loop
 * re-arms only after a tick settles (timers.mjs), so an unbounded fetch stops
 * the loop outright: one stalled request and the store never updates again,
 * with nothing logged. A deadline turns that into an ordinary failure the
 * health counters already know how to report.
 *
 * The signal is created per call, not per wrap: a single shared signal would
 * abort every request `ms` after start-up.
 */
export function withTimeout(fetchFn, ms) {
  return (url, init = {}) => fetchFn(url, {
    ...init,
    // An explicit caller signal wins — nothing passes one today, but silently
    // dropping it later would be the kind of bug this file exists to avoid.
    signal: init.signal ?? AbortSignal.timeout(ms),
  });
}

/**
 * Any store row NOT touched by this call (its seen_at stays behind the stamp
 * this sync just wrote) is a workflow deleted or archived on n8n since the
 * last sync, and is pruned. Unlike executions, workflows have no separate
 * retention window: staleness here means "no longer exists", not "old", so the
 * prune runs on every non-empty sync rather than on a days-based cutoff.
 *
 * Two things must be true before a prune is safe, and only one of them is
 * free. On a throw (n8n unreachable, a bad page) this function never reaches
 * the prune at all — an outage is not a mass delete. But fetchAllWorkflows
 * does NOT throw on every non-answer: it appends only when a page carries a
 * `data` array, so a 200 whose body has none (a proxy rewriting the response,
 * an error page served with the wrong status, a key scoped away from
 * workflows) returns [] and looks exactly like "n8n has no workflows". Pruning
 * on that empties map.json/forms.json and leaves evaluateAlerts() iterating
 * nothing, so reconcileAlerts resolves every open alert and publishes a false
 * all-clear. An empty list is therefore treated as no answer: the upsert is a
 * no-op anyway, and the prune is skipped.
 *
 * The cost of the guard is that emptying the last workflow off an instance
 * deliberately leaves a stale row until something is created again — a visible
 * ghost, which is the failure worth having.
 */
export async function syncWorkflows(db, fetchFn, baseUrl, apiKey, now = Date.now()) {
  const workflows = await fetchAllWorkflows(assertGetOnly(fetchFn), baseUrl, apiKey);
  const stamp = new Date(now).toISOString();
  const n = upsertWorkflows(db, workflows, stamp);
  if (workflows.length) pruneWorkflowsNotSeenSince(db, stamp);
  return n;
}

/**
 * Fetch the recent-executions window, store it, and stamp POLL_LAST_SUCCESS_KEY
 * — but ONLY on evidence that n8n actually answered.
 *
 * The stamp is the source of po11y_poll_last_success_timestamp_seconds, and it
 * lives here rather than in the caller on purpose. It used to be a separate
 * `setKv` on the line after this call, and fetchExecutions' default
 * swallow-and-return-[] made every outage (n8n down, key revoked, DNS gone,
 * request timed out) arrive as an empty list — so the upsert succeeded, the
 * stamp refreshed, and the gauge reported "polled fine 30 seconds ago" for as
 * long as the process lived. Po11yPollStalled could then never fire: not while
 * the server ran, and not when it was down either (the series simply goes
 * away). Owning the write here makes that unforgettable: there is no longer a
 * caller that could stamp without the evidence.
 *
 * `strict: true` surfaces the failure; catching it HERE keeps the shape the
 * tick relies on — a failed executions poll must not abort the datatable
 * sampling, the prune or the rebuild that follow it in the same tick.
 *
 * On failure the store is left completely alone, so the previous stamp ages
 * and the alert can fire. That is the whole point.
 *
 * @returns {Promise<{ok: boolean, n: number, error: (Error|null)}>}
 */
export async function pollFill(db, fetchFn, baseUrl, apiKey, limit, now = Date.now()) {
  let executions;
  try {
    executions = await fetchExecutions(assertGetOnly(fetchFn), baseUrl, apiKey, limit, { strict: true });
  } catch (error) {
    return { ok: false, n: 0, error };
  }
  // Second listing, because n8n's default one is finished-only: an execution
  // that is still going appears ONLY under ?status=running. Without this the
  // store never holds a running row, and everything downstream of that —
  // po11y_workflow_running_seconds, the watchdog's `stuck` rule, the
  // dashboard's live indicator — reads a confident zero forever.
  //
  // Supplementary, so a failure here is logged and dropped rather than failing
  // the tick: the finished window is what the poll's stamp attests to. A row
  // left stale at 'running' self-heals, because the execution shows up in the
  // ordinary listing with its terminal status once it ends.
  let running = [];
  try {
    running = await fetchExecutions(assertGetOnly(fetchFn), baseUrl, apiKey, limit, { strict: true, status: 'running' });
  } catch (e) {
    console.error(`server: running-executions listing failed — ${e.message}; live-run state may be stale`);
  }
  const n = upsertExecutions(db, [...executions, ...running]);
  setKv(db, POLL_LAST_SUCCESS_KEY, new Date(now).toISOString());
  return { ok: true, n, error: null };
}

/**
 * Retention. `days <= 0` disables pruning rather than deleting everything: the
 * dangerous reading of a zero must never be the one a typo selects. Covers
 * both series that accumulate without bound over time — executions and (if
 * PO11Y_DATATABLES is set) datatable_counts — under the one knob,
 * PO11Y_RETENTION_DAYS, so an operator does not need a second variable to
 * bound the newer series.
 */
export function pruneOlderThan(db, days, now = Date.now()) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(now - d * DAY_MS).toISOString();
  return pruneExecutions(db, cutoff) + pruneDatatableCounts(db, cutoff);
}

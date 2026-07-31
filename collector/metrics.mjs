// Prometheus text exposition for the Mode B collector.
//
// SECURITY: like watchdog.mjs, this module makes NO network calls and touches
// NO filesystem — its one import, exec-status.mjs, is a pure predicate with no
// imports of its own. It is pure computation over data collect.mjs already fetched
// (GET-only) and returns a string the caller serves. The n8n API key is never
// passed in and can never appear in the output; the exported series carry
// workflow ids, names and timestamps only — a strict subset of what map.json
// already publishes to the same dashboard volume.
//
// WHY THE ERROR COUNTER IS ACCUMULATED HERE rather than read off the window:
// fetchExecutions asks for ?limit=100, so the watchdog's per-workflow `errors`
// is a count within a SLIDING window and falls as the window moves. Exporting
// that as `_total` would be a lie Prometheus acts on — rate()/increase() read
// any decrease as a counter reset and emit a bogus spike. So we accumulate
// across polls and only ever count up. A process restart resets the counters to
// zero, which is a genuine counter reset and exactly what Prometheus expects.

import { isFailed } from './exec-status.mjs';

/** Escape a label value per the exposition format. Backslash MUST go first. */
export function escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Fold this poll's executions into monotonic per-workflow error totals.
 *
 * The dedupe key is "execution ids already counted AS ERRORS", not "ids already
 * seen": an execution can be `running` at one poll and `error` at the next, and
 * keying on sightings would silently drop exactly those. The counted set is
 * pruned to ids still present in the window — an id that leaves a sliding
 * window can never re-enter — which bounds memory at the window size.
 *
 * @param {{counted: Set<string>, totals: Map<string, number>}|null} prev
 * @param {object[]} executions - raw `data` from /api/v1/executions
 * @returns {{counted: Set<string>, totals: Map<string, number>}}
 */
export function accumulateErrors(prev, executions) {
  const list = Array.isArray(executions) ? executions : [];
  const totals = new Map(prev?.totals ?? []);

  const windowIds = new Set();
  for (const e of list) {
    const id = String(e?.id ?? '');
    if (id) windowIds.add(id);
  }

  const counted = new Set();
  for (const id of prev?.counted ?? []) if (windowIds.has(id)) counted.add(id);

  for (const e of list) {
    if (!isFailed(e)) continue;
    const id = String(e.id ?? '');
    const wf = String(e.workflowId ?? '');
    if (!id || !wf || counted.has(id)) continue;
    counted.add(id);
    totals.set(wf, (totals.get(wf) || 0) + 1);
  }
  return { counted, totals };
}

/**
 * Assemble the snapshot the HTTP handler renders.
 *
 * Driven by the CURRENT workflow list, so a deleted workflow's series stop
 * being exported rather than lingering forever as a stale total.
 *
 * @param {object[]} workflows - the list already fetched this poll
 * @param {Map<string, object>} summary - from watchdog.summarizeExecutions
 * @param {Map<string, number>} totals - from accumulateErrors
 * @param {{now?: number, n8nUp?: number, pollLastSuccessMs?: number|null}} [opts]
 */
export function buildSnapshot(workflows, summary, totals, opts = {}) {
  const { now = Date.now(), n8nUp = 0, pollLastSuccessMs = null } = opts;
  const sum = summary instanceof Map ? summary : new Map();
  const tot = totals instanceof Map ? totals : new Map();

  const out = [];
  for (const w of Array.isArray(workflows) ? workflows : []) {
    const id = String(w?.id ?? '');
    if (!id) continue;
    const s = sum.get(id);
    // Oldest running execution: that is the one a "stuck" threshold is about.
    const runningSeconds = s?.running?.length
      ? Math.max(...s.running.map((r) => Math.floor((now - Date.parse(r.startedAt)) / 1000)))
      : 0;
    out.push({
      id,
      name: w.name || id,
      errorsTotal: tot.get(id) || 0,
      lastOkAtMs: s?.lastOkAt ? Date.parse(s.lastOkAt) : null,
      runningSeconds: Number.isFinite(runningSeconds) ? Math.max(0, runningSeconds) : 0,
    });
  }
  return { n8nUp: n8nUp ? 1 : 0, pollLastSuccessMs, workflows: out };
}

const META = [
  ['po11y_n8n_up', 'gauge', 'Whether the last poll reached the n8n API (1) or not (0).'],
  ['po11y_poll_last_success_timestamp_seconds', 'gauge', 'Unix time of the last successful poll.'],
  ['po11y_workflow_errors_total', 'counter', 'Failed (error or crashed) executions observed for a workflow since collector start.'],
  ['po11y_workflow_last_success_timestamp_seconds', 'gauge', 'Unix time of a workflow\'s last successful execution.'],
  ['po11y_workflow_running_seconds', 'gauge', 'Age of the oldest currently-running execution of a workflow, in seconds.'],
];

/** Unix seconds, millisecond precision preserved. */
const secs = (ms) => ms / 1000;

/**
 * Render a snapshot as Prometheus text exposition (version 0.0.4).
 *
 * HELP/TYPE are emitted for every metric even when it has no series, so a
 * scrape of an empty instance still documents the contract.
 *
 * @param {{n8nUp: number, pollLastSuccessMs: number|null, workflows: object[]}} snapshot
 * @returns {string}
 */
export function renderMetrics(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const workflows = Array.isArray(snap.workflows) ? snap.workflows : [];
  const meta = new Map(META.map(([n, t, h]) => [n, `# HELP ${n} ${h}\n# TYPE ${n} ${t}`]));
  const lines = [];

  lines.push(meta.get('po11y_n8n_up'));
  lines.push(`po11y_n8n_up ${snap.n8nUp ? 1 : 0}`);

  lines.push(meta.get('po11y_poll_last_success_timestamp_seconds'));
  if (Number.isFinite(snap.pollLastSuccessMs)) {
    lines.push(`po11y_poll_last_success_timestamp_seconds ${secs(snap.pollLastSuccessMs)}`);
  }

  const labels = (w) => `{workflow_id="${escapeLabelValue(w.id)}",workflow_name="${escapeLabelValue(w.name)}"}`;

  lines.push(meta.get('po11y_workflow_errors_total'));
  for (const w of workflows) lines.push(`po11y_workflow_errors_total${labels(w)} ${w.errorsTotal || 0}`);

  // Omitted rather than zero-filled when a workflow has never succeeded: a 0
  // here means 1970, so `time() - last_success > budget` would fire instantly
  // on every workflow that has simply not run yet. Absence is handled in the
  // rule file instead, where it can be reasoned about explicitly.
  lines.push(meta.get('po11y_workflow_last_success_timestamp_seconds'));
  for (const w of workflows) {
    if (!Number.isFinite(w.lastOkAtMs)) continue;
    lines.push(`po11y_workflow_last_success_timestamp_seconds${labels(w)} ${secs(w.lastOkAtMs)}`);
  }

  lines.push(meta.get('po11y_workflow_running_seconds'));
  for (const w of workflows) lines.push(`po11y_workflow_running_seconds${labels(w)} ${w.runningSeconds || 0}`);

  return `${lines.join('\n')}\n`;
}

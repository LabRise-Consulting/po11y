// One definition of "this execution failed", shared by every consumer.
//
// n8n's execution_entity.status is an enum: new, running, waiting, success,
// error, crashed, canceled. TWO of those are failures. `crashed` is what n8n
// writes when the process died mid-run — an OOM kill, a container restart, a
// worker lost in queue mode — as opposed to `error`, which is a node throwing.
// Both mean the run did not produce its result, and the operator wants to hear
// about both.
//
// This lives in its own module because it was previously spelled out three
// times (n8n.mjs's status.json summary, watchdog.mjs's alert summary, and the
// Prometheus counter), all three said `=== 'error'`, and all three were wrong
// in the same way while the shipped Grafana SQL said
// `status IN ('error', 'crashed')` in six separate queries. A crashed run was
// invisible to alerting and to the feed while showing up red in Grafana.
//
// Current consumers, keep this list honest:
//   n8n.mjs        status.json's failed-execution summary  (isFailed)
//   watchdog.mjs   the `failing` alert rule                (isFailed)
//   db.mjs         the workflow_error_totals triggers      (FAILED_STATUSES)
//
// metrics.mjs is deliberately NOT on that list any more and must not be added
// back: since the counter moved into the store it renders
// po11y_workflow_errors_total straight from workflow_error_totals, so the set
// reaches it through db.mjs's triggers. Those triggers compose their SQL from
// FAILED_STATUSES below — adding a status here must never be a change the
// counter silently ignores, which is what happened when the triggers spelled
// the list out for a fourth time.
//
// Deliberately NOT failures:
//   canceled  a human stopped it; that is an intent, not a fault
//   waiting   a Wait node is holding it, it has not finished either way
//   new/running  not finished
//
// Pure: no imports, no I/O. Safe for watchdog.mjs and metrics.mjs, which both
// document that they make no network calls and touch no filesystem.

/** n8n execution statuses that mean "this run did not deliver its result". */
export const FAILED_STATUSES = Object.freeze(['error', 'crashed']);

const FAILED = new Set(FAILED_STATUSES);

/**
 * Did this execution fail?
 *
 * @param {{status?: string}|null|undefined} execution
 * @returns {boolean}
 */
export function isFailed(execution) {
  return FAILED.has(execution?.status);
}

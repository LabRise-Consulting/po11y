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
// times (collect.mjs's status.json summary, watchdog.mjs's alert summary,
// metrics.mjs's Prometheus counter), all three said `=== 'error'`, and all
// three were wrong in the same way while the shipped Grafana SQL said
// `status IN ('error', 'crashed')` in six separate queries. A crashed run was
// invisible to alerting and to the feed while showing up red in Grafana.
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

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

// The denominator under FAILED_STATUSES: runs that reached a verdict of their
// own, either way. Derived from FAILED_STATUSES rather than spelled out, so
// every failed status is a finished status by construction — that containment
// is what makes errors/executions a rate bounded by 1 rather than two counters
// that happen to be near each other.
//
// `canceled` is deliberately NOT here, for the same reason it is not a failure:
// a human stopped the run, so it never reached a verdict. Counting it in the
// denominator would make every cancellation read as a dip in success rate.
// `new`, `running` and `waiting` are not finished at all.
//
// Consumer: db.mjs's workflow_execution_totals triggers.

/** n8n execution statuses that mean "this run finished on its own, either way". */
export const FINISHED_STATUSES = Object.freeze(['success', ...FAILED_STATUSES]);

/**
 * Did this execution fail?
 *
 * @param {{status?: string}|null|undefined} execution
 * @returns {boolean}
 */
export function isFailed(execution) {
  return FAILED.has(execution?.status);
}

// How the run was started, from n8n's execution_entity.mode enum: cli, error,
// evaluation, integrated, internal, manual, retry, trigger, webhook.
//
// TWO of those are a person at the keyboard rather than the workflow doing its
// job, and counting them corrupts alerting in both directions: a handful of
// failed editor runs while debugging reads as an outage, and — the worse half —
// one manual success on a schedule that has been dead for a week refreshes
// `lastOkAt`, so the staleness rule sees a healthy workflow. That is the same
// false-all-clear shape the rest of this server is built to avoid.
//
// `integrated` is deliberately production: a sub-workflow may have no other way
// to run, and excluding it would make every one of them permanently stale.
// `retry` and `error` are production too — a retry that succeeds is real
// recovery, and an error workflow's own runs are its real work.
//
// An execution with no mode at all counts as production. Old rows and reduced
// API payloads land there, and the safe direction for an unknown is to keep
// evaluating it rather than to fall silent about it.
//
// Consumer: alerts.mjs, which filters the window before the watchdog folds it.
// status.json deliberately does NOT filter — the dashboard's execution summary
// shows what actually ran, manual runs included.

/** n8n execution modes that mean "a human did this by hand". */
export const NON_PRODUCTION_MODES = Object.freeze(['manual', 'evaluation']);

const HAND_RUN = new Set(NON_PRODUCTION_MODES);

/**
 * Did this execution happen as production work, rather than by hand?
 *
 * @param {{mode?: string}|null|undefined} execution
 * @returns {boolean}
 */
export function isProduction(execution) {
  return !HAND_RUN.has(execution?.mode);
}

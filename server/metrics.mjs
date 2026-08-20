// Prometheus text exposition, derived from the store.
//
// SECURITY: this module makes no network calls and touches no filesystem. It is
// pure computation over rows the server already holds, and returns a string the
// caller serves. The n8n API key is never passed in and can never appear in the
// output; the exported series carry workflow ids, names and timestamps only — a
// strict subset of what map.json already publishes to the same dashboard.
//
// The exposition half below is the (now-retired) collector's renderer,
// moved over unchanged: the series names, label sets, types and HELP
// strings are a contract that observability/alerts.yml and every operator
// query already depend on.
import { allWorkflows, errorTotals, executionTotals, lastSuccessByWorkflow, oldestRunningByWorkflow } from './db.mjs';

/** Escape a label value per the exposition format. Backslash MUST go first. */
export function escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Assemble the snapshot the HTTP route renders.
 *
 * Driven by the CURRENT workflow list, so a deleted workflow's series stop
 * being exported rather than lingering forever as a stale total.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, n8nUp?: number, pollLastSuccessMs?: number|null,
 *          aiMapLlmUp?: number|null}} opts
 */
export function buildSnapshot(db, {
  now = Date.now(), n8nUp = 0, pollLastSuccessMs = null, aiMapLlmUp = null,
} = {}) {
  const totals = errorTotals(db);
  const runs = executionTotals(db);
  const lastOk = lastSuccessByWorkflow(db);
  const running = oldestRunningByWorkflow(db, now);

  const out = [];
  for (const w of allWorkflows(db)) {
    const id = String(w?.id ?? '');
    if (!id) continue;
    out.push({
      id,
      name: w.name || id,
      errorsTotal: totals.get(id) || 0,
      executionsTotal: runs.get(id) || 0,
      lastOkAtMs: lastOk.get(id) ?? null,
      runningSeconds: running.get(id) || 0,
    });
  }
  return {
    n8nUp: n8nUp ? 1 : 0,
    pollLastSuccessMs,
    aiMapLlmUp: aiMapLlmUp == null ? null : (aiMapLlmUp ? 1 : 0),
    workflows: out,
  };
}

/**
 * Read an ai-map build outcome as the po11y_ai_map_llm_up sample.
 *
 * `aiConfigured` gates everything: a deployment with no LLM wired up has
 * nothing to be down, and must export no series at all rather than a 0 that
 * alerts on a correctly-configured stack forever.
 *
 * The `action` check is what keeps this honest. buildAiMap returns early on
 * republish / keep-annotated / skip-fresh WITHOUT calling the LLM, so a null
 * `degraded` on those rebuilds says nothing about the gateway — reading it as
 * "up" would clear a genuinely dead provider for as long as the workflow set
 * stays unchanged. Only a 'publish' actually went to the LLM; every other
 * action carries the previous reading forward untouched.
 *
 * @param {{aiConfigured?: boolean, action?: string|null, degraded?: string|null,
 *          previous?: 1|0|null}} outcome
 * @returns {1|0|null} 1 up, 0 degraded, null nothing to report
 */
export function aiMapLlmUpFrom({
  aiConfigured = false, action = null, degraded = null, previous = null,
} = {}) {
  if (!aiConfigured) return null;
  if (degraded) return 0;
  if (action === 'publish') return 1;
  return previous;
}

const META = [
  ['po11y_n8n_up', 'gauge', 'Whether the last poll reached the n8n API (1) or not (0).'],
  ['po11y_poll_last_success_timestamp_seconds', 'gauge', 'Unix time of the last successful poll.'],
  ['po11y_workflow_errors_total', 'counter', 'Failed (error or crashed) executions observed for a workflow.'],
  ['po11y_workflow_executions_total', 'counter', 'Executions observed finishing for a workflow, successful or failed. The denominator under po11y_workflow_errors_total.'],
  ['po11y_workflow_last_success_timestamp_seconds', 'gauge', 'Unix time of a workflow\'s last successful execution.'],
  ['po11y_workflow_running_seconds', 'gauge', 'Age of the oldest currently-running execution of a workflow, in seconds.'],
  ['po11y_ai_map_llm_up', 'gauge', 'Whether the last ai-map build got LLM prose (1) or fell back to the heuristic (0). Absent when no LLM is configured.'],
];

const secs = (ms) => (ms == null ? null : Math.floor(ms / 1000));
const labels = (w) => `{workflow_id="${escapeLabelValue(w.id)}",workflow_name="${escapeLabelValue(w.name)}"}`;

/** @param {ReturnType<typeof buildSnapshot>} snap */
export function renderMetrics(snap) {
  const workflows = Array.isArray(snap?.workflows) ? snap.workflows : [];
  const meta = new Map(META.map(([n, t, h]) => [n, `# HELP ${n} ${h}\n# TYPE ${n} ${t}`]));
  const lines = [];

  lines.push(meta.get('po11y_n8n_up'));
  lines.push(`po11y_n8n_up ${snap?.n8nUp ? 1 : 0}`);

  lines.push(meta.get('po11y_poll_last_success_timestamp_seconds'));
  // Absent, not 0: 0 is 1970, and a dashboard would read it as "last succeeded
  // 56 years ago" rather than "never succeeded".
  if (snap?.pollLastSuccessMs != null) {
    lines.push(`po11y_poll_last_success_timestamp_seconds ${secs(snap.pollLastSuccessMs)}`);
  }

  lines.push(meta.get('po11y_workflow_errors_total'));
  for (const w of workflows) lines.push(`po11y_workflow_errors_total${labels(w)} ${w.errorsTotal || 0}`);

  lines.push(meta.get('po11y_workflow_executions_total'));
  for (const w of workflows) lines.push(`po11y_workflow_executions_total${labels(w)} ${w.executionsTotal || 0}`);

  lines.push(meta.get('po11y_workflow_last_success_timestamp_seconds'));
  for (const w of workflows) {
    if (w.lastOkAtMs == null) continue;
    lines.push(`po11y_workflow_last_success_timestamp_seconds${labels(w)} ${secs(w.lastOkAtMs)}`);
  }

  lines.push(meta.get('po11y_workflow_running_seconds'));
  for (const w of workflows) lines.push(`po11y_workflow_running_seconds${labels(w)} ${w.runningSeconds || 0}`);

  // Absent when no LLM is configured — see the note on the alert rule. The
  // HELP/TYPE header goes inside the guard so it never appears without a sample.
  if (snap?.aiMapLlmUp != null) {
    lines.push(meta.get('po11y_ai_map_llm_up'));
    lines.push(`po11y_ai_map_llm_up ${snap.aiMapLlmUp ? 1 : 0}`);
  }

  return `${lines.join('\n')}\n`;
}

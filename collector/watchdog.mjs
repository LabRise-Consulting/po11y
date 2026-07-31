// Mode B watchdog — turn the execution list the collector already fetches into
// alerts, and alerts into notifications.json entries.
//
// Three rules, matching what self-hosters actually ask for:
//   failing — a workflow is erroring at/over a threshold in the recent window
//   stale   — a workflow has not SUCCEEDED for longer than its budget
//   stuck   — an execution has been `running` longer than its budget
//
// SECURITY: this module makes no network calls at all. It is pure computation
// over data fetched by collect.mjs (GET-only) and writes nothing itself; the
// caller publishes the result through the existing notifications.json feed. The
// collector's "no write path to n8n" invariant is untouched by design.
//
// Deliberately NOT here: node-level error payloads. Fetching those means
// /executions/{id}?includeData=true, which pulls real business data out of n8n
// and across the trust boundary — the opposite of Mode B's posture.

import { isFailed } from './exec-status.mjs';

const MIN = 60_000;

/** Newest of two ISO stamps, either of which may be null. */
const newer = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);

/**
 * Fold a raw execution list into a per-workflow summary.
 *
 * Every workflow that appears is kept — no top-N truncation. status.json's
 * `byWorkflow` slices to 10 for display, and alerting off that list would mean
 * workflow #11 could fail forever in silence.
 *
 * `lastAt` and `lastOkAt` are tracked separately: a workflow failing every five
 * minutes has a very fresh `lastAt`, so a staleness check built on it would
 * never fire on exactly the workflow that needs it.
 *
 * @param {object[]} executions - raw `data` from /api/v1/executions
 * @param {{ now?: number, names?: Map<string,string>|null }} [opts]
 * @returns {Map<string, {id: string, name: string, count: number, errors: number,
 *   lastAt: (string|null), lastOkAt: (string|null),
 *   running: {id: string, startedAt: string, ageMin: number}[]}>}
 */
export function summarizeExecutions(executions, { now = Date.now(), names = null } = {}) {
  const byId = new Map();
  for (const e of Array.isArray(executions) ? executions : []) {
    const id = String(e.workflowId ?? '');
    if (!id) continue;
    const name = e.workflowName || (e.workflowData || {}).name || names?.get(id) || id;
    const at = e.startedAt || e.stoppedAt || e.createdAt || null;

    let g = byId.get(id);
    if (!g) {
      g = { id, name, count: 0, errors: 0, lastAt: null, lastOkAt: null, running: [] };
      byId.set(id, g);
    }
    if (g.name === id && name !== id) g.name = name; // upgrade id -> real name
    g.count += 1;
    if (isFailed(e)) g.errors += 1;
    if (e.status === 'success') g.lastOkAt = newer(g.lastOkAt, at);
    if (e.status === 'running' && at) {
      g.running.push({ id: String(e.id ?? ''), startedAt: at, ageMin: Math.floor((now - new Date(at).getTime()) / MIN) });
    }
    g.lastAt = newer(g.lastAt, at);
  }
  return byId;
}

/** Minutes between an ISO stamp and `now`; Infinity when the stamp is missing. */
const agoMin = (iso, now) => (iso ? Math.floor((now - new Date(iso).getTime()) / MIN) : Infinity);

/**
 * Resolve a budget for one workflow: a `perWorkflow` entry keyed by name or by
 * id wins over the global default. An explicit 0 disables that rule for that
 * workflow, which is why this distinguishes "absent" from "zero".
 */
function budget(cfg, w, key) {
  const over = cfg.perWorkflow?.[w.name] ?? cfg.perWorkflow?.[w.id];
  const v = over?.[key] ?? cfg[key];
  return Number(v) || 0; // absent/0/NaN all mean "rule off"
}

/**
 * Apply the three rules to a summary and return the alerts currently true.
 *
 * This is a snapshot of *current* state, not an event stream — the same alert
 * recurs on every poll while the condition holds. reconcileAlerts() is what
 * turns that into "notify once".
 *
 * @param {Map<string, object>} summary - from summarizeExecutions
 * @param {object[]} workflows - the workflow list already fetched this poll
 * @param {object} cfg - the `alerts` block of config
 * @param {{ now?: number }} [opts]
 * @returns {{rule: string, workflowId: string, workflowName: string,
 *   severity: string, title: string, message: string, since: (string|null)}[]}
 */
export function evaluateAlerts(summary, workflows, cfg = {}, { now = Date.now() } = {}) {
  if (!cfg.enabled) return [];
  const out = [];
  const ignore = new Set(cfg.ignore || []);
  const minErrors = Number(cfg.minErrors ?? 3);
  const errorRate = Number(cfg.errorRate ?? 0.5);

  for (const w of Array.isArray(workflows) ? workflows : []) {
    const id = String(w.id ?? '');
    const name = w.name || id;
    if (ignore.has(name) || ignore.has(id)) continue;
    const s = summary.get(id);

    // failing — enough errors to matter AND a high enough share of the window.
    // Both floors are needed: the count alone spams on busy instances, the rate
    // alone fires on a workflow that ran once and failed once.
    if (s && s.errors >= minErrors && s.errors / s.count >= errorRate) {
      out.push({
        rule: 'failing', workflowId: id, workflowName: name, severity: 'failure',
        title: `${name} is failing`,
        message: `${s.errors} of the last ${s.count} executions errored.`,
        since: s.lastOkAt,
      });
    }

    // stale — no SUCCESS inside the budget. Applies to active workflows only.
    // With no successes on record we measure from updatedAt, so a workflow that
    // has been erroring since before the window still ages into an alert, and a
    // freshly-activated one gets its full budget before it can fire.
    const staleAfterMin = budget(cfg, { id, name }, 'staleAfterMin');
    if (staleAfterMin && w.active !== false) {
      const ref = s?.lastOkAt || w.updatedAt || null;
      const age = agoMin(ref, now);
      if (age >= staleAfterMin) {
        out.push({
          rule: 'stale', workflowId: id, workflowName: name, severity: 'failure',
          title: `${name} has not succeeded recently`,
          message: s?.lastOkAt
            ? `Last success was ${age} min ago (budget ${staleAfterMin} min).`
            : `No successful execution on record (budget ${staleAfterMin} min).`,
          since: ref,
        });
      }
    }

    // stuck — an execution still `running` past the budget. Usually a webhook
    // or HTTP call that never resolved; it never becomes an error, so nothing
    // else in this file would ever notice it.
    const stuckAfterMin = budget(cfg, { id, name }, 'stuckAfterMin');
    if (stuckAfterMin && s?.running?.length) {
      const hung = s.running.filter((r) => r.ageMin >= stuckAfterMin);
      if (hung.length) {
        out.push({
          rule: 'stuck', workflowId: id, workflowName: name, severity: 'failure',
          // The oldest hung execution is the one worth linking to; the rest are
          // named in the message. Carried as a field, not parsed back out of
          // the prose, so alertLink never has to reverse-engineer the message.
          executionId: hung[0].id || '',
          title: `${name} has a stuck execution`,
          message: `${hung.length} execution(s) running past ${stuckAfterMin} min: ${hung.map((r) => `#${r.id} (${r.ageMin}m)`).join(', ')}.`,
          since: hung[0].startedAt,
        });
      }
    }
  }
  return out;
}

/**
 * The alert for "the collector could not complete a poll at all".
 *
 * The three rules above are derived from data fetched out of n8n, so when n8n
 * itself is down, hung, or rejecting the API key there is nothing to evaluate
 * and every rule goes quiet on exactly the outage that matters most. This is
 * the alert that covers that gap, and it is deliberately shaped like the
 * others so reconcileAlerts() gives it dedupe, renotify and recovery for free.
 *
 * `workflowId` is empty on purpose: there is no workflow to link to, and
 * alertsToNotifications() only emits an href when it has an id, so a firing
 * unreachable alert renders as text rather than a button that 404s.
 *
 * The message is scrubbed of the n8n base URL. The stderr line the caller also
 * writes is operator-only, but this string is published into notifications.json
 * (which the dashboard serves) and pushed to a chat webhook, so an internal
 * hostname must not ride along with it.
 *
 * @param {any} err - whatever poll() threw
 * @param {{ baseUrl?: string }} [opts]
 * @returns {object} an alert in the same shape evaluateAlerts returns
 */
export function unreachableAlert(err, { baseUrl = '' } = {}) {
  let detail = String(err?.message || err || 'unknown error');
  const root = String(baseUrl || '');
  for (const form of new Set([root, root.replace(/\/$/, '')])) {
    if (form) detail = detail.split(form).join('the n8n API');
  }
  return {
    rule: 'unreachable',
    workflowId: '',
    workflowName: 'n8n',
    severity: 'failure',
    title: 'Cannot reach n8n',
    message: `The collector could not complete a poll — ${detail}`,
    since: null,
  };
}

/**
 * The deepest n8n URL this alert can justify, or null.
 *
 * One definition shared by the feed and the chat push, so the two can never
 * point somewhere different for the same alert. `stuck` names an execution and
 * gets an execution link — the whole value of a chat alert is being one click
 * from the thing that broke, and "open the workflow, now find the run" is a
 * step too many at 3am. Every other rule is about the workflow as a whole.
 *
 * Returns null rather than a partial URL: the dashboard renders `link` as a
 * live button, so a half-formed href is worse than no href.
 *
 * @param {object} alert
 * @param {string} baseUrl - the n8n root; trailing slash optional
 * @returns {string|null}
 */
export function alertLink(alert, baseUrl) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const wf = alert?.workflowId;
  if (!root || !wf) return null;
  const url = `${root}/workflow/${encodeURIComponent(wf)}`;
  return alert.executionId
    ? `${url}/executions/${encodeURIComponent(alert.executionId)}`
    : url;
}

/**
 * Turn the snapshot from evaluateAlerts into "what should we say right now".
 *
 * Without this the collector would re-announce every open alert on every poll —
 * every POLL_INTERVAL, forever — which is how a notification feed becomes
 * something people stop reading. State is a plain JSON-serialisable object so
 * the caller can persist it across restarts; a restart must not re-spam.
 *
 * Resolved keys are dropped from state rather than tombstoned, so a condition
 * that comes back is genuinely new and notifies again.
 *
 * `rules` narrows what this pass is *authoritative* for. A failed poll can only
 * speak to reachability — it fetched no workflows and no executions — so
 * reconciling the whole state against its one-alert list would declare every
 * open workflow alert recovered, then re-announce all of them the moment n8n
 * came back. Keys outside the scope are carried forward verbatim instead. A
 * successful poll passes no scope, because it really does see everything.
 *
 * @param {object[]} alerts - current output of evaluateAlerts
 * @param {object|null} prevState - state from the previous call, or null
 * @param {{ now?: number, renotifyMin?: number, rules?: (string[]|null) }} [opts]
 * @returns {{ fire: object[], state: object }} fire entries carry `kind`
 */
export function reconcileAlerts(alerts, prevState, { now = Date.now(), renotifyMin = 0, rules = null } = {}) {
  const prev = (prevState && typeof prevState === 'object') ? prevState : {};
  const owns = Array.isArray(rules) ? new Set(rules) : null;
  const stamp = new Date(now).toISOString();
  const key = (a) => `${a.rule}:${a.workflowId}`;
  const fire = [];
  const state = {};

  for (const a of Array.isArray(alerts) ? alerts : []) {
    const k = key(a);
    const was = prev[k];
    if (!was) {
      fire.push({ ...a, kind: 'firing' });
      state[k] = { firstSeen: stamp, lastNotified: stamp, workflowName: a.workflowName };
      continue;
    }
    const due = renotifyMin > 0 && agoMin(was.lastNotified, now) >= renotifyMin;
    if (due) fire.push({ ...a, kind: 'firing' });
    // workflowName is carried in state so a recovery — which by definition has
    // no live alert to read it from — can still name the workflow rather than
    // echoing an opaque n8n id.
    state[k] = {
      firstSeen: was.firstSeen || stamp,
      lastNotified: due ? stamp : was.lastNotified,
      workflowName: a.workflowName,
    };
  }

  // Anything we were tracking that is no longer true has recovered.
  const live = new Set(Object.keys(state));
  for (const k of Object.keys(prev)) {
    if (live.has(k)) continue;
    const [rule, workflowId] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    // Outside this pass's scope: it had no data on that rule, so silence is not
    // evidence of recovery. Carry the entry forward untouched.
    if (owns && !owns.has(rule)) { state[k] = prev[k]; continue; }
    fire.push({
      rule, workflowId, workflowName: prev[k].workflowName || workflowId,
      severity: 'success', title: `${prev[k].workflowName || workflowId} recovered`,
      message: 'The condition that triggered this alert is no longer true.',
      since: prev[k].firstSeen || null, kind: 'resolved',
    });
  }
  return { fire, state };
}

/**
 * Render reconciled alerts as notifications.json entries (newest first).
 * Contract lives in docs/configuration.md: { ts, title, message, status, link }.
 *
 * @param {object[]} fire - `fire` from reconcileAlerts
 * @param {{ now?: number, baseUrl?: string }} [opts]
 * @returns {object[]}
 */
export function alertsToNotifications(fire, { now = Date.now(), baseUrl = '' } = {}) {
  const ts = new Date(now).toISOString();
  const root = String(baseUrl || '').replace(/\/$/, '');
  return (Array.isArray(fire) ? fire : []).map((a) => {
    const resolved = a.kind === 'resolved';
    const n = {
      ts,
      title: resolved ? `${a.workflowName} recovered` : a.title,
      message: a.message,
      status: resolved ? 'success' : 'failure',
    };
    // Only emit a link we can actually build — a half-formed href is worse
    // than none, because the dashboard renders it as a live button.
    const link = alertLink(a, root);
    if (link) n.link = link;
    return n;
  });
}

/**
 * Prepend fresh notifications to the existing feed and cap the result.
 *
 * The feed is append-only from the dashboard's point of view and nothing prunes
 * it, so an uncapped merge grows until the file is too big to fetch on every
 * dashboard refresh. A previous feed that is missing or corrupt is discarded
 * rather than fatal: losing alert history is recoverable, failing the poll and
 * publishing nothing is not.
 *
 * @param {object[]} fresh - newest first
 * @param {any} prev - previously published notifications.json, possibly garbage
 * @param {number} [max]
 * @returns {object[]}
 */
export function mergeNotifications(fresh, prev, max = 50) {
  const keep = Number(max) > 0 ? Number(max) : 50;
  const tail = Array.isArray(prev) ? prev : [];
  return [...(Array.isArray(fresh) ? fresh : []), ...tail].slice(0, keep);
}

/**
 * Parse a numeric env var, distinguishing "not set" from "set to nonsense".
 *
 * Coercing straight through Number() turns a typo into NaN, and NaN silently
 * disables a rule: every `errors >= NaN` and `age >= NaN` is false, so the
 * watchdog goes quiet with no indication why. For a feature whose entire job is
 * to tell you when something stopped working, failing silently on a typo is the
 * worst available behaviour — so a malformed value falls back to the default
 * and reports itself, and the caller logs it.
 *
 * Negative and non-finite values are treated as malformed too: a negative
 * budget would make every workflow instantly stale.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {{ value: number, invalid: boolean }}
 */
export function envNumber(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return { value: fallback, invalid: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { value: fallback, invalid: true };
  return { value: n, invalid: false };
}

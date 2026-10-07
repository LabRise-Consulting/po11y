// Watchdog rule configuration, resolved from the environment and the optional
// ALERT_RULES_FILE.
//
// Extracted from index.mjs so it can be tested: index.mjs starts the daemon on
// import, which makes every branch in here unreachable from a test file.
//
// Env-only like the rest of the server. ALERT_RULES_FILE is the escape hatch
// for the structured bits (perWorkflow budgets) that don't fit an env var; it is
// a path, never a secret, and env always wins over the file — in BOTH
// directions, so ALERTS_ENABLED=false silences a file that enables alerting.
// A malformed numeric env var must not silently disable a rule — envNumber
// falls back to the default and flags it, and we say so loudly.
//
// The file is re-read at runtime (createAlertConfig, issue #18); env is not,
// because env cannot change without a restart anyway.

import { readFileSync, statSync } from 'node:fs';
import { envNumber } from './watchdog.mjs';

// Numeric keys, at the top level and inside a perWorkflow entry. A value must
// read as a non-negative number; a numeric string is accepted because the
// file was never validated before, and Number() is what consumes it.
const NUMERIC = ['staleAfterMin', 'staleGraceMin', 'staleGraceFactor', 'stuckAfterMin', 'minErrors', 'errorRate'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const badNumber = (v) => v !== undefined && v !== null && !(v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0);

/**
 * Parse and validate the rules file. Throws with a one-line reason.
 *
 * Unknown keys pass: the file is the operator's, and rejecting a key a newer
 * po11y understands would make a downgrade drop every budget.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseRulesFile(text) {
  const file = JSON.parse(text);
  if (!isObject(file)) throw new Error('not a JSON object');
  if (file.enabled !== undefined && typeof file.enabled !== 'boolean') throw new Error('enabled must be true or false');
  for (const k of NUMERIC) if (badNumber(file[k])) throw new Error(`${k} must be a non-negative number`);
  if (file.ignore !== undefined && !(Array.isArray(file.ignore) && file.ignore.every((x) => typeof x === 'string'))) {
    throw new Error('ignore must be an array of strings');
  }
  if (file.perWorkflow !== undefined) {
    if (!isObject(file.perWorkflow)) throw new Error('perWorkflow must be an object');
    for (const [name, over] of Object.entries(file.perWorkflow)) {
      if (!isObject(over)) throw new Error(`perWorkflow["${name}"] must be an object`);
      for (const k of NUMERIC) if (badNumber(over[k])) throw new Error(`perWorkflow["${name}"].${k} must be a non-negative number`);
    }
  }
  return file;
}

/**
 * Resolve the watchdog rule config.
 *
 * @param {Record<string,string|undefined>} [env] - defaults to process.env
 * @param {(msg: string) => void} [log] - defaults to console.error
 * @returns {{ enabled: boolean, staleAfterMin: number, staleGraceMin: number,
 *   staleGraceFactor: number, stuckAfterMin: number, minErrors: number,
 *   errorRate: number, ignore: string[] }}
 */
export function loadAlertConfig(env = process.env, log = console.error) {
  return createAlertConfig(env, { log }).current();
}

/**
 * The live watchdog config: resolved once at boot like loadAlertConfig, then
 * refreshed from ALERT_RULES_FILE without a restart (issue #18).
 *
 * `reloadIfChanged()` costs one stat and re-reads only when the file's mtime
 * or size changed — size too, because a copy can keep the source's mtime.
 * `reload()` re-reads unconditionally (SIGHUP). No fs.watch: it is unreliable
 * on bind mounts, and a stat per rebuild is nothing at this cadence.
 *
 * A file that fails to read, parse or validate at RUNTIME keeps the last good
 * config, and says so once per change. Boot falls back to env only, as it
 * always has; at runtime that would silently drop every per-workflow budget
 * on a typo.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {{ readFile?: Function, stat?: Function, log?: (msg: string) => void }} [io]
 * @returns {{ current: () => object, reloadIfChanged: () => boolean, reload: () => boolean }}
 */
export function createAlertConfig(env = process.env, {
  readFile = readFileSync, stat = statSync, log = console.error,
} = {}) {
  const path = env.ALERT_RULES_FILE || '';
  const stamp = () => { const st = stat(path); return `${st.mtimeMs}:${st.size}`; };

  let seen = null;
  let file = {};
  if (path) {
    try {
      seen = stamp();
      file = parseRulesFile(readFile(path, 'utf8'));
    } catch (e) {
      log(`server: ALERT_RULES_FILE unreadable (${e.message}) — using env only`);
    }
  }
  let cfg = resolve(env, file, log);

  function load(force) {
    if (!path) return false;
    let now;
    try { now = stamp(); } catch (e) { now = `missing:${e.message}`; }
    if (!force && now === seen) return false;
    seen = now;
    try {
      file = parseRulesFile(readFile(path, 'utf8'));
    } catch (e) {
      log(`server: ALERT_RULES_FILE not reloaded (${e.message}) — keeping the last good rules`);
      return false;
    }
    // Env warnings were logged at boot, and env has not changed since.
    cfg = resolve(env, file, () => {});
    log(`server: ALERT_RULES_FILE reloaded — ${Object.keys(cfg.perWorkflow || {}).length} perWorkflow, ${cfg.ignore.length} ignore`);
    return true;
  }

  return { current: () => cfg, reloadIfChanged: () => load(false), reload: () => load(true) };
}

/** Merge env over a parsed rules file. */
function resolve(env, file, log) {
  const num = (v, dflt, name) => {
    const { value, invalid } = envNumber(v, Number(dflt));
    if (invalid) log(`server: ${name}="${v}" is not a valid number — using ${dflt}`);
    return value;
  };

  return {
    ...file,
    // Non-empty, not merely present: compose passes ${ALERTS_ENABLED:-}, so an
    // operator who left the variable alone reaches this as '' — that must fall
    // through to the file, or file.enabled is unreachable in every shipped
    // deployment. Same convention as the numeric siblings below (envNumber
    // treats '' as unset). A set value still wins in BOTH directions, so
    // ALERTS_ENABLED=false silences a file that enables alerting.
    // Default ON: the watchdog reuses the executions window the poll already
    // fetched (no extra n8n calls) and pushes nowhere unless ALERT_WEBHOOK_URL
    // is set, so the safe default is the one that makes notifications.json
    // exist instead of 404 on a fresh install. ALERTS_ENABLED=false or a rules
    // file with enabled:false opt out.
    enabled: env.ALERTS_ENABLED
      ? env.ALERTS_ENABLED === 'true'
      : (file.enabled ?? true),
    staleAfterMin: num(env.ALERT_STALE_AFTER_MIN, file.staleAfterMin ?? 0, 'ALERT_STALE_AFTER_MIN'),
    // Grace on the schedule-derived stale budget (server/schedule.mjs): how
    // long after an expected run a workflow may take to succeed before it
    // counts as missed. Absolute minutes by default; the factor is the opt-in
    // proportional form for operators whose runs take a share of the cadence.
    // The larger of the two applies. Factor defaults to 0 on purpose — a
    // proportional default would give a monthly schedule days of silence.
    staleGraceMin: num(env.ALERT_STALE_GRACE_MIN, file.staleGraceMin ?? 15, 'ALERT_STALE_GRACE_MIN'),
    staleGraceFactor: num(env.ALERT_STALE_GRACE_FACTOR, file.staleGraceFactor ?? 0, 'ALERT_STALE_GRACE_FACTOR'),
    stuckAfterMin: num(env.ALERT_STUCK_AFTER_MIN, file.stuckAfterMin ?? 0, 'ALERT_STUCK_AFTER_MIN'),
    minErrors: num(env.ALERT_MIN_ERRORS, file.minErrors ?? 3, 'ALERT_MIN_ERRORS'),
    errorRate: num(env.ALERT_ERROR_RATE, file.errorRate ?? 0.5, 'ALERT_ERROR_RATE'),
    ignore: env.ALERT_IGNORE
      ? env.ALERT_IGNORE.split(',').map((s) => s.trim()).filter(Boolean)
      : (file.ignore || []),
  };
}

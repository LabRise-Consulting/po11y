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

import { readFileSync } from 'node:fs';
import { envNumber } from './watchdog.mjs';

/**
 * Resolve the watchdog rule config.
 *
 * @param {Record<string,string|undefined>} [env] - defaults to process.env
 * @param {(msg: string) => void} [log] - defaults to console.error
 * @returns {{ enabled: boolean, staleAfterMin: number, stuckAfterMin: number,
 *   minErrors: number, errorRate: number, ignore: string[] }}
 */
export function loadAlertConfig(env = process.env, log = console.error) {
  const num = (v, dflt, name) => {
    const { value, invalid } = envNumber(v, dflt);
    if (invalid) log(`server: ${name}="${v}" is not a valid number — using ${dflt}`);
    return value;
  };

  let file = {};
  const path = env.ALERT_RULES_FILE || '';
  if (path) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
      log(`server: ALERT_RULES_FILE unreadable (${e.message}) — using env only`);
    }
  }

  return {
    ...file,
    // Presence, not truthiness: `=== 'true'` alone made ALERTS_ENABLED=false a
    // no-op against a file that enabled alerting, so the kill switch could only
    // ever switch alerting ON. Every sibling field below already reads env as an
    // override of the file value; this one now matches them.
    // Default ON: the watchdog reuses the executions window the poll already
    // fetched (no extra n8n calls) and pushes nowhere unless ALERT_WEBHOOK_URL
    // is set, so the safe default is the one that makes notifications.json
    // exist instead of 404 on a fresh install. ALERTS_ENABLED=false or a rules
    // file with enabled:false opt out.
    enabled: env.ALERTS_ENABLED !== undefined
      ? env.ALERTS_ENABLED === 'true'
      : (file.enabled ?? true),
    staleAfterMin: num(env.ALERT_STALE_AFTER_MIN, file.staleAfterMin ?? 0, 'ALERT_STALE_AFTER_MIN'),
    stuckAfterMin: num(env.ALERT_STUCK_AFTER_MIN, file.stuckAfterMin ?? 0, 'ALERT_STUCK_AFTER_MIN'),
    minErrors: num(env.ALERT_MIN_ERRORS, file.minErrors ?? 3, 'ALERT_MIN_ERRORS'),
    errorRate: num(env.ALERT_ERROR_RATE, file.errorRate ?? 0.5, 'ALERT_ERROR_RATE'),
    ignore: env.ALERT_IGNORE
      ? env.ALERT_IGNORE.split(',').map((s) => s.trim()).filter(Boolean)
      : (file.ignore || []),
  };
}

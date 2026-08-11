// Mode B collector daemon — poll an existing n8n's public API and publish the
// four dashboard feeds (map.json, forms.json, ai-map.json, status.json) into a
// shared read-only volume. No bootstrap, no owner account, no Docker socket, no
// Execute Command, no write path to n8n.
//
// SECURITY INVARIANTS (enforced here + in collect.mjs):
//   - The n8n API key lives ONLY in this process's env (N8N_API_KEY). It is
//     never logged, never written into any feed file, and never served — the
//     health endpoint below exposes only timestamps/counters.
//   - Every n8n call is a GET (collect.apiGet is the sole choke point); the
//     collector cannot mutate the n8n instance. On n8n CE an API key is
//     unconditionally FULL-ACCESS (scopes are Enterprise-gated), so this
//     GET-only discipline — pinned by the GET-only invariant test — is the real
//     access control, not the key's scope.
//   - Outbound requests that are NOT to n8n: the optional AI annotation POST
//     (AI_MAP_BASE_URL), the optional alert push POST (ALERT_WEBHOOK_URL) and
//     the optional heartbeat GET (ALERT_HEARTBEAT_URL). None of them target
//     N8N_API_URL and none of them carry the n8n API key.
//   - The health port also serves /metrics (Prometheus exposition). It exposes
//     workflow ids, names and timestamps — a strict subset of map.json — plus
//     liveness gauges. No config, no key, no execution payloads.

import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchAllWorkflows,
  fetchStatus,
  fetchExecutions,
  buildAll,
  makeLlm,
  atomicWriteFile,
  feedDocuments,
} from './collect.mjs';
import {
  summarizeExecutions,
  evaluateAlerts,
  reconcileAlerts,
  alertsToNotifications,
  mergeNotifications,
  envNumber,
  unreachableAlert,
  DEFAULT_FEED_MAX,
} from './watchdog.mjs';
import { loadAlertConfig } from './alert-config.mjs';
import { pushAlerts, pingHeartbeat, redactUrl, FORMATS } from './notify.mjs';
import { accumulateErrors, buildSnapshot, renderMetrics } from './metrics.mjs';
import { guardOutbound, scopeDirWarning, makeRequestHandler } from './daemon.mjs';

// ---- config (env only; no config file, no secrets on disk) ------------------
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 600); // seconds
// Recent-executions window per poll; collect.mjs clamps to n8n's API cap (250).
// On a busy instance size this so window >= executions per POLL_INTERVAL, or
// the failing-rate rule samples (the stale rule keys on last-success age and
// is unaffected). See "Sizing the executions window" in docs/configuration.md.
const EXECUTIONS_LIMIT = Number(process.env.EXECUTIONS_LIMIT || 100);
const STATUS_DIR = process.env.STATUS_DIR || '/po11y-status';
const PORT = Number(process.env.PORT || 8081);
// The health/metrics listener binds every interface by default, which is right
// under the shipped compose (the port is never published, so "every interface"
// means the compose network). Outside it — host networking, a k8s pod sharing a
// node's network namespace — that quietly exposes /metrics, so BIND_HOST makes
// the reach explicit without changing any existing deployment.
const BIND_HOST = process.env.BIND_HOST || '';

// ---- watchdog config --------------------------------------------------------
// Resolution rules live in alert-config.mjs (extracted so they are testable);
// this file only supplies process.env and keeps the numeric-env helper the rest
// of the daemon's own settings use.
const num = (v, dflt, name) => {
  const { value, invalid } = envNumber(v, dflt);
  if (invalid) console.error(`collector: ${name}="${v}" is not a valid number — using ${dflt}`);
  return value;
};
const ALERTS = loadAlertConfig();
const RENOTIFY_MIN = num(process.env.ALERT_RENOTIFY_MIN, 360, 'ALERT_RENOTIFY_MIN');
const NOTIFICATIONS_MAX = num(process.env.ALERT_FEED_MAX, DEFAULT_FEED_MAX, 'ALERT_FEED_MAX');

// ---- outbound push (optional) -----------------------------------------------
// The URL is a credential (Slack and Telegram both put their secret in the
// path), so it is read here and never logged except through redactUrl.
const PUSH = {
  url: process.env.ALERT_WEBHOOK_URL || '',
  format: process.env.ALERT_WEBHOOK_FORMAT || 'slack',
  chatId: process.env.ALERT_TELEGRAM_CHAT_ID || '',
  timeoutMs: num(process.env.ALERT_WEBHOOK_TIMEOUT_MS, 10000, 'ALERT_WEBHOOK_TIMEOUT_MS'),
  // Deep links in the pushed message point at the same n8n the feed's links do.
  // Not a new disclosure: notifications.json already carries this URL, and the
  // push target is operator-configured. The `unreachable` alert still carries
  // no link (it has no workflow) and its message is still scrubbed.
  baseUrl: N8N_API_URL,
};
// Fail loudly at startup rather than once per poll, and for the same reason the
// numeric vars are validated: a typo that silently disables alerting is the
// worst outcome for a feature whose job is to tell you something broke.
if (PUSH.url && !FORMATS.includes(PUSH.format)) {
  console.error(`collector: ALERT_WEBHOOK_FORMAT="${PUSH.format}" is not one of ${FORMATS.join(', ')} — push disabled`);
  PUSH.url = '';
}
if (PUSH.url && PUSH.format === 'telegram' && !PUSH.chatId) {
  console.error('collector: ALERT_WEBHOOK_FORMAT=telegram requires ALERT_TELEGRAM_CHAT_ID — push disabled');
  PUSH.url = '';
}

// ---- heartbeat (optional dead-man switch) -----------------------------------
// Deliberately NOT gated on ALERTS_ENABLED: the watchdog rules answer "is a
// workflow misbehaving", this answers "is po11y still alive at all", and an
// operator may reasonably want the second without the first. Also a credential
// (the monitor id is in the path), so it gets the same redaction discipline.
const HEARTBEAT = {
  url: process.env.ALERT_HEARTBEAT_URL || '',
  timeoutMs: num(process.env.ALERT_HEARTBEAT_TIMEOUT_MS, 10000, 'ALERT_HEARTBEAT_TIMEOUT_MS'),
};

const AI_BASE = process.env.AI_MAP_BASE_URL || '';
const AI_KEY = process.env.AI_MAP_API_KEY || '';
const AI_MODEL = process.env.AI_MAP_MODEL || '';
let aiConfigured = !!(AI_BASE && AI_KEY && AI_MODEL);

if (!N8N_API_URL || !N8N_API_KEY) {
  // Never echo the key; only report which var is missing.
  console.error('collector: N8N_API_URL and N8N_API_KEY are required');
  process.exit(2);
}

// docs/security.md promises the outbound URLs never target the n8n host —
// guardOutbound (daemon.mjs) enforces it: refuse the URL and keep running,
// same posture as the ALERT_WEBHOOK_FORMAT check above.
{
  const guarded = guardOutbound({
    pushUrl: PUSH.url, heartbeatUrl: HEARTBEAT.url, aiBase: AI_BASE, aiConfigured,
  }, N8N_API_URL);
  guarded.errors.forEach((m) => console.error(m));
  PUSH.url = guarded.pushUrl;
  HEARTBEAT.url = guarded.heartbeatUrl;
  aiConfigured = guarded.aiConfigured;
}

// Named-volume subdirs don't exist until created — a second collector sets
// STATUS_DIR=/po11y-status/<scope>, and that nested dir has never been
// mkdir'd. The /po11y-status mount is writable even under a read_only
// rootfs, so this is safe at startup, before the first poll.
// A scope name outside nginx's [a-z0-9-] charset would publish feeds the
// dashboard 404s on forever — say so now instead (scopeDirWarning).
const dirWarning = scopeDirWarning(STATUS_DIR);
if (dirWarning) console.error(dirWarning);
mkdirSync(STATUS_DIR, { recursive: true });

const feedPath = (name) => join(STATUS_DIR, name);
// LLM transport is built once; only its factory sees the AI key (not logged).
const llm = aiConfigured ? makeLlm(fetch, { base: AI_BASE, key: AI_KEY, model: AI_MODEL }) : null;

// ---- health state -----------------------------------------------------------
const health = { lastSuccess: null, lastError: null, consecutiveFailures: 0 };

// ---- metrics state ----------------------------------------------------------
// Held in memory and replaced wholesale on each successful poll, so a scrape
// never sees a half-updated document. Counters reset on restart, which is a
// real counter reset and exactly what Prometheus expects.
let errorCounters = { counted: new Set(), totals: new Map() };
let metricsSnapshot = { n8nUp: 0, pollLastSuccessMs: null, workflows: [] };

// ---- one poll ---------------------------------------------------------------
// On success: publish the feeds and reset the failure counter. On ANY failure:
// log to stderr and KEEP the last-good files (skip all writes) — the dashboard's
// age-based staleness badge signals the gap.
//
// Each feed is written atomically on its own (tmp+rename) and all four share
// one generated_at stamp; this is per-file atomicity, NOT a cross-file
// transaction. A crash mid-cycle can leave some feeds newer than others (each
// still individually valid + parseable); the next successful poll reconciles
// them. An AI outage does not fail the poll — buildAll degrades the ai-map to
// heuristic/last-good while map/forms/status still publish.
async function poll() {
  const workflows = await fetchAllWorkflows(fetch, N8N_API_URL, N8N_API_KEY);

  // Previous ai-map drives differential annotation; missing/corrupt -> null.
  let prevAiMap = null;
  try { prevAiMap = JSON.parse(readFileSync(feedPath('ai-map.json'), 'utf8')); } catch { /* first run */ }

  // Consume a pending SIGHUP force only once the build it applies to has
  // succeeded — a poll that dies fetching workflows keeps the force armed.
  const forced = forceAiMap;
  const now = Date.now();
  const { map, forms, ai } = await buildAll(workflows, prevAiMap, {
    now, forced, aiConfigured, model: AI_MODEL, llm,
  });
  if (forced) forceAiMap = false;

  const stamp = new Date(now).toISOString();

  // Shapes live in collect.mjs, pinned by test against the Mode A Code nodes so
  // the two publishers of these feeds cannot drift apart again.
  const docs = feedDocuments({ map, forms }, stamp);
  for (const [name, body] of Object.entries(docs)) {
    atomicWriteFile(feedPath(name), JSON.stringify(body));
  }

  // ai-map: buildAiMap owns the publish policy. Only 'publish'/'republish'
  // yield a map to write; 'skip-fresh'/'keep-annotated' leave the file as-is.
  // CAUTION: on 'republish' buildAiMap returns the caller's `prevAiMap` object
  // mutated (generated_at deleted). Stamp and write `ai.map` — never touch
  // prevAiMap afterwards.
  if (ai.map) {
    ai.map.generated_at = stamp;
    atomicWriteFile(feedPath('ai-map.json'), JSON.stringify(ai.map));
  }
  for (const w of (ai.summary?.warnings || [])) console.error(w);
  // AI outage degraded the annotation but the poll still succeeded — surface it.
  if (ai.degraded) console.error(`collector: ai-map degraded (LLM unavailable) — ${ai.degraded}`);

  // status.json is always published (empty object if executions API is off).
  // The executions API omits workflowName; reuse the list we already fetched so
  // the dashboard shows real names instead of n8n ids.
  const names = new Map(workflows.map((w) => [String(w.id), w.name]).filter(([, n]) => n));
  // One executions GET per poll, shared by status.json and the watchdog.
  const executions = await fetchExecutions(fetch, N8N_API_URL, N8N_API_KEY, EXECUTIONS_LIMIT);
  const { status, warning } = await fetchStatus(fetch, N8N_API_URL, N8N_API_KEY, { names, executions });
  if (warning) console.error(warning);
  atomicWriteFile(feedPath('status.json'), JSON.stringify({ generated_at: stamp, ...status }));

  // Computed once per poll and shared by metrics and the watchdog. Metrics must
  // publish even with ALERTS_ENABLED=false, so this cannot live inside the
  // alerts-only path where it used to.
  const summary = summarizeExecutions(executions, { now, names });
  errorCounters = accumulateErrors(errorCounters, executions);
  metricsSnapshot = buildSnapshot(workflows, summary, errorCounters.totals, {
    now, n8nUp: 1, pollLastSuccessMs: now,
  });

  if (ALERTS.enabled) {
    const alerts = evaluateWorkflowAlerts(workflows, summary, now);
    // null means the evaluation itself broke. Publishing an empty list instead
    // would read as "everything recovered" and clear real open alerts.
    if (alerts) await publishAlerts(alerts, now);
  }
}

// ---- watchdog ---------------------------------------------------------------
// Evaluate the three rules, dedupe against the persisted state, and prepend
// anything worth saying to notifications.json.
//
// This never throws into poll(): a watchdog bug must not stop the feeds from
// publishing. The feeds are the product; alerting is an addition to them.
//
// alert-state.json lives in STATUS_DIR because that is the collector's only
// writable mount under a read_only rootfs. Sharing a directory with the feeds
// does NOT make it one: nginx.conf aliases the five feeds by name and the
// scoped /status/<scope>/<feed> regex enumerates the same five, so this file is
// collector-internal state that never leaves the volume. Adding it to nginx
// would be harmless (workflow names and timestamps, a strict subset of what
// map.json already publishes) but there is no reason to.

/**
 * Evaluate the three workflow rules, or null if the evaluation itself failed.
 *
 * Guarded separately from publishAlerts because the two failures mean opposite
 * things: a broken evaluation must publish NOTHING (an empty list would be
 * indistinguishable from "all clear" and would resolve every open alert),
 * whereas a broken publish is simply a missed notification.
 */
function evaluateWorkflowAlerts(workflows, summary, now) {
  try {
    return evaluateAlerts(summary, workflows, ALERTS, { now });
  } catch (e) {
    console.error(`collector: alert evaluation failed — ${e.message}`);
    return null;
  }
}

/**
 * Reconcile a set of alerts against the persisted state and say what is new.
 *
 * `rules` scopes what this call is authoritative for — see reconcileAlerts.
 * A successful poll passes no scope (it saw everything, so anything missing has
 * genuinely recovered); the unreachable path scopes to its own rule so it
 * cannot resolve workflow alerts it knows nothing about.
 */
async function publishAlerts(alerts, now, { rules = null } = {}) {
  try {
    let prevState = null;
    try { prevState = JSON.parse(readFileSync(feedPath('alert-state.json'), 'utf8')); } catch { /* first run */ }
    const { fire, state } = reconcileAlerts(alerts, prevState, { now, renotifyMin: RENOTIFY_MIN, rules });

    // Persist state even when nothing fired, so "already notified" survives a
    // restart and an open alert isn't re-announced on every boot.
    atomicWriteFile(feedPath('alert-state.json'), JSON.stringify(state));
    if (!fire.length) {
      // An enabled watchdog materializes the feed even with nothing to say:
      // an empty feed means "all clear", a missing one means "not running" —
      // and the dashboard stops 404ing on notifications.json on healthy
      // installs. Only ever seeds; an existing feed is never touched here.
      try { readFileSync(feedPath('notifications.json')); }
      catch { atomicWriteFile(feedPath('notifications.json'), '[]'); }
      return;
    }

    // Push first: the feed write is local and cannot really fail, whereas the
    // webhook is the part with a timeout. Ordering them this way means a slow
    // Slack delays the feed by at most ALERT_WEBHOOK_TIMEOUT_MS rather than
    // leaving the two out of step. pushAlerts never throws.
    if (PUSH.url) {
      const { sent, error } = await pushAlerts(fetch, PUSH, fire);
      if (error) console.error(`collector: alert push failed — ${error}`);
      else if (sent) console.error(`collector: pushed ${fire.length} alert(s) to ${redactUrl(PUSH.url)}`);
    }

    let prev = null;
    try { prev = JSON.parse(readFileSync(feedPath('notifications.json'), 'utf8')); } catch { /* first run */ }

    const fresh = alertsToNotifications(fire, { now, baseUrl: N8N_API_URL });
    atomicWriteFile(
      feedPath('notifications.json'),
      JSON.stringify(mergeNotifications(fresh, prev, NOTIFICATIONS_MAX)),
    );
    console.error(`collector: ${fire.length} alert notification(s) published`);
  } catch (e) {
    console.error(`collector: watchdog failed — ${e.message}`);
  }
}

// A poll either succeeds and pings the dead-man switch, or fails and says so.
//
// The three watchdog rules are derived from data fetched out of n8n, and
// fetchAllWorkflows is the FIRST thing poll() does — so when n8n is down, hung
// or rejecting the key, poll() throws long before it reaches the notify path.
// Handling that here rather than inside poll() is what makes the one outage
// nobody wants to miss actually reach a human.
async function tick() {
  let failure = null;
  try {
    await poll();
    health.lastSuccess = new Date().toISOString();
    health.consecutiveFailures = 0;
  } catch (e) {
    failure = e;
    health.lastError = new Date().toISOString();
    health.consecutiveFailures += 1;
    // Flip the reachability gauge but KEEP the last-known workflow series: a
    // series that disappears restarts every Prometheus `for:` duration, so an
    // outage would come back as a burst of flapping alerts. The overlap with
    // the staleness rules is resolved by an Alertmanager inhibit rule.
    metricsSnapshot = { ...metricsSnapshot, n8nUp: 0 };
    // Log the message only (an error object could carry request context; keep
    // it terse and key-free).
    console.error(`collector: poll failed (${health.consecutiveFailures}) — ${e.message}`);
  }

  // Reachability alert. Scoped to its own rule: this pass fetched no workflows,
  // so it must not conclude that the ones it cannot see have recovered. The
  // matching "recovered" comes from the next successful poll, whose unscoped
  // reconcile finds the unreachable key no longer true.
  if (failure && ALERTS.enabled) {
    await publishAlerts(
      [unreachableAlert(failure, { baseUrl: N8N_API_URL })],
      Date.now(),
      { rules: ['unreachable'] },
    );
  }

  // Dead-man switch, success only — pinging on failure would defeat the whole
  // mechanism. A heartbeat that cannot be delivered is logged and otherwise
  // ignored: the poll already succeeded and a flaky third party must not
  // un-succeed it or count against /healthz.
  if (!failure && HEARTBEAT.url) {
    const { error } = await pingHeartbeat(fetch, HEARTBEAT);
    if (error) console.error(`collector: heartbeat failed — ${error}`);
  }
}

// ---- health endpoint --------------------------------------------------------
// Handler logic lives in daemon.mjs (makeRequestHandler). /metrics has the same
// exposure as the feeds the dashboard already serves (workflow ids, names,
// timestamps) and nothing more; port 8081 is not published in compose —
// Prometheus reaches it over the compose network.
const server = createServer(makeRequestHandler({
  health: () => health,
  metricsText: () => renderMetrics(metricsSnapshot),
}));

// ---- lifecycle --------------------------------------------------------------
let timer = null;
let ticking = false;
async function runTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(); } finally { ticking = false; }
}
function schedule() {
  timer = setTimeout(async () => {
    await runTick();
    schedule(); // re-arm only after the poll settles (no overlapping polls)
  }, POLL_INTERVAL * 1000);
}

// ---- forced ai-map rebuild (Mode B's "Build maps now") ----------------------
// Mode A wires a form trigger; Mode B's equivalent is a signal:
//   docker kill -s HUP po11y-collector
// The next build re-annotates every node (forced:true), ignoring the 20 h
// freshness window and the differential sigs. Idle → an immediate poll;
// mid-poll → the force arms for the next scheduled one (a poll runs seconds,
// the interval is minutes — not worth an overlap-safe queue).
let forceAiMap = false;
process.on('SIGHUP', () => {
  forceAiMap = true;
  if (ticking) {
    console.error('collector: SIGHUP — ai-map rebuild forced for the next poll (one is in flight)');
    return;
  }
  console.error('collector: SIGHUP — polling now with a full ai-map rebuild');
  if (timer) clearTimeout(timer);
  (async () => { await runTick(); schedule(); })();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`collector: ${signal} received, shutting down`);
  if (timer) clearTimeout(timer);
  server.close(() => process.exit(0));
  // Fallback in case an idle keep-alive holds the server open.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A failure to bind the health port (e.g. EADDRINUSE) is fatal and must not
// leave a half-started, health-less daemon running — report and exit non-zero.
server.on('error', (e) => {
  console.error(`collector: health server error on :${PORT} — ${e.message}`);
  process.exit(1);
});

const listenArgs = BIND_HOST ? [PORT, BIND_HOST] : [PORT];
server.listen(...listenArgs, () => {
  console.error(`collector: polling ${N8N_API_URL} every ${POLL_INTERVAL}s (window ${EXECUTIONS_LIMIT} executions) -> ${STATUS_DIR}; health on ${BIND_HOST || '*'}:${PORT}/healthz`);
});

// Poll immediately on boot, then on the interval.
(async () => { await runTick(); schedule(); })();

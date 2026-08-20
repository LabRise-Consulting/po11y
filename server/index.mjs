// Process wiring only: read env, open the store, start the timers, own the
// socket. No decisions live here — they are in the modules this imports, which
// is why there is no index.test.mjs.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb, openReadOnlyDb, getKv, setKv } from './db.mjs';
import { aiMapLlmUpFrom, buildSnapshot, renderMetrics } from './metrics.mjs';
import { seedCache, seedBuiltAt, persistCache } from './cache.mjs';
import {
  syncWorkflows, pollFill, pruneOlderThan, withTimeout, assertGetOnly, POLL_LAST_SUCCESS_KEY,
} from './sync.mjs';
import { every } from './timers.mjs';
import { sampleTables } from './datatables.mjs';
import { buildFeeds, nextAiMap } from './feeds.mjs';
import { loadPack, evaluate, reconcileExpectations, toNotifications } from './expectations.mjs';
import { alertNotifications, unreachableNotifications, aiMapNotifications, n8nReachable } from './alerts.mjs';
import { route } from './http.mjs';
import { makeRequestHandler } from './request.mjs';
import { makeCachedFeeds, makeStore, makePrometheus, makeN8n, makeGrafana, makeDataTables } from './mcp/sources.mjs';
import { buildRegistry } from './mcp/registry.mjs';
import { createDispatcher } from './mcp/protocol.mjs';
import { makeLlm } from './n8n.mjs';
import { mergeNotifications, envNumber, DEFAULT_FEED_MAX } from './watchdog.mjs';
import { loadAlertConfig } from './alert-config.mjs';
import { guardOutbound } from './outbound.mjs';
import { pushAlerts, pingHeartbeat, redactUrl, FORMATS } from './notify.mjs';

const num = (raw, dflt, name) => {
  const { value, invalid } = envNumber(raw, dflt);
  if (invalid) console.error(`server: ${name}="${raw}" is not a valid number — using ${dflt}`);
  return value;
};

const DB_PATH = process.env.PO11Y_DB || '/data/po11y.db';
const PORT = num(process.env.PORT, 8081, 'PORT');
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const N8N_API_URL = process.env.N8N_API_URL || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
// Where a READER opens n8n, as opposed to where this process sends requests.
// The bundled stack polls over the container network (docker-compose.yml:
// MCP_N8N_API_URL, default http://n8n:5678), an address that resolves in the
// compose network and nowhere else — so every link po11y hands out (MCP tool
// results, watchdog notifications, webhook pushes) was unopenable for the
// operator or remote agent that received it. Defaults to N8N_API_URL, which is
// correct for the single-host case where the two genuinely coincide.
//
// Never fetched, so deliberately NOT passed to guardOutbound: that guard exists
// to stop an optional outbound target being aimed at the n8n host, and this
// value is a link base whose whole purpose is to name that host.
const N8N_PUBLIC_URL = process.env.N8N_PUBLIC_URL || N8N_API_URL;
const SYNC_INTERVAL = num(process.env.SYNC_INTERVAL, 600, 'SYNC_INTERVAL');
// How long the sync waits after a FAILED tick, instead of the full interval.
// The sync's first tick fires at process start, which on a cold bootstrap is
// while n8n is still migrating, and compose restarts n8n again part-way
// through. Without this, either miss strands map.json and ai-map.json empty
// for ten minutes on an install that is otherwise healthy. 15s is the same
// order as POLL_INTERVAL, so a sustained n8n outage costs no more n8n traffic
// than the poll loop already generates.
const SYNC_RETRY_INTERVAL = num(process.env.SYNC_RETRY_INTERVAL, 15, 'SYNC_RETRY_INTERVAL');
// 30s, not 60s: the poll is also the only thing that can SEE a run in flight.
// A workflow shorter than one interval can start and finish between two polls,
// so it is recorded but never observed running — and the watchdog's `stuck`
// rule can never see it either. 30s halves that blind spot for the short
// workflows most instances actually run, at two extra GETs per minute.
const POLL_INTERVAL = num(process.env.POLL_INTERVAL, 30, 'POLL_INTERVAL');
const EXECUTIONS_LIMIT = num(process.env.EXECUTIONS_LIMIT, 250, 'EXECUTIONS_LIMIT');
// Generous by design: a full workflow sync pages the whole instance, and this
// bounds a single request, not the tick.
const N8N_TIMEOUT_MS = num(process.env.N8N_TIMEOUT_MS, 30_000, 'N8N_TIMEOUT_MS');
const RETENTION_DAYS = num(process.env.PO11Y_RETENTION_DAYS, 30, 'PO11Y_RETENTION_DAYS');
const PACK_PATH = process.env.PO11Y_PACK || '';
const SCOPE = process.env.PO11Y_SCOPE || 'default';
const INGEST_TOKEN = process.env.PO11Y_INGEST_TOKEN || '';
const MAX_BODY = num(process.env.PO11Y_MAX_BODY_BYTES, 1_000_000, 'PO11Y_MAX_BODY_BYTES');
const TABLES = (process.env.PO11Y_DATATABLES || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONFIG_PATH = process.env.CONFIG_PATH || '/app/config.json';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || '';
const GRAFANA_URL = process.env.GRAFANA_URL || '';
const GRAFANA_SA_TOKEN = process.env.GRAFANA_SA_TOKEN || '';
const GRAFANA_DATASOURCE_UID = process.env.GRAFANA_DATASOURCE_UID || 'n8n-postgres';
const N8N_READ_API_KEY = process.env.N8N_READ_API_KEY || '';
const RENOTIFY_MIN = num(process.env.ALERT_RENOTIFY_MIN, 360, 'ALERT_RENOTIFY_MIN');
const EXPECTATION_STATE_KEY = 'expectation-state';
const FEED_MAX = num(process.env.ALERT_FEED_MAX, DEFAULT_FEED_MAX, 'ALERT_FEED_MAX');
const ALERTS = loadAlertConfig(process.env, console.error);

const AI_BASE = process.env.AI_MAP_BASE_URL || '';
const AI_KEY = process.env.AI_MAP_API_KEY || '';
const AI_MODEL = process.env.AI_MAP_MODEL || '';

// ---- outbound push (optional) — the collector daemon's old push contract --
const PUSH = {
  url: process.env.ALERT_WEBHOOK_URL || '',
  format: process.env.ALERT_WEBHOOK_FORMAT || 'slack',
  chatId: process.env.ALERT_TELEGRAM_CHAT_ID || '',
  timeoutMs: num(process.env.ALERT_WEBHOOK_TIMEOUT_MS, 10000, 'ALERT_WEBHOOK_TIMEOUT_MS'),
  baseUrl: N8N_PUBLIC_URL,
};
if (PUSH.url && !FORMATS.includes(PUSH.format)) {
  console.error(`server: ALERT_WEBHOOK_FORMAT="${PUSH.format}" is not one of ${FORMATS.join(', ')} — push disabled`);
  PUSH.url = '';
}
if (PUSH.url && PUSH.format === 'telegram' && !PUSH.chatId) {
  console.error('server: ALERT_WEBHOOK_FORMAT=telegram requires ALERT_TELEGRAM_CHAT_ID — push disabled');
  PUSH.url = '';
}

// ---- heartbeat (optional dead-man switch) ----------------------------------
const HEARTBEAT = {
  url: process.env.ALERT_HEARTBEAT_URL || '',
  timeoutMs: num(process.env.ALERT_HEARTBEAT_TIMEOUT_MS, 10000, 'ALERT_HEARTBEAT_TIMEOUT_MS'),
};

if (!N8N_API_URL) {
  console.error('server: N8N_API_URL is required');
  process.exit(1);
}
// The ops key is opt-in (docs/mcp.md: MCP_N8N_API_KEY, which the bundled
// compose file maps onto N8N_API_KEY). Without it this process cannot sync
// or poll, but it is still load-bearing — /mcp, /n8n-table and the feed
// routes must answer — so degrade instead of dying.
const SYNC_ENABLED = Boolean(N8N_API_KEY);
if (!SYNC_ENABLED) {
  console.error('server: N8N_API_KEY unset — sync/poll disabled; serving-only mode (/mcp, /n8n-table, cached feeds)');
}
if (!/^[a-z0-9-]+$/.test(SCOPE)) {
  console.error(`server: PO11Y_SCOPE="${SCOPE}" is outside nginx's scope charset [a-z0-9-] — /status/${SCOPE}/ would 404`);
  process.exit(1);
}
if (!INGEST_TOKEN) {
  console.error('server: PO11Y_INGEST_TOKEN unset — POST /ingest is disabled; executions come from poll-fill only');
}

// Same promise the server makes elsewhere (docs/security.md): no optional
// outbound URL may target the n8n host. Reused rather than re-argued.
let aiConfigured = !!(AI_BASE && AI_KEY && AI_MODEL);
{
  const guarded = guardOutbound({
    pushUrl: PUSH.url, heartbeatUrl: HEARTBEAT.url, aiBase: AI_BASE, aiConfigured,
  }, N8N_API_URL);
  guarded.errors.forEach((m) => console.error(m));
  PUSH.url = guarded.pushUrl;
  HEARTBEAT.url = guarded.heartbeatUrl;
  aiConfigured = guarded.aiConfigured;
}
// The heartbeat pings on sync SUCCESS only, so with sync disabled it never
// pings at all and the off-box monitor reports this server as dead forever.
// That fails in the safe direction, but silently: an operator who configured a
// dead-man switch deserves to be told why it will stay red. Checked after
// guardOutbound so a URL that was already rejected does not warn twice.
if (!SYNC_ENABLED && HEARTBEAT.url) {
  console.error('server: ALERT_HEARTBEAT_URL is set but sync is disabled — no ping can ever be sent; '
    + 'set the ops key (MCP_N8N_API_KEY on the bundled stack) or unset the heartbeat');
}
const AI_MAX_TOKENS = num(process.env.AI_MAP_MAX_TOKENS, 16000, 'AI_MAP_MAX_TOKENS');
const llm = aiConfigured
  ? makeLlm(fetch, { base: AI_BASE, key: AI_KEY, model: AI_MODEL, maxTokens: AI_MAX_TOKENS })
  : null;

const db = openDb(DB_PATH);
const pack = PACK_PATH ? loadPack(readFileSync(PACK_PATH, 'utf8')) : { expectations: [] };
// Expectation SQL is operator input evaluated on a handle that cannot write.
const packDb = PACK_PATH ? openReadOnlyDb(DB_PATH) : null;

const health = { ok: false, lastSuccess: null, lastError: null, consecutiveFailures: 0 };
let lastSyncError = null;
// True once the sync tick has recorded ITS FIRST outcome, success or failure.
// health.consecutiveFailures defaults to 0 before that, which reads
// identically to "healthy" unless this is tracked separately — see
// n8nReachable in alerts.mjs for why that matters.
let syncedOnce = false;

// Last ai-map build's LLM outcome, for po11y_ai_map_llm_up. null until the
// first rebuild records one — no build has happened yet, so there is no
// outcome to report, and the series stays absent rather than claiming a
// gateway is down before anything has asked it for prose.
let aiMapLlmUp = null;

// ai-map.json and notifications.json are seeded from the store so a restart
// does not serve `null`/`[]` until the first sync/poll tick completes — the
// other three feeds are cheap to rebuild and start empty on purpose.
let cached = seedCache(db, {
  'status.json': { generated_at: null },
  'map.json': {},
  'forms.json': { forms: [] },
  'ai-map.json': null,
  'notifications.json': [],
});
// Non-null exactly when `cached` holds feeds a rebuild actually produced —
// this run's, or a previous run's via the persisted stamp. The MCP feeds
// adapter reads it as its availability rule, so it must NOT start at null on a
// warm store: that would report a server with a real last-good ai-map and a
// real notification history as having published nothing.
let builtAtMs = seedBuiltAt(db);

// MCP surface: tools over the same store/cache this process already
// maintains, built once at boot exactly as the standalone daemon did.
// config.json is read once here (no live reload — same as before).
const mcpSources = {
  feeds: makeCachedFeeds({ getFeeds: () => cached, getBuiltAtMs: () => builtAtMs }),
  // Gated on the same key the sync/poll loop needs: with SYNC_ENABLED false
  // nothing writes this store, and an empty executions table must read as "I
  // cannot see", not as "nothing is wrong".
  store: makeStore({ db, enabled: SYNC_ENABLED }),
  prometheus: makePrometheus({ url: PROMETHEUS_URL }),
  n8n: makeN8n({ url: N8N_API_URL, apiKey: N8N_API_KEY, publicUrl: N8N_PUBLIC_URL }),
  grafana: makeGrafana({ url: GRAFANA_URL, token: GRAFANA_SA_TOKEN, datasourceUid: GRAFANA_DATASOURCE_UID }),
  datatables: makeDataTables({ n8nUrl: N8N_API_URL, readKey: N8N_READ_API_KEY }),
};
const { tools, resources } = buildRegistry(mcpSources, CONFIG_PATH);
const mcpDispatch = createDispatcher({ tools, resources, serverInfo: { name: 'po11y', version: '1' } });

async function rebuild() {
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const forced = forceAiMap;
  const built = await buildFeeds(db, {
    stamp,
    now,
    prevAiMap: cached['ai-map.json'],
    ai: { forced, aiConfigured, model: AI_MODEL, llm },
    limit: EXECUTIONS_LIMIT,
  });
  if (forced) forceAiMap = false;
  if (built.warning) console.error(built.warning);
  built.aiWarnings.forEach((w) => console.error(w));
  if (built.degraded) console.error(`server: ai-map degraded (LLM unavailable) — ${built.degraded}`);
  aiMapLlmUp = aiMapLlmUpFrom({
    aiConfigured, action: built.aiAction, degraded: built.degraded, previous: aiMapLlmUp,
  });

  // Expectations are gated on state transition (reconcileExpectations),
  // mirroring the watchdog's reconcileAlerts: evaluate() re-reports a
  // persistently failing expectation on every rebuild, and without this a
  // single stuck expectation floods notifications.json — 46 identical entries
  // evicted everything else on the live deployment. State follows the same
  // corrupt-tolerant kv pattern as alerts.mjs.
  let expectationFire = [];
  if (packDb) {
    let prevExpState = null;
    try { prevExpState = JSON.parse(getKv(db, EXPECTATION_STATE_KEY) ?? 'null'); } catch { /* corrupt: start over */ }
    const { fire, state } = reconcileExpectations(evaluate(packDb, pack, now), prevExpState, {
      now, renotifyMin: RENOTIFY_MIN,
    });
    setKv(db, EXPECTATION_STATE_KEY, JSON.stringify(state));
    expectationFire = fire;
  }

  // notifications.json carries BOTH sources: the watchdog rules this process
  // publishes, and the new data expectations. Watchdog first — an outage is
  // more urgent than a threshold.
  //
  // Scoping rule (see Design Rationale): this rebuild runs even in the
  // finally of a FAILED sync. When n8n is unreachable the workflow rules were
  // evaluated over stale store rows and this pass must not be authoritative
  // for 'unreachable' — an unscoped reconcile would resolve the outage alert
  // the moment it fired, because evaluateAlerts never emits that rule.
  //
  // n8nOk requires syncedOnce, not just consecutiveFailures === 0: that
  // counter defaults to 0 before the sync tick has recorded any outcome at
  // all, and every()'s first tick fires immediately, so a rebuild triggered
  // by poll-fill (or an HTTP POST) can race ahead of it. Treating "no
  // outcome yet" as "healthy" would let that rebuild run unscoped and
  // resolve a persisted 'unreachable' alert it has no evidence for.
  const n8nOk = n8nReachable({ syncedOnce, consecutiveFailures: health.consecutiveFailures });
  const { notifications: alertNotes, fire: alertFire } = alertNotifications(db, {
    executions: built.executions, workflows: built.workflows, names: built.names,
    cfg: ALERTS, now, renotifyMin: RENOTIFY_MIN, baseUrl: N8N_PUBLIC_URL,
    rules: n8nOk ? null : ['failing', 'stale', 'stuck'],
  });
  // Gated on an actual recorded failure, not merely `!n8nOk`: before the
  // first sync outcome (or permanently, with the sync loop disabled —
  // SYNC_INTERVAL<=0) n8nOk is false but lastSyncError is still null, and
  // there is no evidence to open or renotify an outage alert from.
  let unreachable = { notifications: [], fire: [] };
  if (lastSyncError) {
    unreachable = unreachableNotifications(db, {
      error: lastSyncError, cfg: ALERTS, now, renotifyMin: RENOTIFY_MIN, baseUrl: N8N_PUBLIC_URL,
    });
  }
  // The ai-map's LLM, on every rebuild that actually asked it something. The
  // action gate matters: republish/keep-annotated/skip-fresh return without
  // calling the LLM, so a null `degraded` from those branches is "did not ask",
  // not "asked and it worked" — reconciling on it would publish a recovery the
  // build has no evidence for. Only runs where an LLM is configured: a stack
  // without AI_MAP_* is heuristic by choice, not degraded.
  let aiMapAlert = { notifications: [], fire: [] };
  if (aiConfigured && built.aiAction === 'publish') {
    aiMapAlert = aiMapNotifications(db, {
      degraded: built.degraded, cfg: ALERTS, now, renotifyMin: RENOTIFY_MIN,
      baseUrl: N8N_PUBLIC_URL, aiBase: AI_BASE,
    });
  }

  const pushFire = [...unreachable.fire, ...alertFire, ...aiMapAlert.fire];
  const fresh = [
    ...unreachable.notifications,   // an outage outranks a threshold
    ...alertNotes,
    ...aiMapAlert.notifications,
    ...toNotifications(expectationFire, now),
  ];

  if (pushFire.length && PUSH.url) {
    const { sent, error } = await pushAlerts(fetch, PUSH, pushFire);
    if (error) console.error(`server: alert push failed — ${error}`);
    else if (sent) console.error(`server: pushed ${pushFire.length} alert(s) to ${redactUrl(PUSH.url)}`);
  }

  cached = {
    ...built.feeds,
    'ai-map.json': nextAiMap(cached['ai-map.json'], built.aiMap),
    'notifications.json': mergeNotifications(fresh, cached['notifications.json'], FEED_MAX),
  };
  // Persist after every rebuild, not just on shutdown: SIGKILL and container
  // restarts skip the shutdown handler entirely, and these two feeds are the
  // ones the plan requires to survive that.
  persistCache(db, cached, now);
  builtAtMs = now;
}

// Single-flight with a coalescing follow-up: a burst of pushed events must not
// start a rebuild per event (each one runs every builder and every expectation),
// and two concurrent rebuilds would race on `cached` and on the ai-map's
// prev-document. Same non-overlapping discipline the poll-fill tick below
// enforces for itself.
let inFlight = null;
let again = false;
function refresh() {
  if (inFlight) { again = true; return inFlight; }
  inFlight = rebuild()
    .catch((e) => console.error(`server: rebuild failed — ${e.message}`))
    .finally(() => {
      inFlight = null;
      if (again) { again = false; refresh(); }
    });
  return inFlight;
}

// Forced ai-map rebuild — the dashboard's "Build maps now" action, and the
// SIGHUP handler below. The force is consumed only by a build that
// SUCCEEDS, so a rebuild that dies fetching nothing keeps it armed.
let forceAiMap = false;
process.on('SIGHUP', () => {
  forceAiMap = true;
  console.error('server: SIGHUP — forcing a full ai-map rebuild');
  refresh();
});

let refreshTimer = null;
function scheduleRefresh(delayMs = 2000) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, delayMs).unref();
}

// Every call to n8n carries a deadline, and every loop re-arms only after its
// tick settles (see the two modules for why). Both are here rather than inside
// the tick bodies so no future tick can forget either.
const n8nFetch = withTimeout(fetch, N8N_TIMEOUT_MS);

// Workflow sync is the reachability probe: it is the one call that propagates
// an n8n failure out of its tick (pollFill reports its own failure inline
// instead, so the rest of the poll tick still runs), so the health counters
// key on it.
if (SYNC_ENABLED) {
  every(SYNC_INTERVAL, 'workflow sync', async () => {
    try {
      await syncWorkflows(db, n8nFetch, N8N_API_URL, N8N_API_KEY);
      health.ok = true;
      health.lastSuccess = new Date().toISOString();
      health.consecutiveFailures = 0;
      lastSyncError = null;
      syncedOnce = true;
      // Dead-man switch, success only (server/notify.mjs:206-207's contract):
      // the sync is this process's reachability probe. A failed delivery is
      // logged and never un-succeeds the sync.
      if (HEARTBEAT.url) {
        const { error } = await pingHeartbeat(fetch, HEARTBEAT);
        if (error) console.error(`server: heartbeat failed — ${error}`);
      }
    } catch (e) {
      health.ok = false;
      health.lastError = new Date().toISOString();
      health.consecutiveFailures += 1;
      lastSyncError = e;
      syncedOnce = true;
      console.error(`server: workflow sync failed (${health.consecutiveFailures}) — ${e.message}`);
      throw e;
    } finally {
      await refresh();
    }
  }, { retrySeconds: SYNC_RETRY_INTERVAL });

  every(POLL_INTERVAL, 'poll-fill', async () => {
    // pollFill stamps POLL_LAST_SUCCESS_KEY itself, and only when the fetch
    // actually reached n8n — see its jsdoc. A failure is logged and the tick
    // carries on: the stored stamp is left to age, so
    // po11y_poll_last_success_timestamp_seconds goes stale and
    // Po11yPollStalled can fire. Unknown is not healthy.
    const { ok, error } = await pollFill(db, n8nFetch, N8N_API_URL, N8N_API_KEY, EXECUTIONS_LIMIT);
    if (!ok) console.error(`server: poll-fill could not reach n8n — ${error.message}; poll-last-success left to age`);
    // Data-table sampling rides the poll-fill tick rather than its own timer:
    // one fewer interval to reason about, and it shares the same cadence
    // executions land on. sampleTables already isolates per-target failures
    // (a bad name in PO11Y_DATATABLES) internally; this try/catch is the outer
    // guard so a failure sampling tables (e.g. a store write error) cannot
    // take down the executions poll it is riding on.
    if (TABLES.length) {
      try {
        await sampleTables(db, n8nFetch, N8N_API_URL, N8N_API_KEY, TABLES, Date.now());
      } catch (e) {
        console.error(`server: datatable sampling failed — ${e.message}`);
      }
    }
    const removed = pruneOlderThan(db, RETENTION_DAYS);
    if (removed) console.error(`server: pruned ${removed} execution(s) older than ${RETENTION_DAYS}d`);
    await refresh();
  });
}

const ctx = {
  db,
  scope: SCOPE,
  health: () => health,
  ingestToken: INGEST_TOKEN,
  maxBodyBytes: MAX_BODY,
  feeds: () => cached,
  mcpDispatch,
  // n8nUp follows the same unknown-is-down rule as the alert engine: before the
  // first sync tick records an outcome we have no evidence n8n is reachable, and
  // exporting 1 there would be a false all-clear a Prometheus alert acts on.
  metricsText: () => renderMetrics(buildSnapshot(db, {
    n8nUp: n8nReachable({ syncedOnce, consecutiveFailures: health.consecutiveFailures }) ? 1 : 0,
    pollLastSuccessMs: (() => {
      const iso = getKv(db, POLL_LAST_SUCCESS_KEY);
      const ms = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(ms) ? ms : null;
    })(),
    aiMapLlmUp,
  })),
  // /n8n-table proxy: the one place this process forwards a browser-shaped
  // request to n8n. assertGetOnly makes the GET-only invariant structural, and
  // n8nFetch supplies the same deadline every other call to n8n carries —
  // nginx drops the client at proxy_read_timeout, but an outbound fetch with
  // no deadline of its own keeps running and holds a socket after that.
  n8nBase: N8N_API_URL.replace(/\/$/, ''),
  readKey: N8N_READ_API_KEY,
  fetchFn: assertGetOnly(n8nFetch),
};

const server = createServer(makeRequestHandler({
  route, ctx, maxBodyBytes: MAX_BODY, onAccepted: scheduleRefresh,
}));

server.on('error', (e) => {
  console.error(`server: listener error on :${PORT} — ${e.message}`);
  process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`server: ${signal} received, shutting down`);
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, BIND_HOST, () => {
  console.error(
    `server: ${BIND_HOST}:${PORT}; store ${DB_PATH}; scope ${SCOPE}; n8n ${N8N_API_URL}; ` +
    `sync ${SYNC_INTERVAL}s; poll ${POLL_INTERVAL}s; retention ${RETENTION_DAYS}d; ` +
    `expectations ${pack.expectations.length}; alerts ${ALERTS.enabled ? 'on' : 'off'}; ` +
    `push ${PUSH.url ? 'on' : 'off'}; heartbeat ${HEARTBEAT.url ? 'on' : 'off'}; ` +
    `ingest ${INGEST_TOKEN ? 'on' : 'off'}; datatables ${TABLES.length ? TABLES.join(',') : 'off'}; ` +
    `mcp ${tools.length} tools; n8n timeout ${N8N_TIMEOUT_MS}ms`,
  );
});

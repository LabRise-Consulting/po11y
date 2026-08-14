// The single owner of persistent state. Everything the dashboard used to read
// from JSON files on a shared volume lives here instead, which removes the
// class of failures where file ownership, inode identity or file-vs-directory
// semantics differed between the Docker daemon, the host and CI.
//
// Execution rows are stored in the exact shape /api/v1/executions returns, so
// summarizeExecutions(), fetchStatus() and evaluateAlerts() consume them with
// no adapter. An adapter here would be a second place for feed shape to drift.
//
// Two handles, on purpose: the daemon writes through openDb(), and expectation
// packs — operator input, but still input — are evaluated through
// openReadOnlyDb() so a mistyped statement cannot empty the store.
import { DatabaseSync } from 'node:sqlite';
import { FAILED_STATUSES } from './exec-status.mjs';

// The failed-status set as a SQL literal list, composed from the ONE
// definition rather than spelled out again. exec-status.mjs exists because
// this set was once written out in three places and all three were wrong the
// same way; hand-writing IN ('error', 'crashed') here would have made four,
// and the counter triggers below are the consumer least likely to be noticed
// when someone adds a status — nothing about metrics.mjs's exported counter
// reads FAILED_STATUSES at all, it just reads the table these triggers fill.
//
// The statuses are an in-repo frozen constant, never user input, but the guard
// costs nothing and pins the assumption that makes the interpolation safe.
const FAILED_SQL = FAILED_STATUSES.map((s) => {
  if (!/^[a-z]+$/.test(s)) throw new Error(`db: FAILED_STATUSES entry ${JSON.stringify(s)} is not a safe SQL literal`);
  return `'${s}'`;
}).join(', ');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executions (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  workflow_name TEXT,
  status        TEXT,
  started_at    TEXT,
  stopped_at    TEXT,
  created_at    TEXT,
  mode          TEXT,
  seen_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_wf ON executions(workflow_id, started_at DESC);
-- recentExecutions orders by COALESCE(started_at, created_at), which the
-- plain started_at index cannot serve — every call was a full scan plus a
-- temp sort B-tree. The expression index matches the query text exactly
-- (SQLite requires a textual match), so the ORDER BY becomes an index walk.
-- The old executions_started index served nothing else; drop it.
DROP INDEX IF EXISTS executions_started;
CREATE INDEX IF NOT EXISTS executions_recent
  ON executions(COALESCE(started_at, created_at) DESC, id DESC);

CREATE TABLE IF NOT EXISTS workflows (
  id      TEXT PRIMARY KEY,
  name    TEXT,
  active  INTEGER,
  doc     TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datatable_counts (
  key        TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  PRIMARY KEY (key, sampled_at)
);
CREATE INDEX IF NOT EXISTS datatable_counts_key ON datatable_counts(key, sampled_at DESC);

-- Monotonic failed-execution counter, per workflow.
--
-- WHY A SEPARATE TABLE AND NOT count(*) OVER executions: pruneExecutions
-- deletes rows past PO11Y_RETENTION_DAYS, so a count over the table falls as
-- history ages out. Prometheus reads any decrease in a _total as a counter
-- reset and emits a bogus spike. This table only ever increments.
--
-- It also fixes what the collector did: it accumulated the same total in
-- memory, so every collector restart reset the series to zero — a reset
-- Prometheus believed, several times a week.
CREATE TABLE IF NOT EXISTS workflow_error_totals (
  workflow_id TEXT PRIMARY KEY,
  total       INTEGER NOT NULL DEFAULT 0
);

-- Two triggers, because an execution can arrive already-failed or fail later,
-- and a pushed event can arrive with no workflow id at all.
--
-- The UPDATE trigger's guard is what makes the count exactly-once: the
-- executions upsert always assigns \`status\`, so an unguarded trigger would
-- count the same failure again on every poll that re-sees the row. Counting
-- only on a transition INTO the failed set — or on the poll that first
-- attributes an already-failed row to a workflow — fires once per execution.
--
-- DROP before CREATE, not CREATE IF NOT EXISTS: a trigger is stateless, so
-- recreating it on every open is free and idempotent — and it is the only way
-- an edit to FAILED_STATUSES (or to these guards) reaches a store that already
-- exists. IF NOT EXISTS would leave every upgraded deployment running the
-- definition it was first created with, which is exactly the silent
-- divergence composing FAILED_SQL is meant to rule out.
--
-- COALESCE on old.status, not a bare NOT IN: SQL's NOT IN yields NULL for a
-- NULL left-hand side, and \`NULL OR 0\` is NULL, so the whole WHEN clause is
-- falsy and a row stored with a NULL status that later transitions to error
-- would never be counted. No writer stores a NULL status today, so this is
-- unreachable rather than broken — but the guard's correctness should not
-- rest on three-valued logic nobody re-derives.
DROP TRIGGER IF EXISTS executions_failed_insert;
CREATE TRIGGER executions_failed_insert
AFTER INSERT ON executions
WHEN new.status IN (${FAILED_SQL}) AND COALESCE(new.workflow_id, '') <> ''
BEGIN
  INSERT INTO workflow_error_totals (workflow_id, total) VALUES (new.workflow_id, 1)
  ON CONFLICT(workflow_id) DO UPDATE SET total = total + 1;
END;

DROP TRIGGER IF EXISTS executions_failed_update;
CREATE TRIGGER executions_failed_update
AFTER UPDATE ON executions
WHEN new.status IN (${FAILED_SQL})
 AND COALESCE(new.workflow_id, '') <> ''
 AND (COALESCE(old.status, '') NOT IN (${FAILED_SQL}) OR COALESCE(old.workflow_id, '') = '')
BEGIN
  INSERT INTO workflow_error_totals (workflow_id, total) VALUES (new.workflow_id, 1)
  ON CONFLICT(workflow_id) DO UPDATE SET total = total + 1;
END;
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/**
 * A second handle for evaluating operator-supplied SQL. Never migrates: the
 * file must already exist, which it does — index.mjs opens the writer first.
 */
export function openReadOnlyDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const EXEC_UPSERT = `
INSERT INTO executions (id, workflow_id, workflow_name, status, started_at, stopped_at, created_at, mode, seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  -- COALESCE, like every other column: a pushed event carries only what its
  -- payload happened to include (parseEvent nulls the rest), and a null there
  -- means "this delivery did not say", never "the value is gone". Overwriting
  -- blind would strip the workflow association a poll had already filled in,
  -- and summarizeExecutions() skips rows with an empty workflow_id — the
  -- success would stop counting and the stale-workflow alert would fire for a
  -- workflow that is in fact succeeding.
  workflow_id   = COALESCE(excluded.workflow_id, executions.workflow_id),
  workflow_name = COALESCE(excluded.workflow_name, executions.workflow_name),
  -- Poll truth wins for every transition EXCEPT one: a late or re-delivered
  -- push 'started' event must not regress a terminal row back to 'running'.
  -- Once a row has settled (success/error/crashed) it stays outside the poll
  -- window eventually, and an unguarded overwrite would stick at 'running'
  -- forever — long enough to trip a false stuck-execution alert.
  status        = CASE
                     WHEN executions.status IN ('success', 'error', 'crashed')
                          AND excluded.status = 'running'
                     THEN executions.status
                     ELSE excluded.status
                   END,
  started_at    = COALESCE(excluded.started_at, executions.started_at),
  stopped_at    = COALESCE(excluded.stopped_at, executions.stopped_at),
  created_at    = COALESCE(excluded.created_at, executions.created_at),
  mode          = COALESCE(excluded.mode, executions.mode),
  seen_at       = excluded.seen_at`;

/**
 * Run `fn` inside one transaction so a batch of upserts costs one fsync
 * instead of one per row — node:sqlite defaults to autocommit, so without
 * this every stmt.run() in the loop below is its own transaction. ROLLBACK on
 * throw so a mid-batch failure (a bad row shape, a full disk) leaves the
 * store as it was rather than half-applied.
 */
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function upsertExecutions(db, rows, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const stmt = db.prepare(EXEC_UPSERT);
    let n = 0;
    for (const r of rows || []) {
      if (r?.id == null) continue;
      stmt.run(String(r.id), r.workflowId ?? null, r.workflowName ?? null, r.status ?? null,
        r.startedAt ?? null, r.stoppedAt ?? null, r.createdAt ?? null, r.mode ?? null, now);
      n += 1;
    }
    return n;
  });
}

export function recentExecutions(db, limit = 100, { workflowId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (workflowId != null) { where.push('workflow_id = ?'); params.push(String(workflowId)); }
  if (status != null) { where.push('status = ?'); params.push(String(status)); }
  return db.prepare(
    `SELECT id, workflow_id, workflow_name, status, started_at, stopped_at, created_at, mode
     FROM executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT ?`,
  ).all(...params, limit).map((r) => ({
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    status: r.status,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    createdAt: r.created_at,
    mode: r.mode,
  }));
}

/**
 * Retention. Without it the table grows forever and — worse than disk — every
 * unwindowed expectation (`COUNT(*) WHERE status='success'`) becomes
 * permanently true, so the watchdog that was supposed to catch a silent night
 * reports success from a run three months ago. seen_at is the fallback so a row
 * with no timestamps at all is still eligible.
 */
export function pruneExecutions(db, cutoffIso) {
  const info = db.prepare(
    'DELETE FROM executions WHERE COALESCE(started_at, created_at, seen_at) < ?',
  ).run(cutoffIso);
  return Number(info.changes ?? 0);
}

export function upsertWorkflows(db, workflows, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT INTO workflows (id, name, active, doc, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active,
         doc = excluded.doc, seen_at = excluded.seen_at`,
    );
    let n = 0;
    for (const w of workflows || []) {
      if (w?.id == null) continue;
      stmt.run(String(w.id), w.name ?? null, w.active ? 1 : 0, JSON.stringify(w), now);
      n += 1;
    }
    return n;
  });
}

export function allWorkflows(db) {
  return db.prepare('SELECT doc FROM workflows').all().map((r) => JSON.parse(r.doc));
}

/**
 * Drop workflows a sync did not see. upsertWorkflows stamps seen_at = now on
 * every row from a fetch, so any row still carrying an EARLIER seen_at after
 * a successful full sync is one n8n no longer reports — deleted or archived
 * — and would otherwise survive forever: map.json/forms.json would keep
 * rendering it (a form button that 404s in n8n) and the stale-workflow alert
 * would fire for it with no possible recovery. Callers MUST only call this
 * after a successful full fetch (see sync.mjs's syncWorkflows) — never on a
 * partial/failed one, or an n8n outage would read as "everything else was
 * deleted".
 */
export function pruneWorkflowsNotSeenSince(db, seenSinceIso) {
  const info = db.prepare('DELETE FROM workflows WHERE seen_at < ?').run(seenSinceIso);
  return Number(info.changes ?? 0);
}

/**
 * One row-count sample for a data table, keyed by name (matching the
 * PO11Y_DATATABLES env contract, not n8n's internal id — an id survives a
 * table rename worse than a name does, and the expectation SQL in
 * packs/example.json reads by name). (key, sampled_at) overwrites rather
 * than duplicates so a retried or re-run poll tick cannot double-count.
 */
export function recordTableCount(db, key, rows, sampledAt) {
  db.prepare(
    `INSERT INTO datatable_counts (key, rows, sampled_at) VALUES (?, ?, ?)
     ON CONFLICT(key, sampled_at) DO UPDATE SET rows = excluded.rows`,
  ).run(String(key), Number(rows), sampledAt);
}

/**
 * Retention for the datatable_counts series, mirroring pruneExecutions —
 * without it this series also grows forever. sampled_at is always set (it is
 * never optional the way execution timestamps are), so there is no
 * COALESCE fallback needed here.
 */
export function pruneDatatableCounts(db, cutoffIso) {
  const info = db.prepare('DELETE FROM datatable_counts WHERE sampled_at < ?').run(cutoffIso);
  return Number(info.changes ?? 0);
}

export function getKv(db, k) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? row.v : null;
}

export function setKv(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, String(v));
}

/** Monotonic failed-execution totals, keyed by workflow id. */
export function errorTotals(db) {
  const rows = db.prepare('SELECT workflow_id, total FROM workflow_error_totals').all();
  return new Map(rows.map((r) => [String(r.workflow_id), Number(r.total) || 0]));
}

/** Epoch ms of each workflow's most recent successful execution. */
export function lastSuccessByWorkflow(db) {
  const rows = db.prepare(
    `SELECT workflow_id, MAX(stopped_at) AS last_ok
     FROM executions
     WHERE status = 'success' AND stopped_at IS NOT NULL AND COALESCE(workflow_id, '') <> ''
     GROUP BY workflow_id`,
  ).all();
  const out = new Map();
  for (const r of rows) {
    const ms = Date.parse(r.last_ok);
    if (Number.isFinite(ms)) out.set(String(r.workflow_id), ms);
  }
  return out;
}

/**
 * Age in seconds of each workflow's oldest still-running execution. The OLDEST
 * one is what a "stuck" threshold is about, so this takes MIN(started_at).
 */
export function oldestRunningByWorkflow(db, now = Date.now()) {
  const rows = db.prepare(
    `SELECT workflow_id, MIN(started_at) AS oldest
     FROM executions
     WHERE status = 'running' AND started_at IS NOT NULL AND COALESCE(workflow_id, '') <> ''
     GROUP BY workflow_id`,
  ).all();
  const out = new Map();
  for (const r of rows) {
    const ms = Date.parse(r.oldest);
    if (Number.isFinite(ms)) out.set(String(r.workflow_id), Math.max(0, Math.floor((now - ms) / 1000)));
  }
  return out;
}

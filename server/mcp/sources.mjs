// Source adapters. Every source is independently optional: a deployment may
// have all five, or only the feed volume. Availability is a first-class answer
// (see unavailable()), because a monitoring tool returning an empty list where
// it meant "I cannot see" is the one failure mode that matters.

import { apiGet } from '../n8n.mjs';
import { recentExecutions, allWorkflows } from '../db.mjs';

/**
 * The structured answer a tool returns when the source it needs is absent.
 * Never an empty result — that reads as "nothing is wrong".
 *
 * varName is the OPERATOR-facing name, not the container-facing one, and every
 * caller must spell a given source the same way. The ops key is the case that
 * matters: the process reads N8N_API_KEY, but docker-compose.yml maps
 * MCP_N8N_API_KEY onto it, so MCP_N8N_API_KEY is what an operator of the
 * bundled stack actually sets — and docker-compose.readonly.yml's N8N_API_KEY
 * is already set for the server, which means the answer is never seen there.
 *
 * @param {string} tool
 * @param {string} varName - the env var an operator would set to enable it
 */
export function unavailable(tool, varName) {
  return {
    error: 'unavailable',
    tool,
    reason: `${tool} is not available in this deployment: ${varName} is unset.`,
  };
}

// The single home of the feed-name list. registry.mjs pairs these with
// agent-facing descriptions; a registry test pins nginx.conf and the k8s
// nginx copy to the same five.
export const FEED_NAMES = ['status.json', 'notifications.json', 'map.json', 'ai-map.json', 'forms.json'];

/**
 * Prometheus read adapter. Two endpoints only: instant and range query.
 *
 * @param {{url: string, fetchFn?: typeof fetch}} opts
 */
export function makePrometheus({ url, fetchFn = fetch }) {
  const base = String(url || '').replace(/\/$/, '');
  async function call(path) {
    const res = await fetchFn(base + path, { method: 'GET' });
    // Report the source and status, never the URL: it may carry userinfo.
    if (!res.ok) throw new Error(`prometheus: query failed with ${res.status}`);
    const body = await res.json();
    if (body.status !== 'success') throw new Error(`prometheus: ${body.error || 'query rejected'}`);
    return body.data;
  }
  return {
    available: () => Boolean(base),
    query: (q) => call(`/api/v1/query?query=${encodeURIComponent(q)}`),
    queryRange: (q, start, end, step) => call(
      `/api/v1/query_range?query=${encodeURIComponent(q)}`
      + `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      + `&step=${encodeURIComponent(step)}`),
  };
}

/**
 * n8n public API adapter. Deliberately a thin wrapper over n8n.mjs's apiGet:
 * sharing that function keeps ONE choke point in the codebase that can talk
 * to n8n, and it hard-codes method:'GET'.
 *
 * Two URLs, on purpose. `url` is where this process SENDS requests; publicUrl
 * (N8N_PUBLIC_URL) is what a reader OPENS. In the bundled stack the first is
 * the container-network address — docker-compose.yml passes
 * MCP_N8N_API_URL, default http://n8n:5678 — which resolves inside the compose
 * network and nowhere else, so a link built from it is dead on arrival for the
 * operator or the remote agent reading the answer. publicUrl defaults to `url`,
 * which is exactly right for the single-host case where the two coincide.
 *
 * The field is called linkBase rather than baseUrl so that a future link site
 * cannot reach for the request URL out of habit: there is no longer a
 * plausibly-named field on this adapter that yields the unroutable address.
 *
 * @param {{url: string, apiKey: string, publicUrl?: string, fetchFn?: typeof fetch}} opts
 */
export function makeN8n({ url, apiKey, publicUrl = '', fetchFn = fetch }) {
  return {
    available: () => Boolean(url && apiKey),
    linkBase: String(publicUrl || url || '').replace(/\/$/, ''),
    get: (path) => apiGet(fetchFn, url, apiKey, path),
  };
}

/**
 * The read-only gate for po11y_sql. Runs BEFORE any request is built, so a
 * rejected statement never reaches the network.
 *
 * Defence-in-depth: what makes "read-only" true is the po11y_ro database role
 * behind Grafana's datasource (SELECT-only, credentials_entity and
 * execution_data denied — see bootstrap.sh). This guard exists so a rejected
 * statement fails fast with a useful error instead of a datasource 500. Keep
 * it strict and boring.
 *
 * @param {string} sql
 * @returns {string} the normalised statement
 */
export function assertSelect(sql) {
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('po11y_sql accepts a single SELECT statement');
  }
  if (trimmed.includes(';')) {
    throw new Error('po11y_sql accepts a single statement; remove the ";"');
  }
  if (/\binto\b/i.test(trimmed)) {
    throw new Error('po11y_sql rejects SELECT ... INTO; it is not read-only');
  }
  return trimmed;
}

/**
 * n8n's database, reached through Grafana's datasource proxy.
 *
 * Zero runtime dependencies rules out a Postgres client (wire protocol, SCRAM
 * auth). The bundled stack already provisions the datasource that four of the
 * five Grafana alert rules query
 * (observability/grafana/provisioning/datasources/datasources.yml), so SQL
 * travels as plain HTTP JSON. The datasource authenticates as the read-only
 * po11y_ro role (bootstrap.sh), not as n8n's own DB user. The read-only stack
 * (docker-compose.readonly.yml) provisions no such datasource, so the
 * capability is off there by construction rather than by configuration.
 *
 * @param {{url: string, token?: string, datasourceUid: string, fetchFn?: typeof fetch}} opts
 */
export function makeGrafana({ url, token = '', datasourceUid, fetchFn = fetch }) {
  const base = String(url || '').replace(/\/$/, '');
  return {
    available: () => Boolean(base),
    /**
     * @param {string} sql - must be a single SELECT
     * @param {{from?: string, to?: string}} window - Grafana time range strings
     * @returns {Promise<{columns: string[], rows: any[][], truncated: boolean}>}
     */
    async query(sql, { from = 'now-7d', to = 'now' } = {}) {
      const rawSql = assertSelect(sql);
      const headers = { 'content-type': 'application/json' };
      // Only needed where anonymous Viewer access is off; Viewer may query
      // datasources, which is how the embedded dashboards render.
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchFn(`${base}/api/ds/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from, to,
          queries: [{ refId: 'A', datasource: { uid: datasourceUid }, rawSql, format: 'table', rawQuery: true }],
        }),
      });
      // Status only: the token must never be reconstructable from an error.
      if (!res.ok) throw new Error(`grafana: datasource query failed with ${res.status}`);
      const body = await res.json();
      const frame = (((body.results || {}).A || {}).frames || [])[0];
      if (!frame) return { columns: [], rows: [], truncated: false };
      const columns = ((frame.schema || {}).fields || []).map((f) => f.name);
      const values = frame.data.values || [];
      const height = values[0] ? values[0].length : 0;
      const rows = [];
      // Well-formed Grafana table frames have equal-length columns.
      for (let i = 0; i < height; i++) rows.push(values.map((col) => col[i]));
      return { columns, rows, truncated: false };
    },
  };
}

/**
 * The dashboard's nginx proxy path for n8n Data Tables. Exported because it is
 * also the ONLY endpoint shape the MCP content tools can serve: the browser
 * fetches a tab's endpoint same-origin whatever it is, but this process has to
 * know which requests may carry n8n's key.
 */
export const N8N_TABLE_PREFIX = '/n8n-table/';
const PROXY_PREFIX_RE = new RegExp(`^${N8N_TABLE_PREFIX}`);

/**
 * n8n Data Tables, read through the same read-scoped key the dashboard's
 * /n8n-table/ proxy uses (scope: "data-table row: read"). Deliberately a
 * DIFFERENT key from the ops one, so content access and execution visibility
 * can be granted independently.
 *
 * Endpoints in config.json are written for the browser
 * ("/n8n-table/data-tables/<id>/rows"); server-side they are rewritten onto the
 * n8n API ("/api/v1/data-tables/<id>/rows").
 *
 * @param {{n8nUrl: string, readKey: string, fetchFn?: typeof fetch}} opts
 */
export function makeDataTables({ n8nUrl, readKey, fetchFn = fetch }) {
  const base = String(n8nUrl || '').replace(/\/$/, '');
  return {
    available: () => Boolean(base && readKey),
    base,
    /** @param {string} url a /n8n-table/ proxy path, or an absolute URL */
    async fetchJson(url) {
      const rewritten = String(url).replace(PROXY_PREFIX_RE, '/api/v1/');
      // The rewrite is what proves the request targets n8n. A tab's endpoint
      // may be any absolute URL (docs/configuration.md); the browser fetches
      // those same-origin with no key at all, so attaching n8n's key here
      // would hand it to whatever host the config happens to name.
      const toN8n = rewritten !== String(url);
      if (!toN8n && !/^https?:\/\//i.test(url)) {
        throw new Error('n8n data table: a relative endpoint must be a /n8n-table/ proxy path');
      }
      const headers = { accept: 'application/json' };
      if (toN8n) headers['X-N8N-API-KEY'] = readKey;
      const res = await fetchFn(toN8n ? base + rewritten : String(url), {
        method: 'GET',
        headers,
      });
      if (!res.ok) throw new Error(`n8n data table: request failed with ${res.status}`);
      return res.json();
    },
  };
}

/**
 * Feeds adapter over the server's own in-memory cache, not a file read.
 *
 * Availability here means "has a rebuild ever published these feeds", NOT "is
 * a source configured": the server IS the publisher, so there is no external
 * volume that can be absent. What CAN be absent is a build.
 * Before the first rebuild `cached` holds index.mjs's cold-start DEFAULTS, and
 * notifications.json's default is `[]`, not `null` — which reads as "a writer
 * ran and found nothing" and made po11y_incidents answer "no open failures"
 * from a process whose watchdog had never executed. That is the exact failure
 * this file's header exists to forbid, so "never built" is a first-class
 * unavailable answer rather than a document-level null.
 *
 * getBuiltAtMs is seeded from the store (cache.mjs seedBuiltAt), so a restart
 * onto a warm persisted cache counts as built and keeps serving the last-good
 * ai-map and notification history.
 *
 * ageSeconds is rebuild-relative — every feed in `cached` is refreshed by the
 * same rebuild(), so one timestamp serves all five.
 */
export function makeCachedFeeds({ getFeeds, getBuiltAtMs }) {
  const built = () => getBuiltAtMs() != null;
  // The per-feed null survives on top of the build check: ai-map.json is null
  // whenever the LLM never produced one, even on a server that has rebuilt
  // many times, and the tools distinguish that from "no feeds at all".
  const doc = (name) => (built() ? getFeeds()[name] ?? null : null);
  return {
    available: built,
    read(name) {
      const value = doc(name);
      if (value == null) throw new Error(`${name} has not been built yet`);
      return value;
    },
    readSafe: doc,
    ageSeconds() {
      const t = getBuiltAtMs();
      return t == null ? null : Math.round((Date.now() - t) / 1000);
    },
  };
}

/**
 * Executions/workflows out of the sqlite store. Async-shaped even though
 * sqlite is sync, so tools written as `await store.recent(...)` work the
 * same regardless of the backing store.
 *
 * `enabled` is the same predicate makeN8n uses (a URL and a key), because the
 * sync/poll loop is the only thing that fills this store — with no key,
 * index.mjs starts no timers at all and every query returns rows that are
 * absent (workflows) or frozen at whatever the last keyed run left behind
 * (executions). Answering `{count: 0, summary: "No executions matched."}` from
 * a store nothing is writing is a false all-clear, so the tools must be told
 * they cannot see rather than shown an empty table.
 */
export function makeStore({ db, enabled = true }) {
  return {
    available: () => enabled,
    recent: async ({ workflowId = null, status = null, limit = 20 } = {}) =>
      recentExecutions(db, limit, { workflowId, status }),
    workflows: async () => allWorkflows(db),
  };
}

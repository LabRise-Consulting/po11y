// Source adapters. Every source is independently optional: a deployment may
// have all five, or only the feed volume. Availability is a first-class answer
// (see unavailable()), because a monitoring tool returning an empty list where
// it meant "I cannot see" is the one failure mode that matters.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { apiGet } from '../collector/collect.mjs';

/**
 * The structured answer a tool returns when the source it needs is absent.
 * Never an empty result — that reads as "nothing is wrong".
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

/**
 * The five dashboard feeds on the shared volume. Mode-agnostic: Mode A's n8n
 * workflows and Mode B's collector write the same files.
 *
 * @param {{statusDir: string}} opts
 */
export function makeFeeds({ statusDir }) {
  const path = (name) => join(statusDir, name);
  return {
    available: () => existsSync(statusDir),
    read(name) { return JSON.parse(readFileSync(path(name), 'utf8')); },
    readSafe(name) { try { return this.read(name); } catch { return null; } },
    /** Seconds since the feed was last written, or null if it is not there. */
    ageSeconds(name) {
      try { return Math.round((Date.now() - statSync(path(name)).mtimeMs) / 1000); }
      catch { return null; }
    },
  };
}

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
 * n8n public API adapter. Deliberately a thin wrapper over the collector's
 * apiGet: sharing that function keeps ONE choke point in the codebase that can
 * talk to n8n, and it hard-codes method:'GET'.
 *
 * @param {{url: string, apiKey: string, fetchFn?: typeof fetch}} opts
 */
export function makeN8n({ url, apiKey, fetchFn = fetch }) {
  return {
    available: () => Boolean(url && apiKey),
    baseUrl: String(url || '').replace(/\/$/, ''),
    get: (path) => apiGet(fetchFn, url, apiKey, path),
  };
}

/**
 * The read-only gate for po11y_sql. Runs BEFORE any request is built, so a
 * rejected statement never reaches the network.
 *
 * This is belt-and-braces: Grafana's postgres datasource is itself configured
 * with n8n's credentials, so the guard is what makes "read-only" true, not the
 * database role. Keep it strict and boring.
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
 * auth). Mode A already provisions the datasource that the four Mode A alert
 * rules query (observability/grafana/provisioning/datasources/datasources.yml),
 * so SQL travels as plain HTTP JSON and no new database role or password
 * exists. Mode B has no such datasource, so the capability is off there by
 * construction rather than by configuration.
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
 * Probe the environment once at boot and build every adapter.
 * @param {NodeJS.ProcessEnv} env
 */
export async function detectSources(env = process.env) {
  return {
    feeds: makeFeeds({ statusDir: env.STATUS_DIR || '/po11y-status' }),
    prometheus: makePrometheus({ url: env.PROMETHEUS_URL || '' }),
    n8n: makeN8n({ url: env.N8N_API_URL || '', apiKey: env.N8N_API_KEY || '' }),
    grafana: makeGrafana({
      url: env.GRAFANA_URL || '',
      token: env.GRAFANA_SA_TOKEN || '',
      datasourceUid: env.GRAFANA_DATASOURCE_UID || 'n8n-postgres',
    }),
    datatables: makeDataTables({
      n8nUrl: env.N8N_API_URL || env.N8N_INTERNAL_URL || 'http://n8n:5678',
      readKey: env.N8N_READ_API_KEY || '',
    }),
  };
}

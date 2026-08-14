// Data-table row-count sampling. Optional, env-gated by
// PO11Y_DATATABLES: a comma-separated list of data-table NAMES on the n8n
// instance. Every poll tick, one row-count sample per named table lands in
// datatable_counts, so an expectation pack can watch growth over a window
// instead of only watching that a workflow *ran* — a workflow that runs and
// writes nothing is exactly the failure this exists to surface (see
// expectations.mjs's header comment).
//
// The n8n Data Table API, as observed on a 2.29 instance with
// N8N_READ_API_KEY scoped to data-table reads:
//
//   GET {baseUrl}/api/v1/data-tables?limit=250
//     -> { data: [{ id, name, projectId, columns, ... }, ...], nextCursor }
//   The public /api/v1 surface, flat (NOT /api/v1/projects/{id}/data-tables
//   as the n8n docs for some versions suggest — that path 404s here).
//
//   GET {baseUrl}/api/v1/data-tables/{id}/rows?limit=N
//     -> { data: [...rows], nextCursor }
//   `limit` caps at 250. `nextCursor` is an opaque base64 string
//   ({limit,offset} decoded), null/absent on the last page.
//
//   Total count: ABSENT on that build. No `count`/`total` field on either
//   endpoint, no X-Total-Count/Content-Range header. Counting a table
//   requires paging every row page and summing lengths — there is no
//   cheaper query. parseCount()'s `count`-field branch is kept anyway: it
//   costs nothing here and other n8n builds/versions may include one, in
//   which case a single request is enough and no paging is needed.
//
//   Scopes: the key must carry data-table read scope, and a key scoped that
//   narrowly returns 403 for workflow and execution reads. That only matters
//   if the *same* key is reused for sync (server/sync.mjs), which polls with
//   a different, wider-scoped key.
//
// GET-only: every request goes through apiGet() (server/n8n.mjs),
// which hard-codes method:'GET' — see n8n.mjs's own GET-only test.

import { apiGetPaged } from './n8n.mjs';
import { recordTableCount } from './db.mjs';

const ROWS_PAGE_LIMIT = 250;
// A hard ceiling on pages-per-sample so a misbehaving cursor (or a table
// that has genuinely grown past anything PO11Y_DATATABLES was meant to
// watch) cannot page forever inside a single poll tick. 40 * 250 = 10,000
// rows — far past anything the shipped pack's tables need, and a capped
// sample is loudly logged rather than silently short.
const PAGE_CAP = 40;

/**
 * Pull a row count out of whatever a data-table endpoint returned. Some n8n
 * builds may include an explicit total (`count`); the build probed for this
 * task does not, so the fallback — the length of the `data` array on the
 * page in hand — is what actually gets exercised here. Returns null when
 * neither shape is present, so callers can distinguish "zero rows" from
 * "not a countable response".
 *
 * @param {any} body - a parsed JSON response
 * @returns {number|null}
 */
export function parseCount(body) {
  if (body && typeof body.count === 'number') return body.count;
  if (body && Array.isArray(body.data)) return body.data.length;
  return null;
}

/**
 * List every data table on the instance and index it by name. Paged the
 * same way fetchAllWorkflows pages workflows: follow nextCursor, guard
 * against a cursor the server hands back twice.
 */
async function resolveTableIds(fetchFn, baseUrl, apiKey) {
  const map = new Map();
  for await (const page of apiGetPaged(fetchFn, baseUrl, apiKey, '/api/v1/data-tables', { limit: '250' })) {
    for (const t of page?.data || []) {
      if (t?.name != null && t?.id != null) map.set(String(t.name), String(t.id));
    }
  }
  return map;
}

/**
 * Count every row in one data table, paging until nextCursor is absent or
 * the page cap is hit. If the very first page carries an authoritative
 * `count`, trust it and stop — an empty `data[]` alongside a real count is a
 * valid (if unusual) first-page shape, and re-summing per-page counts across
 * later pages would double count on a build that repeats the total on every
 * page. Can also throw before either of those — apiGetPaged rejects a
 * cursor it has already seen, so a table stuck on a repeating cursor fails
 * fast instead of returning a silently inflated count; sampleTables' caller
 * catches this and the table is skipped for the tick.
 */
async function countRows(fetchFn, baseUrl, apiKey, id, name) {
  let total = 0;
  let pages = 0;
  for await (const page of apiGetPaged(
    fetchFn, baseUrl, apiKey,
    `/api/v1/data-tables/${encodeURIComponent(id)}/rows`,
    { limit: String(ROWS_PAGE_LIMIT) },
  )) {
    if (pages === 0 && typeof page?.count === 'number') return page.count;
    total += parseCount(page) ?? 0;
    pages += 1;
    if (page?.nextCursor && pages >= PAGE_CAP) {
      console.error(
        `server: datatable sampling — "${name}" hit the ${PAGE_CAP}-page cap `
        + `(~${total} rows counted so far) — this sample is capped, not exact`,
      );
      return total;
    }
  }
  return total;
}

/**
 * Record one row-count sample per configured table. GET-only; a failure on
 * one target (unresolved name, transient 4xx/5xx on its rows page) is caught
 * and logged so it cannot stop the rest — a bad name typo'd into
 * PO11Y_DATATABLES must degrade, not take down the whole poll tick. A
 * failure resolving the table list itself (n8n unreachable, key rejected)
 * likewise degrades to zero samples rather than throwing, matching the
 * pattern pollFill's caller already tolerates for the executions poll.
 *
 * @param {object} db - a writable handle (openDb)
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string[]} targets - data-table NAMES, from PO11Y_DATATABLES
 * @param {number} now - ms since epoch
 * @returns {Promise<number>} number of samples stored
 */
export async function sampleTables(db, fetchFn, baseUrl, apiKey, targets, now) {
  const names = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (!names.length) return 0;

  let idByName;
  try {
    idByName = await resolveTableIds(fetchFn, baseUrl, apiKey);
  } catch (e) {
    console.error(`server: datatable sampling — could not list data tables — ${e.message}`);
    return 0;
  }

  const sampledAt = new Date(now).toISOString();
  let stored = 0;
  for (const name of names) {
    try {
      const id = idByName.get(name);
      if (!id) throw new Error(`no data table named "${name}" on this instance`);
      const rows = await countRows(fetchFn, baseUrl, apiKey, id, name);
      recordTableCount(db, name, rows, sampledAt);
      stored += 1;
    } catch (e) {
      console.error(`server: datatable sampling — "${name}" — ${e.message}`);
    }
  }
  return stored;
}

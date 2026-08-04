// Content tools — the data Po11y's workflows produced.
//
// Entirely config-driven: every tabs[].list entry in config.json is a dataset
// whose `mapping` block already declares what each column means, so no
// per-instance tool code exists. Rows are returned as mapped card fields
// (title/url/score/day/badge/meta/detail), never raw columns.

import { walkPages, sortItems, filterByRange } from '../../lib/list-rows.mjs';
import { unavailable, N8N_TABLE_PREFIX } from '../sources.mjs';
import { clampLimit } from './ops.mjs';

/**
 * Every tab that declares a `list` block, keyed by tab id.
 *
 * Defensive against a non-object config even though buildRegistry() already
 * normalizes one: JSON.parse('null') returns null without throwing, so a
 * try/catch around the parse alone does not stop a malformed config.json
 * from reaching here as anything but an array-shaped `tabs`.
 */
function datasets(config) {
  const tabs = config && Array.isArray(config.tabs) ? config.tabs : [];
  return tabs.filter((t) => t && t.list && t.list.endpoint);
}
const find = (config, id) => datasets(config).find((t) => t.id === id);

/**
 * Can this process read the dataset at all? A tab's endpoint may also be any
 * static JSON, absolute or relative (docs/configuration.md) — the browser
 * fetches all of those same-origin, but only a /n8n-table/ proxy path rewrites
 * onto the n8n API, which is the only feed this server can authenticate to.
 */
const serveable = (tab) => String(tab.list.endpoint || '').startsWith(N8N_TABLE_PREFIX);

/**
 * Say *why* a dataset cannot be read, rather than falling through to
 * unavailable('…', 'N8N_READ_API_KEY'): a static feed needs no key at all, so
 * naming that variable would send an operator to set a key that changes
 * nothing. Same discipline as unavailable() — never an empty result.
 *
 * @param {string} tool
 * @param {{id: string, list: {endpoint: string}}} tab
 */
function unserveable(tool, tab) {
  return {
    error: 'unsupported endpoint',
    tool,
    dataset: tab.id,
    reason: `${tool} reads datasets through the ${N8N_TABLE_PREFIX} proxy path; dataset `
      + `"${tab.id}" is served from "${tab.list.endpoint}", which only the browser tab can fetch.`,
  };
}

/**
 * Today as a UTC date-only string, the form filterByRange expects.
 *
 * Must be UTC, not the process's local zone: lib/list-rows.mjs's dayOf,
 * rangeCutoff and isoMinus are all UTC-derived from row timestamps, and this
 * process has no local human observer to serve (contrast site/list.html's
 * identically-named, deliberately-local todayIso — that one renders for a
 * person in a browser). Using local time here would make a `range: 'today'`
 * query silently drop rows for the last hour or two of each UTC day whenever
 * the container's TZ (docker-compose.yml default: Europe/Berlin) runs ahead
 * of UTC.
 */
export function todayIso(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    + `-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Pull a dataset's rows. forceIdSort is ON here and OFF in the browser: the
 * walk must be exact (docs/configuration.md:287), and the caller re-sorts
 * afterwards anyway.
 */
async function loadRows(tables, tab, { range = 'all', maxPages = 8 } = {}) {
  return walkPages((u) => tables.fetchJson(u), {
    endpoint: tab.list.endpoint,
    mapping: tab.list.mapping || {},
    pageSize: tab.list.pageSize || 250,
    maxPages,
    range,
    today: todayIso(),
    base: tables.base,
    forceIdSort: true,
  });
}

/** What datasets exist, and what each of their fields means. */
export function datasetsTool({ datatables }, config) {
  return {
    name: 'po11y_datasets',
    title: 'List content datasets',
    description: 'The datasets this Po11y instance publishes — the rows its workflows produced — '
      + 'with the meaning of every field. Call this before po11y_rows.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const list = datasets(config).map((t) => ({
        id: t.id,
        label: t.label || t.list.title || t.id,
        source: t.list.endpoint,
        default_sort: t.list.defaultSort || 'day',
        default_range: t.list.defaultRange || 'all',
        fields: t.list.mapping || {},
      }));
      return {
        datasets: list,
        summary: list.length
          ? `${list.length} dataset${list.length === 1 ? '' : 's'}: ${list.map((d) => d.id).join(', ')}.`
          : 'This instance has no list datasets configured (no tabs[].list entry in config.json).',
        rows_available: datatables.available(),
      };
    },
  };
}

/** Filtered rows from one dataset. */
export function rowsTool({ datatables }, config) {
  return {
    name: 'po11y_rows',
    title: 'Query a content dataset',
    description: 'Rows from one dataset, filtered and sorted. Fields come back with the meanings '
      + 'po11y_datasets reports.',
    inputSchema: {
      type: 'object',
      required: ['dataset'],
      properties: {
        dataset: { type: 'string', description: 'Dataset id from po11y_datasets.' },
        range: { type: 'string', enum: ['all', 'today', '7d', '30d'], description: 'Rolling window over the day field.' },
        minScore: { type: 'number', description: 'Drop rows scoring below this.' },
        badge: { type: 'string', description: 'Restrict to one badge value (provenance).' },
        match: { type: 'string', description: 'Case-insensitive substring over title, meta and badge.' },
        sort: { type: 'string', enum: ['day', 'score'], description: 'Newest first, or best score first.' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 500).' },
        maxPages: { type: 'number', description: 'Page budget for the walk (default 8, max 50).' },
      },
    },
    async handler({ dataset, range = 'all', minScore, badge = '', match = '',
                    sort = 'day', limit = 50, maxPages = 8 } = {}) {
      const tab = find(config, dataset);
      if (!tab) {
        return { error: `unknown dataset: ${dataset}`, known: datasets(config).map((t) => t.id) };
      }
      // Before the availability check: a dataset this server cannot fetch is
      // not made fetchable by setting the read key, so saying so first is the
      // honest capability answer.
      if (!serveable(tab)) return unserveable('po11y_rows', tab);
      if (!datatables.available()) return unavailable('po11y_rows', 'N8N_READ_API_KEY');

      // Both budgets are caller-supplied: an unsanitised negative limit
      // silently drops a row, and an unsanitised maxPages issues that many
      // requests to n8n.
      const rowLimit = clampLimit(limit, 50, 500);
      const pageBudget = clampLimit(maxPages, 8, 50);
      const { rows, truncated } = await loadRows(datatables, tab, { range, maxPages: pageBudget });
      let items = filterByRange(rows, range, todayIso());
      if (typeof minScore === 'number') items = items.filter((r) => Number(r.score) >= minScore);
      if (badge) items = items.filter((r) => String(r.badge || '') === badge);
      if (match) {
        const needle = match.toLowerCase();
        items = items.filter((r) => JSON.stringify([r.title, r.meta, r.badge]).toLowerCase().includes(needle));
      }
      // normalizeRows attaches `raw` (the whole source row) for the browser's
      // detail rendering. Dropping it here roughly halves the tokens a model
      // spends on a page of rows; po11y_row keeps it for single-row reads.
      items = sortItems(items, sort).slice(0, rowLimit).map(({ raw, ...card }) => card);

      return {
        dataset,
        count: items.length,
        truncated,
        summary: truncated
          ? `${items.length} rows; the page budget truncated the walk, so older rows may be missing — raise maxPages.`
          : `${items.length} rows.`,
        rows: items,
      };
    },
  };
}

/** One row in full, including the detail array the card hides behind a toggle. */
export function rowTool({ datatables }, config) {
  return {
    name: 'po11y_row',
    title: 'Read one dataset row',
    description: 'A single row in full, including its parsed fit/gap detail rows when the dataset '
      + 'maps a detail column.',
    inputSchema: {
      type: 'object',
      required: ['dataset', 'id'],
      properties: {
        dataset: { type: 'string', description: 'Dataset id from po11y_datasets.' },
        id: { type: ['string', 'number'], description: 'Row id.' },
      },
    },
    async handler({ dataset, id } = {}) {
      const tab = find(config, dataset);
      if (!tab) {
        return { error: `unknown dataset: ${dataset}`, known: datasets(config).map((t) => t.id) };
      }
      if (!serveable(tab)) return unserveable('po11y_row', tab);
      if (!datatables.available()) return unavailable('po11y_row', 'N8N_READ_API_KEY');
      const { rows, truncated } = await loadRows(datatables, tab, { range: 'all', maxPages: 8 });
      const row = rows.find((r) => String(r.id) === String(id));
      if (row) return { dataset, row };
      // A truncated walk only proves the id was not among the rows scanned,
      // not that it does not exist — an older row in a larger table can sit
      // past the page budget. Asserting "not found" there would be a wrong
      // answer, not an honest "I did not look that far" (po11y_rows already
      // makes this distinction; see its `truncated` field above).
      return truncated
        ? { error: `row not found in the ${rows.length} rows scanned; the page budget truncated `
            + 'the walk before reaching the end, so this row may exist further back', dataset }
        : { error: `row not found: ${id}`, dataset };
    },
  };
}

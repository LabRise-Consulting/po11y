// Pure, dependency-free helpers for the generic list tab. Imported by
// site/list.html (browser), mcp/tools/content.mjs (the MCP content tools) and
// lib/list-rows.test.mjs (node --test). No DOM here.

// Accept the three shapes a feed can arrive in and return the row array.
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;   // n8n DataTable
  if (payload && Array.isArray(payload.items)) return payload.items; // exported feed
  return [];
}

const dayOf = (v) => {
  if (!v) return 'unknown';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);            // ISO → date-only
  return m ? m[1] : 'unknown';
};

// An optional expandable detail: a row's `detail` column may hold an array (or
// a JSON string of one) of { aspect, kind: 'fit'|'gap', assessment } objects.
// Anything unparseable or non-array yields null (card stays non-expandable).
export function parseDetail(v) {
  if (v == null || v === '') return null;
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return null; }
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      aspect: String(r.aspect ?? ''),
      kind: r.kind === 'gap' ? 'gap' : 'fit',
      assessment: String(r.assessment ?? ''),
    }))
    .filter((r) => r.aspect || r.assessment);
}

export function normalizeRows(payload, mapping) {
  const m = mapping || {};
  return rowsOf(payload).map((r) => {
    const meta = {};
    for (const k of m.meta || []) meta[k] = r[k] ?? null;
    const scoreRaw = m.score ? r[m.score] : null;
    // An optional provenance pill rendered beside the title, for feeds that
    // merge several upstreams (e.g. which job board an ad came from). Kept
    // separate from `meta` so it reads as a label, not as another key: value
    // pair lost in the run-on meta line.
    const badgeRaw = m.badge ? r[m.badge] : null;
    return {
      id: r.id ?? r[m.title] ?? null,
      title: (m.title ? r[m.title] : null) ?? '(untitled)',
      url: (m.url ? r[m.url] : null) ?? null,
      score: scoreRaw === undefined || scoreRaw === null || scoreRaw === '' ? null : Number(scoreRaw),
      badge: badgeRaw === undefined || badgeRaw === null || badgeRaw === '' ? null : String(badgeRaw),
      meta,
      detail: m.detail ? parseDetail(r[m.detail]) : null,
      day: dayOf(m.day ? r[m.day] : null),
      raw: r,
    };
  });
}

export function sortItems(items, by) {
  const arr = items.slice();
  if (by === 'score') {
    arr.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  } else { // 'day'
    arr.sort((a, b) => {
      const av = a.day === 'unknown' ? '' : a.day;
      const bv = b.day === 'unknown' ? '' : b.day;
      return bv < av ? -1 : bv > av ? 1 : 0;
    });
  }
  return arr;
}

// Subtract n days from an ISO date-only string without touching Date.now().
function isoMinus(dayIso, n) {
  const d = new Date(dayIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Rolling day windows the list tab can narrow to before sorting. `days` counts
// how many days *before* today the window reaches back — every window includes
// today, so 7d is today plus the six preceding days. Rolling rather than
// calendar periods: a calendar "this week" shows a single day every Monday,
// which is when a feed is least useful. Exported so list.html builds its
// buttons from it and the key set lives in one place.
export const RANGES = [
  { key: 'all', label: 'All', days: null },
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 6 },
  { key: '30d', label: '30 days', days: 29 },
];

// Oldest date-only string still inside `key`'s window, or null for no bound.
// An unrecognised key fails open to no bound: a config typo shows too much
// rather than an empty tab. `today` is a parameter, never Date.now(), so the
// windows are testable without freezing the clock.
export function rangeCutoff(key, today) {
  const r = RANGES.find((x) => x.key === key);
  if (!r || r.days === null || !today) return null;
  return isoMinus(today, r.days);
}

export function filterByRange(items, key, today) {
  const cutoff = rangeCutoff(key, today);
  if (!cutoff) return items.slice();
  // 'unknown' must be rejected explicitly, not left to the comparison: it
  // string-sorts *above* every ISO date ('u' > '2'), so `day >= cutoff` alone
  // would keep exactly the rows that have no usable date.
  return items.filter((it) => it.day !== 'unknown' && it.day >= cutoff);
}

// The distinct badge values present in a row set, sorted so the filter buttons
// keep a stable order across walks. Rows with no badge contribute nothing: a
// feed with a single upstream (or none configured) yields an empty list, which
// is how the list tab decides not to render the filter at all.
export function badgeValues(items) {
  return [...new Set(items.map((it) => it.badge).filter((b) => b))].sort();
}

// Narrow a row set to the selected badges (the list tab's source filter).
// `selected` may be an array or a Set. An empty selection means "no filter"
// rather than "nothing": the filter starts empty, and unticking the last
// source has to return the full list, not an empty tab. Once a filter is
// active, badge-less rows are dropped — they belong to no selected source.
export function filterByBadges(items, selected) {
  const keep = selected instanceof Set ? selected : new Set(selected || []);
  if (!keep.size) return items.slice();
  return items.filter((it) => it.badge !== null && keep.has(it.badge));
}

// Has a bounded window been fully covered by the rows fetched so far? The feed
// is newest-first, so the first row older than the cutoff proves the page walk
// has passed the window's edge and further pages hold nothing in range. An
// unbounded range ('all') is never complete — only the feed running out ends it.
export function windowComplete(items, key, today) {
  const cutoff = rangeCutoff(key, today);
  if (!cutoff) return false;
  return items.some((it) => it.day !== 'unknown' && it.day < cutoff);
}

// Rows sharing a sort value have no stable order between requests, so an
// offset-paged walk can serve the same row on two pages. Dedupe on id, keeping
// the first sighting. Rows with no id are left alone — there is nothing to
// compare them on, and dropping them would lose data.
export function dedupeById(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (it.id === null || it.id === undefined) return true;
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

export function groupByDay(items, today) {
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day)) byDay.set(it.day, []);
    byDay.get(it.day).push(it);
  }
  const days = [...byDay.keys()].sort((a, b) => {
    const av = a === 'unknown' ? '' : a;
    const bv = b === 'unknown' ? '' : b;
    return bv < av ? -1 : bv > av ? 1 : 0;
  });
  const yesterday = today ? isoMinus(today, 1) : null;
  return days.map((day) => ({
    day,
    label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : day,
    items: byDay.get(day),
  }));
}

/**
 * Build one page URL for a row feed.
 *
 * `base` is only used to parse a relative endpoint; the return value keeps the
 * endpoint's own shape (path + query for a relative endpoint, absolute for an
 * absolute one), so the browser can keep calling same-origin paths.
 *
 * forceIdSort exists because n8n's DataTable cursor is an encoded
 * {limit, offset}: paging over a column with ties reorders rows between
 * requests, so an offset walk serves some rows twice and never returns others
 * (measured: 34 of each on a 657-row table — docs/configuration.md:287).
 * Sorting by the unique, insertion-ordered `id` makes the walk exact.
 *
 * @param {string} endpoint
 * @param {{pageSize?: number, cursor?: string|null, base: string, forceIdSort?: boolean}} opts
 * @returns {string}
 */
export function pageUrl(endpoint, { pageSize = 250, cursor = null, base, forceIdSort = false } = {}) {
  const u = new URL(endpoint, base);
  u.searchParams.set('limit', String(pageSize));
  if (forceIdSort) u.searchParams.set('sortBy', 'id:desc');
  if (cursor) u.searchParams.set('cursor', cursor);
  const absolute = /^https?:\/\//i.test(endpoint);
  return absolute ? u.toString() : u.pathname + u.search;
}

/**
 * Walk a row feed page by page until it runs out, the requested window is
 * provably covered, or the page budget is spent. `truncated` is true only in
 * that last case — the only one where asking for more pages can help.
 *
 * fetchJson is injected: the browser passes a window.fetch wrapper, the MCP
 * server passes a Node fetch wrapper that adds the read-scoped API key.
 *
 * @param {(url: string) => Promise<any>} fetchJson
 * @param {{endpoint: string, mapping: object, pageSize?: number, maxPages?: number,
 *          range?: string, today: string, base: string, forceIdSort?: boolean}} opts
 * @returns {Promise<{rows: object[], truncated: boolean}>}
 */
export async function walkPages(fetchJson, {
  endpoint, mapping, pageSize = 250, maxPages = 1,
  range = 'all', today, base, forceIdSort = false,
} = {}) {
  let rows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const payload = await fetchJson(pageUrl(endpoint, { pageSize, cursor, base, forceIdSort }));
    rows = dedupeById(rows.concat(normalizeRows(payload, mapping)));
    cursor = payload && payload.nextCursor;
    if (!cursor) return { rows, truncated: false };
    if (windowComplete(rows, range, today)) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

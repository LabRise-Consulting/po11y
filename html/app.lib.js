// Pure, DOM-free helpers for the dashboard shell. Imported by app.js (browser)
// and app.lib.test.mjs (node --test), the same split site/map.lib.js uses.
//
// Everything here takes its state as arguments rather than reading app.js's
// module-level `cfg`/`window`, which is what makes it testable: these are the
// functions that decide what gets escaped, which URLs are allowed, and where an
// Actions card points — the parts where a mistake is a security or correctness
// bug rather than a layout glitch.

/** Escape for HTML text and quoted attribute values alike. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Escape a URL that came from feed or config data, or refuse it.
 *
 * Escaping keeps the attribute intact but says nothing about the scheme, so
 * only http(s) and same-origin absolute paths are allowed through — a hostile
 * `javascript:` never lands. `//host/path` is excluded on purpose: it looks
 * relative but is a full cross-origin URL, so a feed could otherwise retarget
 * a dashboard link at any host it liked.
 */
export const safeUrl = (u) => {
  const s = String(u ?? '');
  if (s.startsWith('//')) return '#';
  return /^(https?:\/\/|\/)/i.test(s) ? esc(s) : '#';
};

/** The monitored n8n's host: config `baseUrl` when set, else the browser's. */
const hostOf = (cfg, hostname) =>
  (typeof cfg.baseUrl === 'string' && cfg.baseUrl) ? cfg.baseUrl : hostname;

/**
 * The n8n base URL every n8n link is built from — scheme, host and port.
 *
 * `baseUrl` alone cannot carry a remote that is not `http://<host>:5678`: an
 * n8n behind TLS on the default port needs a different scheme and no port at
 * all. `n8nUrl` holds that whole shape, `{host}` included, and this is the one
 * place it is resolved. The trailing slash goes so `{n8n}/form/x` cannot
 * double it.
 *
 * @param {{ n8nUrl?: string, baseUrl?: string }} cfg
 * @param {string} hostname
 */
export const n8nBase = (cfg = {}, hostname = '') =>
  String(cfg.n8nUrl || 'http://{host}:5678')
    .replaceAll('{host}', hostOf(cfg, hostname))
    .replaceAll('{self}', hostname)
    .replace(/\/$/, '');

/**
 * Substitute the three host placeholders that let one config work from every
 * device that can reach the box.
 *
 * `{host}` is the monitored n8n's host: config `baseUrl` wins when set,
 * otherwise the browser's own hostname. `{self}` is always the browser's own
 * hostname — the box serving this dashboard. They differ on the read-only
 * topology, where n8n lives elsewhere but Prometheus and Grafana run alongside
 * the dashboard, so a `{host}`-built link to a local service would point at
 * the remote n8n's host.
 *
 * `{n8n}` is the whole n8n base URL rather than just its host, so a config
 * never has to hardcode `http://` and `:5678` around `{host}` — which is what
 * kept a TLS or non-default-port n8n from ever being linkable. Prefer it for
 * every n8n link; `{host}` stays for anything else on that host.
 *
 * @param {string} u
 * @param {{ n8nUrl?: string, baseUrl?: string }} cfg
 * @param {string} hostname
 */
export const withHost = (u, cfg = {}, hostname = '') => String(u ?? '')
  .replaceAll('{n8n}', n8nBase(cfg, hostname))
  .replaceAll('{host}', hostOf(cfg, hostname))
  .replaceAll('{self}', hostname);

/** Coarse "how long ago", in the largest unit that stays readable. */
export const ago = (iso, now = Date.now()) => {
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (!isFinite(m)) return '?';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** Poll intervals never go below this, whatever the config says. */
export const MIN_REFRESH_MS = 1000;

/**
 * A config interval in seconds as a setInterval delay.
 *
 * Clamped: `setInterval(fn, 0)` re-runs as fast as the event loop allows, so a
 * `refreshSec: 0` typo turned the dashboard into a request flood against its
 * own feeds. Non-numeric or missing values fall back to the default.
 */
export const refreshMs = (sec, dflt = 30) => {
  const n = Number(sec ?? dflt);
  if (!Number.isFinite(n)) return dflt * 1000;
  return Math.max(MIN_REFRESH_MS, n * 1000);
};

/**
 * The form path a card triggers, in whichever shape carries it, or null.
 *
 * Config cards spell it in an href (`…/form/<path>`); discovered field-less
 * forms spell it in `action`. Deduping on href alone let an `action` card slip
 * past the "already configured" check and render a second button for the same
 * form.
 */
export const actionKey = (card) => card?.action
  || (card?.href || '').split('/form/')[1]
  || null;

/**
 * Turn forms.json into Actions cards, skipping any form the config already
 * declares.
 *
 * Two things decide the card shape:
 *
 *  - `formProxy` — whether nginx serves the same-origin `/form/` proxy
 *    (ENABLE_FORM_PROXY; true on the bundled stack, false on the read-only
 *    stack by default). Only with the proxy can a field-less form fire in
 *    place; without it the POST answers 404 and the button can do nothing
 *    but report the failure, so the card becomes a link to n8n's own form
 *    page instead.
 *  - `cfg.n8nUrl` — where that form page lives. Do not derive it from the
 *    browser host: a remote n8n is not on `http://{host}:5678`, and the Map
 *    tab's dialogs read n8nUrl, so a second source would disagree.
 *
 * @param {{forms?: Array<{name: string, sub?: string, path: string, fields?: number}>}} feed
 * @param {Array<object>} existing - cards already declared in config
 * @param {{ formProxy?: boolean, cfg?: object, hostname?: string }} opts
 */
export function formCards(feed, existing = [], { formProxy = true, cfg = {}, hostname = '' } = {}) {
  const have = new Set(existing.map(actionKey).filter(Boolean));
  const base = n8nBase(cfg, hostname);
  const out = [];
  for (const f of feed?.forms || []) {
    if (have.has(f.path)) continue;
    out.push(formProxy && f.fields === 0
      ? { name: f.name, sub: f.sub, action: f.path }
      : { name: f.name, sub: f.sub, href: `${base}/form/${f.path}` });
  }
  return out;
}

// ---- rebuild action ---------------------------------------------------------

/** The built-in "Rebuild map" card. Not config-driven on purpose: every po11y
 * has the endpoint, including deployments whose config.json was written by
 * hand before this existed, so it ships in the code rather than the template.
 */
export const REBUILD_CARD = Object.freeze({
  name: 'Rebuild map',
  sub: 'Re-read n8n and rebuild the Map and Architecture feeds now',
  post: '/rebuild',
});

/**
 * Config cards with the built-in rebuild card in front of the Actions group,
 * creating that group when the config has none. Returns a fresh object: the
 * dashboard re-renders from `cfg` repeatedly, and mutating it would stack a
 * button per render.
 *
 * @param {object|undefined} cards - config `cards` ({ "<group>": link[] })
 * @returns {object}
 */
export function withRebuildCard(cards = {}) {
  const groups = cards && typeof cards === 'object' ? cards : {};
  const actions = (groups.Actions || []).filter((c) => c?.post !== REBUILD_CARD.post);
  return { Actions: [REBUILD_CARD, ...actions], ...Object.fromEntries(
    Object.entries(groups).filter(([k]) => k !== 'Actions'),
  ) };
}

/**
 * How each answer from POST /rebuild reads in the toast. 429 is the expected
 * one — the server holds a floor between forced builds — so it says when to
 * come back rather than reporting a failure.
 *
 * @param {number} status
 * @param {{retry_after?: number}|null} [body]
 * @returns {{text: string, ok: boolean}}
 */
export function rebuildMessage(status, body = null) {
  if (status === 202) return { text: `${REBUILD_CARD.name}: rebuilding…`, ok: true };
  if (status === 429) {
    const s = Number(body?.retry_after);
    return {
      text: `${REBUILD_CARD.name}: just ran — ${s > 0 ? `retry in ${s}s` : 'retry shortly'}`,
      ok: false,
    };
  }
  if (status === 404) return { text: `${REBUILD_CARD.name}: unavailable on this server`, ok: false };
  return { text: `${REBUILD_CARD.name}: failed (HTTP ${status})`, ok: false };
}

// ---- scopes -----------------------------------------------------------------

/**
 * The usable scope keys of a config `scopes` object.
 *
 * nginx's namespaced route only matches [a-z0-9-]+ (see nginx.conf); a key
 * outside that charset would 404 silently instead of ever fetching, so it is
 * dropped here with a warning — same charset guard the site pages
 * (map.html/ai-map.html) use.
 *
 * @param {object|undefined} scopes - config `scopes` ({ "<scope>": "Display name" })
 * @param {(msg: string) => void} [warn]
 * @returns {string[]}
 */
export const scopeKeys = (scopes, warn = (m) => console.warn(m)) =>
  (scopes && typeof scopes === 'object') ? Object.keys(scopes).filter((k) => {
    if (/^[a-z0-9-]+$/.test(k)) return true;
    warn(`po11y: dropping invalid scope key "${k}" (must match [a-z0-9-]+)`);
    return false;
  }) : [];

/**
 * Which scope a session starts in: null with 0 or 1 keys (flat paths, no
 * switcher — exactly the pre-scopes behavior), else the remembered key when it
 * still exists, else "default" when present, else the first key.
 *
 * @param {string[]} keys - from scopeKeys()
 * @param {string|null} stored - localStorage "po11y-scope"
 * @returns {string|null}
 */
export const pickScope = (keys, stored) => {
  if (keys.length <= 1) return null;
  if (keys.includes(stored)) return stored;
  return keys.includes('default') ? 'default' : keys[0];
};

/**
 * The path a feed fetch uses: default (or no scopes) → the legacy flat path
 * (/status.json); else the namespaced path nginx maps (/status/<s>/…).
 */
export const feedUrl = (feed, activeScope) => (!activeScope || activeScope === 'default')
  ? `/${feed}.json`
  : `/status/${activeScope}/${feed}.json`;

/**
 * Pass the active non-default scope down an iframe tab URL (?scope=<s>) so the
 * /site/ pages (which fetch their own feed) can scope their fetch too.
 */
export const scopedSrc = (src, activeScope) => (!activeScope || activeScope === 'default') ? src
  : String(src ?? '') + (String(src).includes('?') ? '&' : '?') + 'scope=' + encodeURIComponent(activeScope);

/**
 * Tell an iframe WHICH tabs[] entry it is (?tab=<id>): two tabs may share one
 * src (two list.html DataTable views), and without the id the page can only
 * guess "first entry matching my filename" — the second tab then silently
 * rendered the first tab's data.
 */
export const withTab = (t) => !t.id ? t.src
  : String(t.src ?? '') + (String(t.src).includes('?') ? '&' : '?') + 'tab=' + encodeURIComponent(t.id);

// ---- hash routing -----------------------------------------------------------
// Which sidebar view the address bar names. Without it a reload always landed
// on Overview, so a tab could not be bookmarked, shared, or survive the reload
// a scope switch does. The hash is written in the terms a user would type
// ("#reports/daily", "#map"), not in dom ids: grouped entries carry a "g-"
// prefixed id purely to keep their generated element ids apart.
//
// The three functions below are the whole routing table — app.js only owns
// showing a view and selecting a pane.

/** A config label or id as a hash token: lowercase, a-z0-9 runs joined by "-". */
export const routeSlug = (s) => String(s ?? '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Split "#view/sub" into its two slugs. Leading "#" and "#/" are both accepted,
 * as is a percent-encoded token — a hash typed by hand or copied out of a chat
 * client can arrive either way. An undecodable escape is slugged raw rather
 * than thrown: a bad hash must fall back to Overview, never break boot.
 */
export function parseHash(hash) {
  let raw = String(hash ?? '').replace(/^#\/?/, '');
  try { raw = decodeURIComponent(raw); } catch { /* keep it raw */ }
  const [view, sub] = raw.split('/');
  return { view: routeSlug(view), sub: routeSlug(sub) };
}

// Every token that may name this entry: its id, its id without the group
// prefix, and its label.
const entryKeys = (e) => [routeSlug(e.id), routeSlug(String(e.id).replace(/^g-/, '')), routeSlug(e.label)];
const tabKeys = (t) => [routeSlug(t.id), routeSlug(t.label)];

/**
 * Resolve a hash against the sidebar entries, or null when it names nothing.
 *
 * A sub-tab may be addressed on its own ("#map"), because that is what a user
 * reads on the tab strip — the group it happens to live in is an implementation
 * detail of the sidebar. A "#view/sub" pair whose sub does not exist still
 * opens the view: the tab strip then falls back to its remembered pane rather
 * than the whole route being dropped.
 *
 * @param {string} hash - location.hash
 * @param {Array<{id: string, label: string, tabs: Array<{id: string, label: string}>}>} entries
 * @returns {{view: string, sub: string|null}|null}
 */
export function resolveRoute(hash, entries = []) {
  const { view, sub } = parseHash(hash);
  if (!view) return null;
  const entry = entries.find((e) => entryKeys(e).includes(view));
  if (entry) {
    const t = sub && (entry.tabs || []).find((x) => tabKeys(x).includes(sub));
    return { view: entry.id, sub: t ? t.id : null };
  }
  // Not a view — maybe a tab inside a grouped one, named without its group.
  for (const e of entries) {
    const t = (e.tabs || []).find((x) => tabKeys(x).includes(view));
    if (t) return { view: e.id, sub: t.id };
  }
  return null;
}

/**
 * The canonical hash for a view (and pane), the inverse of resolveRoute. The
 * sub is written only for an entry that actually shows a tab strip — a lone
 * tab's pane id would be noise in the address bar.
 */
export function routeHash(view, sub, entries = []) {
  const entry = entries.find((e) => e.id === view);
  if (!entry) return `#${routeSlug(view)}`;
  const base = routeSlug(String(entry.id).replace(/^g-/, ''));
  return (sub && (entry.tabs || []).length > 1) ? `#${base}/${routeSlug(sub)}` : `#${base}`;
}

// ---- executions -------------------------------------------------------------

/**
 * The status dot for one `byWorkflow` row: `fail` when the recent window holds
 * failures, `run` when the workflow has an execution still going, `ok`
 * otherwise.
 *
 * Failure outranks activity on purpose. A workflow that is erroring AND running
 * is a failing workflow that happens to be busy, and a green-or-blue dot over a
 * red state is exactly the false all-clear this codebase keeps re-learning.
 *
 * `running` is absent on a status.json written by a server older than this
 * field, so a missing count reads as none rather than as activity.
 */
export const execDot = (w) => (w?.errors ? 'fail' : (w?.running ? 'run' : 'ok'));

/**
 * The "N running" fragment for an execution row, or '' when nothing is in
 * flight — the row should not carry a "0 running" that means "idle".
 *
 * Freshness is bounded by the poll: the server learns this from n8n's public
 * API every POLL_INTERVAL (30 s by default), so this is "running as of the last
 * poll", not a live subscription.
 */
export const runningText = (n) => (n ? `${n} running` : '');

/**
 * Choose which execution rows the Overview shows, and how many matched.
 *
 * The filter runs BEFORE the display cap. status.json carries every workflow in
 * the recent window, so a name that matches only past the cap must still be
 * findable; capping first made workflow #11 unreachable, because the filter
 * then searched a list that workflow had already been trimmed out of.
 *
 * `total` is the size of the filtered set, not of the visible slice — the
 * "show all N" button reports it.
 *
 * @param {Array<{name?: string}>} [byWorkflow] - rows from status.json
 * @param {string} [filter] - substring match on the name; empty matches all
 * @param {{limit?: number, expanded?: boolean}} [opts]
 * @returns {{rows: object[], total: number, hasMore: boolean}}
 */
export function execRows(byWorkflow, filter = '', { limit = 10, expanded = false } = {}) {
  const f = String(filter ?? '').toLowerCase();
  const matched = (byWorkflow || []).filter(
    (w) => !f || String(w?.name ?? '').toLowerCase().includes(f));
  return {
    rows: expanded ? matched : matched.slice(0, limit),
    total: matched.length,
    hasMore: matched.length > limit,
  };
}

// ---- metrics ----------------------------------------------------------------

/**
 * A grafana time range as a human heading suffix. The d-solo embeds hide
 * Grafana's time picker, so the heading says what window the panels cover
 * ("now-7d" → "last 7 days"); an unparsed range shows raw.
 */
export const metricsRangeLabel = (range) => {
  const r = range || 'now-7d';
  const m = /^now-(\d+)([mhdwMy])$/.exec(r);
  if (!m) return r;
  const unit = { m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month', y: 'year' }[m[2]];
  return `last ${m[1]} ${unit}${m[1] === '1' ? '' : 's'}`;
};

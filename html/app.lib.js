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

/**
 * Substitute the `{host}` placeholder that lets one config work from every
 * device that can reach the box: config `baseUrl` wins when set, otherwise the
 * browser's own hostname.
 *
 * @param {string} u
 * @param {{ baseUrl?: string }} cfg
 * @param {string} hostname
 */
export const withHost = (u, cfg = {}, hostname = '') => String(u ?? '')
  .replaceAll('{host}', (typeof cfg.baseUrl === 'string' && cfg.baseUrl) ? cfg.baseUrl : hostname);

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
 *  - `cfg.n8nUrl` — where that form page lives. app.js used to hardcode
 *    `http://{host}:5678`, so with a remote n8n the Map tab's dialogs (which do
 *    read n8nUrl) and these cards disagreed about the same instance.
 *
 * @param {{forms?: Array<{name: string, sub?: string, path: string, fields?: number}>}} feed
 * @param {Array<object>} existing - cards already declared in config
 * @param {{ formProxy?: boolean, cfg?: object, hostname?: string }} opts
 */
export function formCards(feed, existing = [], { formProxy = true, cfg = {}, hostname = '' } = {}) {
  const have = new Set(existing.map(actionKey).filter(Boolean));
  const base = withHost(cfg.n8nUrl || 'http://{host}:5678', cfg, hostname).replace(/\/$/, '');
  const out = [];
  for (const f of feed?.forms || []) {
    if (have.has(f.path)) continue;
    out.push(formProxy && f.fields === 0
      ? { name: f.name, sub: f.sub, action: f.path }
      : { name: f.name, sub: f.sub, href: `${base}/form/${f.path}` });
  }
  return out;
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

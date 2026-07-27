// Po11y — a tiny no-build status dashboard. Everything instance-specific
// comes from /config.json (see config.example.json / README):
//   branding      title, lede, footer
//   cards         named groups of link cards on the Overview tab; a card with
//                 an "up" (+ optional "mem") prometheus query doubles as a
//                 live status card (up/DOWN · rss)
//   tabs          extra tabs, each an iframe onto an instance-served page
//   sections      which /status.json sections to render, and their headings
//   metrics       grafana embeds (or a deep-link card) + prometheus stat cards
// Live data: /status.json + /notifications.json, polled every refreshSec;
// grafana embeds refresh themselves natively (refresh URL param) and the
// prometheus stat cards re-poll, every metricsRefreshSec (default 60 s,
// 0 disables) — no reloads, so layout and scroll never move.
// "{host}" in any href/src is replaced with the browser's current hostname,
// so one config works from every device that can reach the box. Set
// config.json's "baseUrl" (a bare host, not a URL prefix) to substitute a
// different host instead — e.g. a remote n8n in Mode B.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// hrefs from external data: escaping keeps attributes intact but not URL
// schemes — allow only http(s)/relative so a hostile `javascript:` can't land.
const safeUrl = (u) => /^(https?:\/\/|\/)/i.test(String(u ?? '')) ? esc(u) : '#';
const withHost = (u) => String(u ?? '').replaceAll('{host}',
  (typeof cfg.baseUrl === 'string' && cfg.baseUrl) ? cfg.baseUrl : window.location.hostname);

// ---- scopes -----------------------------------------------------------------
// Multi-team views: config "scopes" ({ "<scope>": "Display name", … }) lets
// several publishers each feed their own namespace. On disk the default scope
// is the flat canonical files (/status.json …); a non-default scope <s> lives
// under /status/<s>/ (nginx maps both — see nginx.conf). 0 or 1 entry keeps
// exactly today's behavior (flat paths, no switcher). activeScope is null in
// that flat case; otherwise the localStorage-remembered scope key.
// nginx's namespaced route only matches [a-z0-9-]+ (see nginx.conf); a key
// outside that charset would 404 silently instead of ever fetching, so drop
// it here — same charset guard the site pages (map.html/ai-map.html) use.
const scopeKeys = () => (cfg.scopes && typeof cfg.scopes === 'object') ? Object.keys(cfg.scopes).filter((k) => {
  if (/^[a-z0-9-]+$/.test(k)) return true;
  console.warn(`po11y: dropping invalid scope key "${k}" (must match [a-z0-9-]+)`);
  return false;
}) : [];
let activeScope = null;
function initScope() {
  const keys = scopeKeys();
  if (keys.length <= 1) { activeScope = null; return; } // flat, no switcher
  let s = localStorage.getItem('po11y-scope');
  if (!keys.includes(s)) s = keys.includes('default') ? 'default' : keys[0];
  activeScope = s;
}
// One helper every feed fetch routes through: default (or no scopes) → the
// legacy flat path (/status.json); else the namespaced path.
const feedUrl = (feed) => (!activeScope || activeScope === 'default')
  ? `/${feed}.json`
  : `/status/${activeScope}/${feed}.json`;
// iframe tabs (map/ai-map) fetch their own feed; pass the active non-default
// scope down the tab URL so those pages can scope their fetch too.
const scopedSrc = (src) => (!activeScope || activeScope === 'default') ? src
  : String(src ?? '') + (String(src).includes('?') ? '&' : '?') + 'scope=' + encodeURIComponent(activeScope);
function setScope(next) {
  if (!scopeKeys().includes(next) || next === activeScope) return;
  localStorage.setItem('po11y-scope', next);
  // Re-fetch everything for the new scope: reload re-runs boot() (config stays
  // global; status/notifications/forms + the iframe tab srcs all rebuild
  // scoped), which is the clean way to re-derive the whole view — buildChrome
  // fixes the card-group skeleton at build time (forms discovery must precede
  // it), so an in-place partial re-render cannot consistently re-scope forms.
  location.reload();
}

let cfg = {
  title: 'Po11y',
  lede: '',
  footer: [],
  cards: {},
  tabs: [],
  sections: {
    containers: 'Running containers',
    notifications: 'Notifications',
    // executions is Mode B-only (n8n executions API) — add
    // "executions": "Workflow executions" to config.json sections to enable it.
  },
  metrics: null,
  // Base URL for n8n workflow deep links; consumed by the site pages
  // (map.html / ai-map.html), which fetch /config.json themselves.
  n8nUrl: 'http://{host}:5678',
  refreshSec: 30,
  metricsRefreshSec: 60,
  staleAfterMin: 5,
  statusHint: 'status.json missing — is the publisher running?',
};

// ---- helpers ----------------------------------------------------------------
const fetchJson = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!isFinite(m)) return '?';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
const toast = (msg, ok) => {
  let box = $('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + (ok ? 'ok' : 'fail');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 6000);
};

// ---- static chrome ------------------------------------------------------------
function buildChrome() {
  document.title = cfg.title;
  $('title').textContent = cfg.title;
  $('lede').textContent = cfg.lede;
  $('footer').innerHTML = (cfg.footer || []).map((f) =>
    f.href ? `<a href="${safeUrl(withHost(f.href))}">${esc(f.text)}</a>` : esc(f.text))
    .join(' · ');

  // Tabs: Overview + one iframe tab per config entry.
  const tabs = [{ id: 'overview', label: 'Overview' }, ...(cfg.tabs || [])];
  const nav = $('tabs');
  tabs.slice().reverse().forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (t.id === 'overview' ? ' active' : '');
    btn.dataset.view = t.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(t.id === 'overview'));
    btn.textContent = t.label;
    nav.prepend(btn);
  });
  (cfg.tabs || []).forEach((t) => {
    const sec = document.createElement('section');
    sec.id = `view-${t.id}`;
    sec.className = 'view';
    sec.hidden = true;
    // src set on first open — don't load every iframe up front
    sec.innerHTML = `<iframe class="tabframe" data-src="${safeUrl(withHost(scopedSrc(t.src)))}"
      title="${esc(t.label)}"></iframe>`;
    $('main').appendChild(sec);
  });
  // Scope switcher: only when there's a real choice (>1 scope). Sits with the
  // tabs, mirroring the header idiom; the pick sticks via localStorage and a
  // reload re-derives every scoped feed.
  if (scopeKeys().length > 1) {
    const sel = document.createElement('select');
    sel.className = 'scope-switch';
    sel.setAttribute('aria-label', 'scope');
    sel.innerHTML = scopeKeys().map((k) =>
      `<option value="${esc(k)}"${k === activeScope ? ' selected' : ''}>${esc(cfg.scopes[k])}</option>`).join('');
    sel.addEventListener('change', () => setScope(sel.value));
    nav.insertBefore(sel, nav.querySelector('.spacer'));
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      document.querySelectorAll('.view').forEach((v) => {
        v.hidden = v.id !== 'view-' + btn.dataset.view;
        if (!v.hidden) v.querySelectorAll('iframe[data-src]').forEach((f) => {
          f.src = f.dataset.src;
          f.removeAttribute('data-src');
        });
      });
    });
  });

  // Overview skeleton: metrics first, then card groups, then status sections.
  // Every heading collapses its section; the choice sticks via localStorage.
  const ov = $('view-overview');
  const block = (heading, id, cls = '') => {
    const closed = heading && localStorage.getItem(`po11y-sec-${id}`) === 'closed';
    return `${heading ? `<h2 class="sec-h${closed ? ' closed' : ''}" data-sec="${id}" title="${esc(heading)} — click to collapse or expand">${esc(heading)}</h2>` : ''}
      <div id="${id}"${cls ? ` class="${cls}"` : ''}${closed ? ' hidden' : ''}></div>`;
  };
  ov.innerHTML =
    (cfg.metrics ? block(cfg.metrics.heading || 'Metrics', 'metrics', 'cards') : '') +
    Object.keys(cfg.cards || {}).map((g, i) => block(g, `cards-${i}`, 'cards')).join('') +
    Object.entries(cfg.sections || {}).map(([k, h]) => block(h, `sec-${k}`)).join('');
  ov.querySelectorAll('.sec-h').forEach((h) => h.addEventListener('click', () => {
    const body = $(h.dataset.sec);
    body.hidden = !body.hidden;
    h.classList.toggle('closed', body.hidden);
    localStorage.setItem(`po11y-sec-${h.dataset.sec}`, body.hidden ? 'closed' : 'open');
  }));

  // Filter boxes in the containers/executions headings — narrow the cached
  // render immediately; the poll re-render keeps the filter applied.
  [['sec-containers', renderContainers], ['sec-executions', renderExecutions]].forEach(([id, rerender]) => {
    const h = ov.querySelector(`.sec-h[data-sec="${id}"]`);
    if (!h) return;
    const inp = document.createElement('input');
    inp.className = 'filter';
    inp.type = 'search';
    inp.placeholder = 'filter…';
    inp.addEventListener('click', (e) => e.stopPropagation()); // don't collapse
    inp.addEventListener('input', () => { filters[id] = inp.value.toLowerCase(); rerender(); });
    h.appendChild(inp);
  });
  // Status tabs on the notifications heading: all / ok / fail.
  const nh = ov.querySelector('.sec-h[data-sec="sec-notifications"]');
  if (nh) {
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.innerHTML = ['all', 'ok', 'fail'].map((f, i) =>
      `<button class="segbtn${i === 0 ? ' active' : ''}" data-f="${f}">${f}</button>`).join('');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.segbtn');
      if (!b) return;
      e.stopPropagation();
      notifFilter = b.dataset.f;
      seg.querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('active', x === b));
      renderNotifications();
    });
    nh.appendChild(seg);
  }

  // Field-less form triggers ({action}) run in place via the same-origin
  // /form/ nginx proxy; everything else is a plain link card. Every card
  // gets a hover tooltip: config "tip" wins, else "name — sub".
  const tip = (l) => esc(l.tip || (l.sub ? `${l.name} — ${l.sub}` : l.name));
  const card = (l, id) => l.action
    ? `<button class="card action" data-form="${esc(l.action)}" data-name="${esc(l.name)}" title="${tip(l)}">
        <h3>${esc(l.name)}</h3><p>${esc(l.sub || '')}</p></button>`
    : `<a class="card"${id ? ` id="${id}"` : ''} href="${safeUrl(withHost(l.href))}" title="${tip(l)}">
        <h3>${esc(l.name)}</h3><p>${esc(l.sub || '')}${l.up ? ' — checking…' : ''}</p></a>`;
  Object.values(cfg.cards || {}).forEach((links, i) => {
    $(`cards-${i}`).innerHTML = links.map((l, j) => card(l, l.up ? `card-${i}-${j}` : '')).join('');
  });
  ov.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-form]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const name = btn.dataset.name;
    try {
      const r = await fetch(`/form/${encodeURIComponent(btn.dataset.form)}`,
        { method: 'POST', body: new FormData() });
      toast(r.ok ? `${name}: triggered` : `${name}: failed (HTTP ${r.status})`, r.ok);
    } catch {
      toast(`${name}: failed — n8n unreachable`, false);
    }
    btn.disabled = false;
  });
  $('sec-containers')?.classList.add('cards');

  renderMetrics();
  refreshStatCards();
}

// ---- metrics: grafana embeds or deep-link card, plus prometheus stat cards -----
function renderMetrics() {
  const m = cfg.metrics;
  if (!m) return;
  const g = m.grafana || {};
  const base = g.base || '/grafana';
  let html = '';
  if (g.embed && g.dashboard) {
    const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // Native panel auto-refresh: grafana re-queries inside the iframe, no
    // reload/flash. 0 disables.
    const mSec = cfg.metricsRefreshSec ?? 60;
    const refresh = mSec > 0 ? `&refresh=${mSec}s` : '';
    // Panel sizing: "wide" spans the full row; "span" (1-4) takes that many
    // grid tracks on wide screens (default 2 = half the row). Height follows
    // the span (N/1 aspect → uniform rows) unless "h" pins it in px — use
    // that when a panel's chart needs more room than the ratio gives.
    html += (g.panels || []).map((p) => {
      const span = [1, 2, 3, 4].includes(p.span) ? p.span : 0;
      const h = Number.isFinite(p.h) ? Math.min(800, Math.max(120, p.h)) : 0;
      const style = [span ? `--gspan:${span};--gaspect:${span}/1` : '', h ? `height:${h}px` : '']
        .filter(Boolean).join(';');
      return `<iframe class="gpanel${p.wide ? ' gwide' : ''}" loading="lazy"${
        style ? ` style="${style}"` : ''} title="${esc(p.title || `Grafana panel ${p.id}`)}" src="${safeUrl(
        `${base}/d-solo/${g.dashboard}?orgId=1&from=${g.range || 'now-7d'}&to=now&theme=${theme}${refresh}&panelId=${p.id}`)}"></iframe>`;
    }).join('');
  } else if (g.dashboard) {
    // Embeds off — the deep-link card is the only Grafana entry point. With
    // embeds on it would duplicate the Monitoring dashboard links, so skip it.
    html += `<a class="card" href="${safeUrl(`${base}/d/${g.dashboard}`)}" title="Open the full Grafana dashboard"><h3>Grafana</h3>
      <p>Embeds are off. Open dashboard</p></a>`;
  }
  html += (m.stats || []).map((s, i) => s.href
    ? `<a class="card" id="stat-${i}" href="${safeUrl(withHost(s.href))}" title="${esc(s.label)} — live status from Prometheus"><h3>${esc(s.label)}</h3><p>checking…</p></a>`
    : `<div class="card" id="stat-${i}" title="${esc(s.label)} — live status from Prometheus"><h3>${esc(s.label)}</h3><p>checking…</p></div>`).join('');
  $('metrics').innerHTML = html;
}

// Re-poll every live stat: card-group entries carrying an "up" query (merged
// link + status cards, e.g. the n8n editor card) and metrics.stats cards.
function refreshStatCards() {
  Object.values(cfg.cards || {}).forEach((links, i) => {
    links.forEach((l, j) => { if (l.up) fillStat($(`card-${i}-${j}`), l); });
  });
  ((cfg.metrics && cfg.metrics.stats) || []).forEach((s, i) => fillStat($(`stat-${i}`), s));
}

// Fill the <p> of an existing card with live up/DOWN (+ rss) from the two
// read-only Prometheus query endpoints. Used by metrics.stats cards and by
// card-group entries that carry an "up" query (merged link + status cards).
async function fillStat(el, stat) {
  if (!el) return;
  const promBase = (cfg.metrics && cfg.metrics.promBase) || '/prom';
  const p = el.querySelector('p');
  try {
    const q = (expr) => fetchJson(`${promBase}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const [up, mem] = await Promise.all([q(stat.up), stat.mem ? q(stat.mem) : null]);
    const isUp = up.data.result[0]?.value[1] === '1';
    const mb = mem?.data.result[0] ? Math.round(mem.data.result[0].value[1] / 1048576) : null;
    p.innerHTML = `<b>${isUp ? 'up' : 'DOWN'}</b>${mb ? ` · ${mb} MB rss` : ''}${stat.sub ? ` · ${esc(stat.sub)}` : ''}`;
  } catch {
    p.innerHTML = `${stat.sub ? `${esc(stat.sub)} · ` : ''}prometheus unreachable`;
  }
}

// ---- live status ----------------------------------------------------------------
// Renders come from the cached last-good payload: a fetch failure after a
// successful poll keeps the data on screen and raises the "unreachable"
// badge instead of wiping the sections ("stale" stays age-based).
let lastStatus = null;
const filters = { 'sec-containers': '', 'sec-executions': '' };

async function refreshStatus() {
  try {
    lastStatus = await fetchJson(feedUrl('status'));
    $('offline').hidden = true;
  } catch {
    if (!lastStatus) {
      $('stale').hidden = false;
      $('updated').textContent = cfg.statusHint;
      const c = $('sec-containers');
      if (c) c.innerHTML = '<p class="empty">no data yet</p>';
      const ex = $('sec-executions');
      if (ex) ex.innerHTML = '<p class="empty">no data yet</p>';
      return;
    }
    $('offline').hidden = false;
  }
  const ageMin = (Date.now() - new Date(lastStatus.generated_at).getTime()) / 60000;
  $('stale').hidden = ageMin <= (cfg.staleAfterMin ?? 5);
  $('updated').textContent = `updated ${ago(lastStatus.generated_at)}`;
  renderContainers();
  renderExecutions();
}

function renderContainers() {
  const el = $('sec-containers');
  if (!el || !lastStatus) return;
  const f = filters['sec-containers'];
  const rows = (lastStatus.containers || []).filter((c) =>
    !f || `${c.name} ${c.status} ${c.image}`.toLowerCase().includes(f));
  el.innerHTML = rows.length
    ? rows.map((c) =>
        `<div class="card" title="${esc(c.name)} — ${esc(c.status)} — ${esc(c.image)}"><h3>${esc(c.name)}</h3><p><b>${esc(c.status)}</b><br>${esc(c.image)}</p></div>`).join('')
    : `<p class="empty">${f ? 'no match' : 'none running'}</p>`;
}

// ---- executions (Mode B only) -----------------------------------------------------
// { executions: { recent, errors, byWorkflow: [{ name, id, count, errors, lastAt }] } }
// — see collector/collect.mjs. Filter box narrows byWorkflow by name, same
// mechanism as renderContainers.
function renderExecutions() {
  const el = $('sec-executions');
  if (!el || !lastStatus) return;
  const ex = lastStatus.executions || {};
  const f = filters['sec-executions'];
  const rows = (ex.byWorkflow || []).filter((w) =>
    !f || String(w.name ?? '').toLowerCase().includes(f));
  if (!rows.length) { el.innerHTML = `<p class="empty">${f ? 'no match' : 'no executions yet'}</p>`; return; }
  const summary = `<p class="updated">${ex.recent ?? 0} recent · ${ex.errors ?? 0} errors</p>`;
  el.innerHTML = summary + rows.map((w) => {
    const dot = w.errors ? 'fail' : 'ok';
    const errPart = w.errors ? `<b class="err">${w.errors} errors</b>` : `${w.errors ?? 0} errors`;
    return `<div class="notif"><span class="dot ${dot}"></span>
      <div><b>${esc(w.name)}</b> <span class="updated">${w.lastAt ? esc(ago(w.lastAt)) : 'never'}</span>
      <p>${w.count ?? 0} runs · ${errPart}</p></div></div>`;
  }).join('');
}

// ---- notification feed ------------------------------------------------------------
// Shows the newest NOTIF_LIMIT entries; "show all" expands to the full feed.
// The choice survives the poll re-render via notifExpanded; notifFilter is
// the heading's all/ok/fail tab.
const NOTIF_LIMIT = 5;
let notifExpanded = false;
let notifFilter = 'all';
let lastFeed = null;

async function refreshNotifications() {
  try {
    lastFeed = await fetchJson(feedUrl('notifications'));
  } catch { /* keep the last-good feed (see refreshStatus) */ }
  renderNotifications();
}

function renderNotifications() {
  const el = $('sec-notifications');
  if (!el) return;
  if (!lastFeed || !lastFeed.length) { el.innerHTML = '<p class="empty">none yet</p>'; return; }
  const feed = lastFeed.filter((n) =>
    notifFilter === 'all' ? true
      : notifFilter === 'ok' ? n.status === 'success' : n.status === 'failure');
  if (!feed.length) { el.innerHTML = '<p class="empty">none with this status</p>'; return; }
  const shown = notifExpanded ? feed : feed.slice(0, NOTIF_LIMIT);
  let html = shown.map((n) => {
    const dot = n.status === 'success' ? 'ok' : n.status === 'failure' ? 'fail' : 'info';
    const title = n.link
      ? `<a href="${safeUrl(n.link)}">${esc(n.title)}</a>`
      : esc(n.title);
    return `<div class="notif"><span class="dot ${dot}"></span>
      <div><b>${title}</b> <span class="updated">${esc(ago(n.ts))}</span>
      <p>${esc(n.message)}</p></div></div>`;
  }).join('');
  if (feed.length > NOTIF_LIMIT) {
    html += `<button class="more" id="notif-toggle">${notifExpanded
      ? 'show less' : `show all ${feed.length}`}</button>`;
  }
  el.innerHTML = html;
  $('notif-toggle')?.addEventListener('click', () => {
    notifExpanded = !notifExpanded;
    renderNotifications();
  });
}

// ---- boot -------------------------------------------------------------------------
(async function boot() {
  try {
    cfg = { ...cfg, ...(await fetchJson('/config.json')) };
  } catch {
    // Falling back to defaults silently renders a plausible-looking but empty
    // dashboard — the worst outcome for a tool whose job is telling you what
    // is broken. Both compose files bind-mount ./config.json, so when it was
    // never created docker makes a *directory* of that name and nginx serves
    // nothing; that is the standard Mode B first-run mistake (Mode A's
    // bootstrap.sh copies the example for you, Mode B has no bootstrap). Say
    // so in the lede, which is empty by default and always visible.
    console.warn('po11y: /config.json unreadable — using built-in defaults');
    cfg.lede = 'config.json not readable — run: cp config.example.json config.json';
  }
  initScope();
  // Auto-discovered form triggers (forms.json, published by the maps
  // workflow) become Actions cards; config-declared cards win on collisions.
  try {
    const feed = await fetchJson(feedUrl('forms'));
    const actions = (cfg.cards = cfg.cards || {}).Actions = cfg.cards.Actions || [];
    const have = new Set(actions.map((c) => (c.href || '').split('/form/')[1]).filter(Boolean));
    for (const f of feed.forms || []) {
      if (have.has(f.path)) continue;
      // Field-less forms fire in place (fetch POST via the /form/ proxy);
      // forms with inputs still open n8n's own form page.
      actions.push(f.fields === 0
        ? { name: f.name, sub: f.sub, action: f.path }
        : { name: f.name, sub: f.sub, href: `http://{host}:5678/form/${f.path}` });
    }
    if (!actions.length) delete cfg.cards.Actions;
  } catch { /* feed optional */ }
  buildChrome();
  refreshStatus();
  refreshNotifications();
  setInterval(() => { refreshStatus(); refreshNotifications(); }, (cfg.refreshSec ?? 30) * 1000);
  const mSec = cfg.metricsRefreshSec ?? 60;
  if (mSec > 0) setInterval(refreshStatCards, mSec * 1000);
})();

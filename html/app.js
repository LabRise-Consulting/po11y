// Po11y — a tiny no-build status dashboard. Everything instance-specific
// comes from /config.json (see config.example.json / README):
//   branding      title, lede, footer
//   cards         named groups of link cards on the Overview view; a card with
//                 an "up" (+ optional "mem") prometheus query doubles as a
//                 live status card (up/DOWN · rss)
//   tabs          extra sidebar views, each an iframe onto an instance-served
//                 page; entries sharing a "group" fold into one sidebar entry
//                 whose view keeps a tab strip (the key is still "tabs" so
//                 existing configs work unchanged). The open view is named in
//                 the address bar (#projects, #reports/daily, #map), so a
//                 reload, a bookmark and a shared link all land where they left
//                 off instead of on Overview.
//   sections      which /status.json sections to render, and their headings;
//                 "notifications" renders as its own sidebar view (with an
//                 unseen badge), the rest as Overview sections
//   metrics       grafana embeds (or a deep-link card) + prometheus stat cards
// Live data: /status.json + /notifications.json, polled every refreshSec;
// grafana embeds refresh themselves natively (refresh URL param) and the
// prometheus stat cards re-poll, every metricsRefreshSec (default 60 s,
// 0 disables) — no reloads, so layout and scroll never move.
// "{host}" in any href/src is replaced with the browser's current hostname,
// so one config works from every device that can reach the box. Set
// config.json's "baseUrl" (a bare host, not a URL prefix) to substitute a
// different host instead — e.g. a remote n8n on the read-only stack.

// Pure helpers (escaping, url policy, scope routing, range labels, …) live in
// app.lib.js so they can be unit-tested (node --test "html/**/*.test.mjs");
// everything DOM-shaped stays here.
import { esc, safeUrl, ago, refreshMs, formCards, withHost as withHostOf,
  scopeKeys as scopeKeysOf, pickScope, feedUrl as feedUrlOf,
  scopedSrc as scopedSrcOf, withTab, metricsRangeLabel, execDot, runningText,
  execRows,
  resolveRoute, routeHash }
  from './app.lib.js';

const $ = (id) => document.getElementById(id);
const withHost = (u) => withHostOf(u, cfg, window.location.hostname);

// ---- scopes -----------------------------------------------------------------
// Multi-team views: config "scopes" ({ "<scope>": "Display name", … }) lets
// several publishers each feed their own namespace. On disk the default scope
// is the flat canonical files (/status.json …); a non-default scope <s> lives
// under /status/<s>/ (nginx maps both — see nginx.conf). 0 or 1 entry keeps
// exactly today's behavior (flat paths, no switcher). activeScope is null in
// that flat case; otherwise the localStorage-remembered scope key. The
// key-validation/pick/path logic itself lives in app.lib.js.
const scopeKeys = () => scopeKeysOf(cfg.scopes);
let activeScope = null;
function initScope() {
  activeScope = pickScope(scopeKeys(), localStorage.getItem('po11y-scope'));
}
const feedUrl = (feed) => feedUrlOf(feed, activeScope);
const scopedSrc = (src) => scopedSrcOf(src, activeScope);
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
    // executions always comes from status.json's own `executions` object —
    // add "executions": "Workflow executions" to config.json sections to
    // enable it. (containers above never populates any more — see
    // docs/server.md's Accepted regressions.)
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

// ---- theme ------------------------------------------------------------------
// Manual override for the OS color scheme: html[data-theme] + localStorage
// "po11y-theme" ("light" | "dark"; key absent = follow the OS). The /site/
// pages read the same key and hear the storage event when it changes here, so
// iframe views stay in step live. Grafana embeds carry the resolved theme in
// their URL, so a switch re-renders them — and re-fills the stat cards that
// re-render wipes.
let theme = localStorage.getItem('po11y-theme');
if (theme !== 'light' && theme !== 'dark') theme = 'auto';
const darkNow = () => theme === 'dark' ||
  (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(next) {
  theme = next;
  if (next === 'auto') localStorage.removeItem('po11y-theme');
  else localStorage.setItem('po11y-theme', next);
  const root = document.documentElement;
  if (next === 'auto') { root.removeAttribute('data-theme'); root.style.colorScheme = ''; }
  else { root.dataset.theme = next; root.style.colorScheme = next; }
  const btn = $('theme');
  btn.textContent = { auto: '◐', light: '☀', dark: '☾' }[next];
  btn.title = `Theme: ${next} (click to change)`;
  renderMetrics();
  refreshStatCards();
}

// ---- static chrome ------------------------------------------------------------
// Sidebar entries as the router sees them ({id, label, tabs}); filled by
// buildChrome, read by resolveRoute/routeHash.
let navEntries = [];

function buildChrome() {
  document.title = cfg.title;
  $('title').textContent = cfg.title;
  $('lede').textContent = cfg.lede;
  $('footer').innerHTML = (cfg.footer || []).map((f) =>
    f.href ? `<a href="${safeUrl(withHost(f.href))}">${esc(f.text)}</a>` : esc(f.text))
    .join(' · ');

  // Sidebar entries: Overview + one per config tab; entries sharing a "group"
  // fold into a single entry whose view keeps a tab strip. Grouping is
  // render-only — /site/ pages still find their own entry in the flat tabs[].
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entries = [{ id: 'overview', label: 'Overview', tabs: [] }];
  (cfg.tabs || []).forEach((t) => {
    const g = t.group && entries.find((e) => e.groupLabel === t.group);
    if (g) g.tabs.push(t);
    else entries.push(t.group
      ? { id: `g-${slug(t.group)}`, label: t.group, groupLabel: t.group, tabs: [t] }
      : { id: t.id, label: t.label, tabs: [t] });
  });
  // Overview sub-menu: one jump link per section of the Overview skeleton
  // (metrics heading, card groups, status sections) — quick navigation on a
  // page that can grow long. Notifications is not an Overview section any
  // more: it gets its own view right after Overview (built below), with an
  // unseen badge on the nav entry.
  const notifLabel = (cfg.sections || {}).notifications;
  // Routing table, in sidebar order: Overview, Notifications, then the tab
  // entries. Built from the same list the sidebar renders, so a config change
  // moves the routes with it.
  navEntries = [entries[0], ...(notifLabel ? [{ id: 'notifications', label: notifLabel, tabs: [] }] : []),
    ...entries.slice(1)];
  const ovSections = [
    ...(cfg.metrics ? [{ id: 'metrics', label: cfg.metrics.heading || 'Metrics' }] : []),
    ...Object.keys(cfg.cards || {}).map((g, i) => ({ id: `cards-${i}`, label: g })),
    ...Object.entries(cfg.sections || {}).filter(([k]) => k !== 'notifications')
      .map(([k, h]) => ({ id: `sec-${k}`, label: h })),
  ];
  const navBtn = (e) => `<button class="nav-item${e.id === 'overview' ? ' active' : ''}" data-view="${esc(e.id)}" data-label="${esc(e.label)}"${
    e.id === 'overview' ? ' aria-current="page"' : ''}>${esc(e.label)}</button>`;
  $('nav').innerHTML =
    navBtn(entries[0]) +
    (ovSections.length ? `<div class="subnav">${ovSections.map((s) =>
      `<button class="nav-sub" data-target="${esc(s.id)}">${esc(s.label)}</button>`).join('')}</div>` : '') +
    (notifLabel ? navBtn({ id: 'notifications', label: notifLabel }) : '') +
    entries.slice(1).map(navBtn).join('');
  entries.slice(1).forEach((e) => {
    const sec = document.createElement('section');
    sec.id = `view-${e.id}`;
    sec.className = 'view';
    sec.hidden = true;
    const remembered = localStorage.getItem(`po11y-subtab-${e.id}`);
    const open = e.tabs.some((t) => t.id === remembered) ? remembered : e.tabs[0].id;
    const strip = e.tabs.length > 1
      ? `<nav class="tabs subtabs" role="tablist">${e.tabs.map((t) =>
          `<button class="tab${t.id === open ? ' active' : ''}" role="tab" aria-selected="${
            t.id === open}" data-sub="${esc(t.id)}">${esc(t.label)}</button>`).join('')}</nav>`
      : '';
    // src set on first show — don't load every iframe up front
    sec.innerHTML = strip + e.tabs.map((t) =>
      `<iframe class="tabframe" data-sub-pane="${esc(t.id)}" data-src="${safeUrl(withHost(scopedSrc(withTab(t))))}"
        title="${esc(t.label)}"${t.id === open ? '' : ' hidden'}></iframe>`).join('');
    $('main').appendChild(sec);
  });
  // Notifications view: the feed list plus its all/ok/fail filter. Opening it
  // moves the unseen watermark (markNotifSeen), which clears the nav badge.
  if (notifLabel) {
    const sec = document.createElement('section');
    sec.id = 'view-notifications';
    sec.className = 'view';
    sec.hidden = true;
    sec.innerHTML = `<div class="view-tools"><span class="seg" id="notif-seg">${
      ['all', 'ok', 'fail'].map((f, i) =>
        `<button class="segbtn${i ? '' : ' active'}" data-f="${f}">${f}</button>`).join('')}</span></div>
      <div id="sec-notifications"></div>`;
    $('main').appendChild(sec);
    $('notif-seg').addEventListener('click', (e) => {
      const b = e.target.closest('.segbtn');
      if (!b) return;
      notifFilter = b.dataset.f;
      $('notif-seg').querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('active', x === b));
      renderNotifications();
    });
  }
  const loadFrame = (f) => { f.src = f.dataset.src; f.removeAttribute('data-src'); };
  const closeSide = () => { document.body.classList.remove('side-open'); $('backdrop').hidden = true; };
  // Which pane a grouped view is showing (null for a view with no tab strip) —
  // the sub the address bar names when the view itself is what changed.
  const activeSub = (sec) => sec?.querySelector('.subtabs .tab.active')?.dataset.sub || null;
  // Swap panes inside a grouped view, lazy-load the one revealed, remember it.
  // Panes and buttons are matched by dataset rather than by a built selector:
  // tab ids come from config, so a selector would need escaping to be safe.
  function selectSub(sec, subId) {
    const panes = [...sec.querySelectorAll('iframe[data-sub-pane]')];
    if (!panes.some((f) => f.dataset.subPane === subId)) return activeSub(sec);
    sec.querySelectorAll('.subtabs .tab').forEach((b) => {
      const on = b.dataset.sub === subId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    panes.forEach((f) => {
      f.hidden = f.dataset.subPane !== subId;
      if (!f.hidden && f.dataset.src) loadFrame(f);
    });
    localStorage.setItem(`po11y-subtab-${sec.id.slice(5)}`, subId);
    return subId;
  }
  // Name the open view in the address bar. A click pushes, so Back walks the
  // views; applying a route that came *from* the address bar replaces, so
  // normalising "#Map" to "#maps/map" does not need a second Back press.
  function syncHash(view, sub, mode) {
    const h = routeHash(view, sub, navEntries);
    if (location.hash === h) return;
    if (mode === 'replace') history.replaceState(null, '', h);
    else location.hash = h;
  }
  function showView(id, sub = null, mode = 'push') {
    document.querySelectorAll('.nav-item').forEach((b) => {
      const on = b.dataset.view === id;
      b.classList.toggle('active', on);
      if (on) { b.setAttribute('aria-current', 'page'); $('view-title').textContent = b.dataset.label; }
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${id}`; });
    const sec = document.getElementById(`view-${id}`);
    const openSub = sub ? selectSub(sec, sub) : activeSub(sec);
    sec.querySelectorAll('iframe[data-src]:not([hidden])').forEach(loadFrame);
    if (id === 'notifications') markNotifSeen();
    closeSide();
    syncHash(id, openSub, mode);
  }
  // #<view> or #<view>/<sub>, resolved against the sidebar: a hash the config
  // does not describe is ignored (Overview stays open) rather than rewritten,
  // so a link that predates a config change fails visibly but harmlessly.
  function applyRoute() {
    const r = resolveRoute(location.hash, navEntries);
    if (r) showView(r.view, r.sub, 'replace');
  }
  addEventListener('hashchange', applyRoute);
  $('nav').addEventListener('click', (e) => {
    const sub = e.target.closest('.nav-sub');
    if (sub) {
      showView('overview');
      const body = $(sub.dataset.target);
      // jump open a collapsed section before scrolling to its heading
      if (body?.hidden) ov.querySelector(`.sec-h[data-sec="${sub.dataset.target}"]`)?.click();
      (body?.previousElementSibling || body)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const btn = e.target.closest('.nav-item');
    if (btn) showView(btn.dataset.view);
  });
  // Sub-tab strip inside a grouped view.
  $('main').addEventListener('click', (e) => {
    const t = e.target.closest('.subtabs .tab');
    if (!t) return;
    const sec = t.closest('.view');
    syncHash(sec.id.slice(5), selectSub(sec, t.dataset.sub), 'push');
  });
  // Small screens: the sidebar slides in over a backdrop.
  $('menu').addEventListener('click', () => {
    const opened = document.body.classList.toggle('side-open');
    $('backdrop').hidden = !opened;
  });
  $('backdrop').addEventListener('click', closeSide);
  $('theme').addEventListener('click', () =>
    applyTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto'));
  // OS scheme flips while on "auto": tokens follow via the media query, but
  // grafana embeds bake the theme into their URL — re-render them.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'auto') { renderMetrics(); refreshStatCards(); }
  });
  // Scope switcher: only when there's a real choice (>1 scope). Sits in the
  // sidebar above the nav; the pick sticks via localStorage and a reload
  // re-derives every scoped feed.
  if (scopeKeys().length > 1) {
    const sel = document.createElement('select');
    sel.className = 'scope-switch';
    sel.setAttribute('aria-label', 'scope');
    sel.innerHTML = scopeKeys().map((k) =>
      `<option value="${esc(k)}"${k === activeScope ? ' selected' : ''}>${esc(cfg.scopes[k])}</option>`).join('');
    sel.addEventListener('change', () => setScope(sel.value));
    $('side').insertBefore(sel, $('nav'));
  }

  // Overview skeleton: metrics first, then card groups, then status sections.
  // Every heading collapses its section; the choice sticks via localStorage.
  const ov = $('view-overview');
  const block = (heading, id, cls = '') => {
    const closed = heading && localStorage.getItem(`po11y-sec-${id}`) === 'closed';
    return `${heading ? `<h2 class="sec-h${closed ? ' closed' : ''}" data-sec="${id}" title="${esc(heading)} — click to collapse or expand">${esc(heading)}</h2>` : ''}
      <div id="${id}"${cls ? ` class="${cls}"` : ''}${closed ? ' hidden' : ''}></div>`;
  };
  // Only embedded panels pin a window (the deep-link card, embeds off, has its
  // own picker) — so only then does the heading carry the range label.
  const metricsHeading = () => {
    const base = cfg.metrics.heading || 'Metrics';
    const g = cfg.metrics.grafana;
    if (!(g && g.embed && g.dashboard)) return base;
    return `${base} — ${metricsRangeLabel(g.range)}`;
  };
  ov.innerHTML =
    (cfg.metrics ? block(metricsHeading(), 'metrics', 'cards') : '') +
    Object.keys(cfg.cards || {}).map((g, i) => block(g, `cards-${i}`, 'cards')).join('') +
    ovSections.filter((s) => s.id.startsWith('sec-')).map((s) => block(s.label, s.id)).join('');
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

  applyTheme(theme); // sets html[data-theme], the button glyph, and renders metrics
  // Last, so the whole sidebar exists to resolve against: open the view the
  // address bar names. No hash (the plain "/" visit) leaves Overview open and
  // the URL untouched — the address bar only starts naming views once one is
  // picked. A scope switch reloads, so the hash carries the view across it too.
  applyRoute();
}

// ---- metrics: grafana embeds or deep-link card, plus prometheus stat cards -----
function renderMetrics() {
  const m = cfg.metrics;
  if (!m) return;
  const g = m.grafana || {};
  const base = g.base || '/grafana';
  let html = '';
  if (g.embed && g.dashboard) {
    const gTheme = darkNow() ? 'dark' : 'light';
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
        `${base}/d-solo/${g.dashboard}?orgId=1&from=${g.range || 'now-7d'}&to=now&theme=${gTheme}${refresh}&panelId=${p.id}`)}"></iframe>`;
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

// ---- executions -------------------------------------------------------------
// { executions: { recent, errors, byWorkflow: [{ name, id, count, errors, lastAt, running }] } }
// — see server/n8n.mjs. byWorkflow carries every workflow in the recent
// window, busiest first. execRows (app.lib.js) decides which of them show:
// it filters first and caps second, so the filter box reaches a workflow that
// never makes the visible few. Same show-all toggle the notification feed uses.
const EXEC_LIMIT = 10;
let execExpanded = false;

function renderExecutions() {
  const el = $('sec-executions');
  if (!el || !lastStatus) return;
  const ex = lastStatus.executions || {};
  const f = filters['sec-executions'];
  const { rows, total, hasMore } = execRows(ex.byWorkflow, f,
    { limit: EXEC_LIMIT, expanded: execExpanded });
  if (!total) { el.innerHTML = `<p class="empty">${f ? 'no match' : 'no executions yet'}</p>`; return; }
  // status.json is written by a separate process (the po11y server), so these
  // counters are external data like every other field here — esc() them even
  // though the server only ever writes numbers.
  const summary = `<p class="updated">${esc(ex.recent ?? 0)} recent · ${esc(ex.errors ?? 0)} errors</p>`;
  let html = summary + rows.map((w) => {
    const dot = execDot(w);
    const errPart = w.errors
      ? `<b class="err">${esc(w.errors)} errors</b>`
      : `${esc(w.errors ?? 0)} errors`;
    // Only rendered while something is in flight, so the row does not carry a
    // permanent "0 running". See runningText on how fresh this actually is.
    const run = runningText(w.running);
    const runPart = run ? ` · <b class="run">${esc(run)}</b>` : '';
    return `<div class="notif"><span class="dot ${dot}"></span>
      <div><b>${esc(w.name)}</b> <span class="updated">${w.lastAt ? esc(ago(w.lastAt)) : 'never'}</span>
      <p>${esc(w.count ?? 0)} runs · ${errPart}${runPart}</p></div></div>`;
  }).join('');
  if (hasMore) {
    html += `<button class="more" id="exec-toggle">${execExpanded
      ? 'show less' : `show all ${total}`}</button>`;
  }
  el.innerHTML = html;
  $('exec-toggle')?.addEventListener('click', () => {
    execExpanded = !execExpanded;
    renderExecutions();
  });
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
  // Sitting on the view when the poll lands counts as seeing the new entries.
  const v = document.getElementById('view-notifications');
  if (v && !v.hidden) markNotifSeen();
  else updateNotifBadge();
}

// Unseen indicator on the Notifications nav entry. The watermark
// (localStorage "po11y-notif-seen", epoch ms of the newest entry at last
// visit) is per browser, like every other remembered preference here. The
// badge counts newer entries and turns red when one of them is a failure;
// a first run with no watermark baselines silently instead of flagging the
// whole history as new.
const notifTs = (n) => new Date(n.ts).getTime() || 0;
function updateNotifBadge() {
  const btn = document.querySelector('.nav-item[data-view="notifications"]');
  if (!btn || !lastFeed) return;
  const seen = Number(localStorage.getItem('po11y-notif-seen') || 0);
  if (!seen) { markNotifSeen(); return; }
  const unseen = lastFeed.filter((n) => notifTs(n) > seen);
  let b = btn.querySelector('.nav-badge');
  if (!unseen.length) { b?.remove(); return; }
  if (!b) {
    b = document.createElement('span');
    b.className = 'nav-badge';
    btn.appendChild(b);
  }
  b.textContent = unseen.length > 99 ? '99+' : String(unseen.length);
  b.classList.toggle('fail', unseen.some((n) => n.status === 'failure'));
}
function markNotifSeen() {
  if (lastFeed?.length) {
    localStorage.setItem('po11y-notif-seen', String(Math.max(...lastFeed.map(notifTs))));
  }
  document.querySelector('.nav-item[data-view="notifications"] .nav-badge')?.remove();
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
    // nothing; that is the standard read-only-stack first-run mistake (the
    // bundled stack's bootstrap.sh copies the example for you, the read-only
    // stack has no bootstrap). Say so in the lede, which is empty by default
    // and always visible.
    console.warn('po11y: /config.json unreadable — using built-in defaults');
    cfg.lede = 'config.json not readable — run: cp config.example.json config.json';
    // Without a config the poll interval is the built-in 30 s, so a 5-minute
    // staleness threshold would light the "stale" badge permanently and blame
    // the publisher for the missing config. Say the one true thing (the lede)
    // rather than two things, one of them wrong.
    cfg.staleAfterMin = Infinity;
  }
  initScope();
  // Auto-discovered form triggers (forms.json, published by the po11y server)
  // become Actions cards; config-declared cards win on
  // collisions. Card shape depends on the /form/ proxy and cfg.n8nUrl — see
  // formCards in app.lib.js.
  try {
    const feed = await fetchJson(feedUrl('forms'));
    const actions = (cfg.cards = cfg.cards || {}).Actions = cfg.cards.Actions || [];
    actions.push(...formCards(feed, actions, {
      formProxy: cfg.formProxy !== false,
      cfg,
      hostname: window.location.hostname,
    }));
    if (!actions.length) delete cfg.cards.Actions;
  } catch { /* feed optional */ }
  buildChrome();
  refreshStatus();
  refreshNotifications();
  setInterval(() => { refreshStatus(); refreshNotifications(); }, refreshMs(cfg.refreshSec, 30));
  // 0 disables the metrics poll outright (documented); anything else is clamped
  // like the feed poll rather than trusted as a delay.
  const mSec = cfg.metricsRefreshSec ?? 60;
  if (mSec > 0) setInterval(refreshStatCards, refreshMs(mSec, 60));
})();

// Po11y — a tiny no-build status dashboard. Everything instance-specific
// comes from /config.json (see config.example.json / README):
//   branding      title, eyebrow, lede, footer
//   cards         named groups of link cards on the Overview tab
//   tabs          extra tabs, each an iframe onto an instance-served page
//   sections      which /status.json sections to render, and their headings
//   metrics       grafana embeds (or a deep-link card) + prometheus stat cards
// Live data: /status.json + /notifications.json, polled every refreshSec.
// "{host}" in any href/src is replaced with the browser's current hostname,
// so one config works from every device that can reach the box.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// hrefs from external data: escaping keeps attributes intact but not URL
// schemes — allow only http(s)/relative so a hostile `javascript:` can't land.
const safeUrl = (u) => /^(https?:\/\/|\/)/i.test(String(u ?? '')) ? esc(u) : '#';
const withHost = (u) => String(u ?? '').replaceAll('{host}', window.location.hostname);

let cfg = {
  title: 'Po11y',
  eyebrow: 'po11y · status',
  lede: '',
  footer: [],
  cards: {},
  tabs: [],
  sections: {
    containers: 'Running containers',
    mrs: 'Open merge requests',
    notifications: 'Notifications',
  },
  metrics: null,
  refreshSec: 30,
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
  $('eyebrow').textContent = cfg.eyebrow;
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
    sec.innerHTML = `<iframe class="tabframe" data-src="${safeUrl(withHost(t.src))}"
      title="${esc(t.label)}"></iframe>`;
    $('main').appendChild(sec);
  });
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
    return `${heading ? `<h2 class="sec-h${closed ? ' closed' : ''}" data-sec="${id}">${esc(heading)}</h2>` : ''}
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

  // Filter box in the containers/MRs headings — narrows the cached render
  // immediately; the poll re-render keeps the filter applied.
  [['sec-containers', renderContainers], ['sec-mrs', renderMrs]].forEach(([id, rerender]) => {
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
  // /form/ nginx proxy; everything else is a plain link card.
  const card = (l) => l.action
    ? `<button class="card action" data-form="${esc(l.action)}" data-name="${esc(l.name)}">
        <h3>${esc(l.name)}</h3><p>${esc(l.sub || '')}</p></button>`
    : `<a class="card" href="${safeUrl(withHost(l.href))}"><h3>${esc(l.name)}</h3><p>${esc(l.sub || '')}</p></a>`;
  Object.values(cfg.cards || {}).forEach((links, i) => {
    $(`cards-${i}`).innerHTML = links.map(card).join('');
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
    html += (g.panels || []).map((p) =>
      `<iframe class="gpanel${p.wide ? ' gwide' : ''}" loading="lazy" src="${safeUrl(
        `${base}/d-solo/${g.dashboard}?orgId=1&from=${g.range || 'now-7d'}&to=now&theme=${theme}&panelId=${p.id}`)}"></iframe>`).join('');
  }
  if (g.dashboard) {
    html += `<a class="card" href="${safeUrl(`${base}/d/${g.dashboard}`)}"><h3>Grafana</h3>
      <p>${g.embed ? 'Open the full dashboard' : 'Embeds are off. Open dashboard'}</p></a>`;
  }
  html += (m.stats || []).map((_, i) =>
    `<div class="card" id="stat-${i}"><h3></h3><p>checking…</p></div>`).join('');
  $('metrics').innerHTML = html;
  (m.stats || []).forEach(renderStat);
}

async function renderStat(stat, i) {
  const el = $(`stat-${i}`);
  if (!el) return;
  const promBase = (cfg.metrics.promBase || '/prom');
  try {
    const q = (expr) => fetchJson(`${promBase}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const [up, mem] = await Promise.all([q(stat.up), stat.mem ? q(stat.mem) : null]);
    const isUp = up.data.result[0]?.value[1] === '1';
    const mb = mem?.data.result[0] ? Math.round(mem.data.result[0].value[1] / 1048576) : null;
    el.innerHTML = `<h3>${esc(stat.label)}</h3><p><b>${isUp ? 'up' : 'DOWN'}</b>${mb ? ` · ${mb} MB rss` : ''}</p>`;
  } catch {
    el.innerHTML = `<h3>${esc(stat.label)}</h3><p>prometheus unreachable</p>`;
  }
}

// ---- live status ----------------------------------------------------------------
// Renders come from the cached last-good payload: a fetch failure after a
// successful poll keeps the data on screen and raises the "unreachable"
// badge instead of wiping the sections ("stale" stays age-based).
let lastStatus = null;
const filters = { 'sec-containers': '', 'sec-mrs': '' };

async function refreshStatus() {
  try {
    lastStatus = await fetchJson('/status.json');
    $('offline').hidden = true;
  } catch {
    if (!lastStatus) {
      $('stale').hidden = false;
      $('updated').textContent = cfg.statusHint;
      const c = $('sec-containers');
      if (c) c.innerHTML = '<p class="empty">no data yet</p>';
      const m = $('sec-mrs');
      if (m) m.innerHTML = '<p class="empty">no data yet</p>';
      return;
    }
    $('offline').hidden = false;
  }
  const ageMin = (Date.now() - new Date(lastStatus.generated_at).getTime()) / 60000;
  $('stale').hidden = ageMin <= (cfg.staleAfterMin ?? 5);
  $('updated').textContent = `updated ${ago(lastStatus.generated_at)}`;
  renderContainers();
  renderMrs();
}

function renderContainers() {
  const el = $('sec-containers');
  if (!el || !lastStatus) return;
  const f = filters['sec-containers'];
  const rows = (lastStatus.containers || []).filter((c) =>
    !f || `${c.name} ${c.status} ${c.image}`.toLowerCase().includes(f));
  el.innerHTML = rows.length
    ? rows.map((c) =>
        `<div class="card"><h3>${esc(c.name)}</h3><p><b>${esc(c.status)}</b><br>${esc(c.image)}</p></div>`).join('')
    : `<p class="empty">${f ? 'no match' : 'none running'}</p>`;
}

function renderMrs() {
  const el = $('sec-mrs');
  if (!el || !lastStatus) return;
  const f = filters['sec-mrs'];
  const rows = (lastStatus.mrs || []).filter((m) =>
    !f || `${m.project} !${m.iid} ${m.title} ${(m.labels || []).join(' ')}`.toLowerCase().includes(f));
  el.innerHTML = rows.length
    ? `<table><tr><th>project</th><th>MR</th><th>title</th><th>labels</th><th>updated</th></tr>` +
      rows.map((m) =>
        `<tr><td>${esc(m.project)}</td>
         <td><a href="${safeUrl(m.web_url)}">!${esc(m.iid)}</a>${m.draft ? ' <span class="label">draft</span>' : ''}</td>
         <td class="wide">${esc(m.title)}</td>
         <td>${(m.labels || []).map((l) => `<span class="label">${esc(l)}</span>`).join('')}</td>
         <td>${esc(ago(m.updated_at))}</td></tr>`).join('') + '</table>'
    : `<p class="empty">${f ? 'no match' : 'no open MRs'}</p>`;
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
    lastFeed = await fetchJson('/notifications.json');
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
  try { cfg = { ...cfg, ...(await fetchJson('/config.json')) }; } catch { /* defaults */ }
  // Auto-discovered form triggers (/forms.json, published by the maps
  // workflow) become Actions cards; config-declared cards win on collisions.
  try {
    const feed = await fetchJson('/forms.json');
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
})();

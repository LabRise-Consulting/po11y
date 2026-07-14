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

  // Overview skeleton: card groups, then opted-in status sections, then metrics.
  // Every heading collapses its section; the choice sticks via localStorage.
  const ov = $('view-overview');
  const block = (heading, id, cls = '') => {
    const closed = heading && localStorage.getItem(`po11y-sec-${id}`) === 'closed';
    return `${heading ? `<h2 class="sec-h${closed ? ' closed' : ''}" data-sec="${id}">${esc(heading)}</h2>` : ''}
      <div id="${id}"${cls ? ` class="${cls}"` : ''}${closed ? ' hidden' : ''}></div>`;
  };
  ov.innerHTML =
    Object.keys(cfg.cards || {}).map((g, i) => block(g, `cards-${i}`, 'cards')).join('') +
    Object.entries(cfg.sections || {}).map(([k, h]) => block(h, `sec-${k}`)).join('') +
    (cfg.metrics ? block(cfg.metrics.heading || 'Metrics', 'metrics', 'cards') : '');
  ov.querySelectorAll('.sec-h').forEach((h) => h.addEventListener('click', () => {
    const body = $(h.dataset.sec);
    body.hidden = !body.hidden;
    h.classList.toggle('closed', body.hidden);
    localStorage.setItem(`po11y-sec-${h.dataset.sec}`, body.hidden ? 'closed' : 'open');
  }));

  const card = (l) =>
    `<a class="card" href="${safeUrl(withHost(l.href))}"><h3>${esc(l.name)}</h3><p>${esc(l.sub || '')}</p></a>`;
  Object.values(cfg.cards || {}).forEach((links, i) => {
    $(`cards-${i}`).innerHTML = links.map(card).join('');
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
async function renderStatus() {
  const containers = $('sec-containers');
  const mrs = $('sec-mrs');
  let st;
  try {
    st = await fetchJson('/status.json');
  } catch {
    $('stale').hidden = false;
    $('updated').textContent = cfg.statusHint;
    if (containers) containers.innerHTML = '<p class="empty">no data yet</p>';
    if (mrs) mrs.innerHTML = '<p class="empty">no data yet</p>';
    return;
  }
  const ageMin = (Date.now() - new Date(st.generated_at).getTime()) / 60000;
  $('stale').hidden = ageMin <= (cfg.staleAfterMin ?? 5);
  $('updated').textContent = `updated ${ago(st.generated_at)}`;

  if (containers) containers.innerHTML = (st.containers || []).length
    ? st.containers.map((c) =>
        `<div class="card"><h3>${esc(c.name)}</h3><p><b>${esc(c.status)}</b><br>${esc(c.image)}</p></div>`).join('')
    : '<p class="empty">none running</p>';

  if (mrs) mrs.innerHTML = (st.mrs || []).length
    ? `<table><tr><th>project</th><th>MR</th><th>title</th><th>labels</th><th>updated</th></tr>` +
      st.mrs.map((m) =>
        `<tr><td>${esc(m.project)}</td>
         <td><a href="${safeUrl(m.web_url)}">!${esc(m.iid)}</a>${m.draft ? ' <span class="label">draft</span>' : ''}</td>
         <td class="wide">${esc(m.title)}</td>
         <td>${(m.labels || []).map((l) => `<span class="label">${esc(l)}</span>`).join('')}</td>
         <td>${esc(ago(m.updated_at))}</td></tr>`).join('') + '</table>'
    : '<p class="empty">no open MRs</p>';
}

// ---- notification feed ------------------------------------------------------------
// Shows the newest NOTIF_LIMIT entries; "show all" expands to the full feed.
// The choice survives the poll re-render via notifExpanded.
const NOTIF_LIMIT = 5;
let notifExpanded = false;
async function renderNotifications() {
  const el = $('sec-notifications');
  if (!el) return;
  let feed;
  try {
    feed = await fetchJson('/notifications.json');
  } catch {
    el.innerHTML = '<p class="empty">none yet</p>';
    return;
  }
  if (!feed.length) { el.innerHTML = '<p class="empty">none yet</p>'; return; }
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
      actions.push({ name: f.name, sub: f.sub, href: `http://{host}:5678/form/${f.path}` });
    }
    if (!actions.length) delete cfg.cards.Actions;
  } catch { /* feed optional */ }
  buildChrome();
  renderStatus();
  renderNotifications();
  setInterval(() => { renderStatus(); renderNotifications(); }, (cfg.refreshSec ?? 30) * 1000);
})();

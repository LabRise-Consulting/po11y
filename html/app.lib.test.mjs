import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, safeUrl, withHost, ago, refreshMs, actionKey, formCards,
  scopeKeys, pickScope, feedUrl, scopedSrc, withTab, metricsRangeLabel,
  execDot, runningText,
  routeSlug, parseHash, resolveRoute, routeHash } from './app.lib.js';

// ---- esc --------------------------------------------------------------------
test('esc neutralises every character that can break out of markup', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
});

test('esc renders nullish as empty, and numbers as their digits', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(3), '3');
});

// ---- safeUrl ----------------------------------------------------------------
test('safeUrl passes http, https and root-relative urls', () => {
  assert.equal(safeUrl('https://example.test/x'), 'https://example.test/x');
  assert.equal(safeUrl('http://example.test'), 'http://example.test');
  assert.equal(safeUrl('/site/map.html'), '/site/map.html');
});

test('safeUrl refuses javascript: and other schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>'), '#');
  assert.equal(safeUrl(''), '#');
});

test('safeUrl refuses protocol-relative urls', () => {
  // "//evil.test" is same-scheme, other-origin: it passed the "starts with /"
  // branch, so feed data could retarget a link off the box entirely.
  assert.equal(safeUrl('//evil.test/x'), '#');
  assert.equal(safeUrl('//evil.test'), '#');
  assert.equal(safeUrl('/ok'), '/ok', 'a single leading slash is still fine');
});

test('safeUrl escapes the url it accepts', () => {
  assert.equal(safeUrl('/x?a=1&b=2'), '/x?a=1&amp;b=2');
});

// ---- withHost ---------------------------------------------------------------
test('withHost substitutes the browser hostname by default', () => {
  assert.equal(withHost('http://{host}:5678/x', {}, 'box.local'), 'http://box.local:5678/x');
});

test('withHost prefers a configured baseUrl over the browser hostname', () => {
  assert.equal(withHost('http://{host}:5678', { baseUrl: 'n8n.remote' }, 'box.local'),
    'http://n8n.remote:5678');
});

test('withHost replaces every occurrence, and tolerates nullish input', () => {
  assert.equal(withHost('{host}/{host}', {}, 'h'), 'h/h');
  assert.equal(withHost(undefined, {}, 'h'), '');
});

// ---- ago --------------------------------------------------------------------
test('ago reports minutes, hours and days, and "just now" under a minute', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(ago(at(10_000), now), 'just now');
  assert.equal(ago(at(5 * 60_000), now), '5 min ago');
  assert.equal(ago(at(3 * 3600_000), now), '3 h ago');
  assert.equal(ago(at(5 * 24 * 3600_000), now), '5 d ago');
});

test('ago returns ? for an unparseable timestamp instead of NaN', () => {
  assert.equal(ago('not a date', Date.now()), '?');
  assert.equal(ago(undefined, Date.now()), '?');
});

// ---- refreshMs --------------------------------------------------------------
test('refreshMs converts seconds to milliseconds', () => {
  assert.equal(refreshMs(30), 30_000);
});

test('refreshMs falls back to the default when the value is absent', () => {
  assert.equal(refreshMs(undefined, 30), 30_000);
});

test('refreshMs refuses a zero or negative interval', () => {
  // setInterval(fn, 0) re-enters as fast as the event loop allows: a config
  // typo turned the dashboard into a request flood against its own feeds.
  assert.ok(refreshMs(0) >= 1000, 'clamped to a floor, not 0');
  assert.ok(refreshMs(-5) >= 1000);
});

test('refreshMs refuses a non-numeric interval', () => {
  assert.equal(refreshMs('soon', 30), 30_000);
});

// ---- actionKey --------------------------------------------------------------
test('actionKey identifies a card by its form path, whichever shape carries it', () => {
  // Config cards spell the path in an href; discovered field-less forms spell
  // it in `action`. Keying on href alone meant an `action` card never entered
  // the dedupe set, so configuring one produced two buttons for one form.
  assert.equal(actionKey({ href: 'http://{host}:5678/form/deploy' }), 'deploy');
  assert.equal(actionKey({ action: 'deploy' }), 'deploy');
  assert.equal(actionKey({ name: 'no path here' }), null);
});

// ---- formCards --------------------------------------------------------------
const FEED = {
  forms: [
    { name: 'Rebuild map', sub: 'no inputs', path: 'rebuild', fields: 0 },
    { name: 'Deploy', sub: 'takes inputs', path: 'deploy', fields: 2 },
  ],
};

test('formCards makes a field-less form an in-place action when the proxy is on', () => {
  const cards = formCards(FEED, [], { formProxy: true, cfg: {}, hostname: 'box' });
  const rebuild = cards.find((c) => c.name === 'Rebuild map');
  assert.equal(rebuild.action, 'rebuild');
  assert.equal(rebuild.href, undefined);
});

test('formCards links a form with inputs to n8n rather than posting it', () => {
  const cards = formCards(FEED, [], { formProxy: true, cfg: {}, hostname: 'box' });
  const deploy = cards.find((c) => c.name === 'Deploy');
  assert.equal(deploy.action, undefined);
  assert.match(deploy.href, /\/form\/deploy$/);
});

test('formCards links field-less forms too when the /form/ proxy is off', () => {
  // The read-only stack defaults ENABLE_FORM_PROXY=false, so nginx includes an empty
  // form-proxy.conf and every in-place POST answers 404. A link to n8n's own
  // form page is the honest fallback.
  const cards = formCards(FEED, [], { formProxy: false, cfg: {}, hostname: 'box' });
  const rebuild = cards.find((c) => c.name === 'Rebuild map');
  assert.equal(rebuild.action, undefined, 'no in-place POST without a proxy to take it');
  assert.match(rebuild.href, /\/form\/rebuild$/);
});

test('formCards honours cfg.n8nUrl for the form links', () => {
  // The read-only stack points at an n8n somewhere else entirely, so a link
  // derived from the browser host goes to the wrong place. The Map tab's
  // dialogs read n8nUrl; these cards must agree with them.
  const cfg = { n8nUrl: 'https://n8n.example.test' };
  const cards = formCards(FEED, [], { formProxy: false, cfg, hostname: 'box' });
  assert.equal(cards.find((c) => c.name === 'Deploy').href,
    'https://n8n.example.test/form/deploy');
  assert.equal(cards.find((c) => c.name === 'Rebuild map').href,
    'https://n8n.example.test/form/rebuild');
});

test('formCards resolves {host} in n8nUrl against baseUrl, then the browser host', () => {
  assert.match(formCards(FEED, [], { formProxy: true, cfg: { n8nUrl: 'http://{host}:5678' }, hostname: 'box' })
    .find((c) => c.name === 'Deploy').href, /^http:\/\/box:5678\//);
  assert.match(formCards(FEED, [], {
    formProxy: true, cfg: { n8nUrl: 'http://{host}:5678', baseUrl: 'remote' }, hostname: 'box',
  }).find((c) => c.name === 'Deploy').href, /^http:\/\/remote:5678\//);
});

test('formCards skips a form a configured card already covers, in either shape', () => {
  const existing = [
    { name: 'Configured deploy', href: 'http://{host}:5678/form/deploy' },
    { name: 'Configured rebuild', action: 'rebuild' },
  ];
  assert.deepEqual(formCards(FEED, existing, { formProxy: true, cfg: {}, hostname: 'box' }), []);
});

test('formCards tolerates a feed with no forms array', () => {
  assert.deepEqual(formCards({}, [], { formProxy: true, cfg: {}, hostname: 'box' }), []);
});

// ---- scopeKeys --------------------------------------------------------------
test('scopeKeys keeps nginx-routable keys and drops the rest with a warning', () => {
  const warned = [];
  const keys = scopeKeys({ default: 'Default', 'team-a': 'Team A', 'Bad Key': 'X', 'über': 'Y' },
    (m) => warned.push(m));
  assert.deepEqual(keys, ['default', 'team-a']);
  assert.equal(warned.length, 2);
  assert.match(warned[0], /Bad Key/);
});

test('scopeKeys returns [] for a missing or non-object scopes config', () => {
  assert.deepEqual(scopeKeys(undefined), []);
  assert.deepEqual(scopeKeys(null), []);
  assert.deepEqual(scopeKeys('default'), []);
});

// ---- pickScope --------------------------------------------------------------
test('pickScope is null with 0 or 1 keys — flat paths, no switcher', () => {
  assert.equal(pickScope([], null), null);
  assert.equal(pickScope(['only'], 'only'), null);
});

test('pickScope keeps a remembered key that still exists', () => {
  assert.equal(pickScope(['default', 'team-a'], 'team-a'), 'team-a');
});

test('pickScope falls back to "default", then the first key', () => {
  assert.equal(pickScope(['team-a', 'default'], 'gone'), 'default');
  assert.equal(pickScope(['team-a', 'team-b'], 'gone'), 'team-a');
  assert.equal(pickScope(['team-a', 'team-b'], null), 'team-a');
});

// ---- feedUrl ----------------------------------------------------------------
test('feedUrl uses the legacy flat path for no scope and for "default"', () => {
  assert.equal(feedUrl('status', null), '/status.json');
  assert.equal(feedUrl('notifications', 'default'), '/notifications.json');
});

test('feedUrl namespaces every non-default scope under /status/<s>/', () => {
  assert.equal(feedUrl('status', 'team-a'), '/status/team-a/status.json');
  assert.equal(feedUrl('forms', 'team-a'), '/status/team-a/forms.json');
});

// ---- scopedSrc --------------------------------------------------------------
test('scopedSrc passes the src through untouched for no scope and "default"', () => {
  assert.equal(scopedSrc('/site/map.html', null), '/site/map.html');
  assert.equal(scopedSrc('/site/map.html', 'default'), '/site/map.html');
});

test('scopedSrc appends the scope with ? or &, url-encoded', () => {
  assert.equal(scopedSrc('/site/map.html', 'team-a'), '/site/map.html?scope=team-a');
  assert.equal(scopedSrc('/site/list.html?x=1', 'team-a'), '/site/list.html?x=1&scope=team-a');
});

// ---- withTab ----------------------------------------------------------------
test('withTab passes an id-less tab through and appends ?tab= otherwise', () => {
  assert.equal(withTab({ src: '/site/list.html' }), '/site/list.html');
  assert.equal(withTab({ id: 'runs', src: '/site/list.html' }), '/site/list.html?tab=runs');
  assert.equal(withTab({ id: 'runs', src: '/site/list.html?x=1' }), '/site/list.html?x=1&tab=runs');
});

// ---- metricsRangeLabel ------------------------------------------------------
test('metricsRangeLabel translates the grafana ranges it can read', () => {
  assert.equal(metricsRangeLabel('now-7d'), 'last 7 days');
  assert.equal(metricsRangeLabel('now-1h'), 'last 1 hour');
  assert.equal(metricsRangeLabel('now-2w'), 'last 2 weeks');
  assert.equal(metricsRangeLabel('now-1M'), 'last 1 month');
});

test('metricsRangeLabel shows an unparsed range raw, and defaults to now-7d', () => {
  assert.equal(metricsRangeLabel('now-90m/m'), 'now-90m/m');
  assert.equal(metricsRangeLabel(undefined), 'last 7 days');
});

// ---- hash routing -----------------------------------------------------------
// A representative sidebar, in the shape buildChrome derives from
// config tabs[]: Overview, the Notifications view, two grouped entries and two
// ungrouped ones.
const ENTRIES = [
  { id: 'overview', label: 'Overview', tabs: [] },
  { id: 'notifications', label: 'Notifications', tabs: [] },
  { id: 'g-maps', label: 'Maps', groupLabel: 'Maps',
    tabs: [{ id: 'map', label: 'Map' }, { id: 'arch', label: 'Architecture' }] },
  { id: 'projects', label: 'Projects', tabs: [{ id: 'projects', label: 'Projects' }] },
  { id: 'prs', label: 'PRs', tabs: [{ id: 'prs', label: 'PRs' }] },
  { id: 'g-reports', label: 'Reports', groupLabel: 'Reports',
    tabs: [{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
      { id: 'monthly', label: 'Monthly' }] },
];

test('routeSlug lowercases and collapses everything that is not a-z0-9', () => {
  assert.equal(routeSlug('Reports'), 'reports');
  assert.equal(routeSlug('PRs'), 'prs');
  assert.equal(routeSlug('  Weekly report! '), 'weekly-report');
  assert.equal(routeSlug(undefined), '');
});

test('parseHash splits view/sub and tolerates the leading # and #/', () => {
  assert.deepEqual(parseHash('#reports/daily'), { view: 'reports', sub: 'daily' });
  assert.deepEqual(parseHash('#/reports/daily'), { view: 'reports', sub: 'daily' });
  assert.deepEqual(parseHash('#Map'), { view: 'map', sub: '' });
  assert.deepEqual(parseHash(''), { view: '', sub: '' });
  assert.deepEqual(parseHash('#'), { view: '', sub: '' });
});

test('parseHash decodes percent-escapes without throwing on a broken one', () => {
  assert.deepEqual(parseHash('#weekly%20report'), { view: 'weekly-report', sub: '' });
  assert.deepEqual(parseHash('#%E0%A4%A'), { view: 'e0-a4-a', sub: '' });
});

test('resolveRoute matches a view by id, by label, and case-insensitively', () => {
  assert.deepEqual(resolveRoute('#projects', ENTRIES), { view: 'projects', sub: null });
  assert.deepEqual(resolveRoute('#PRs', ENTRIES), { view: 'prs', sub: null });
  assert.deepEqual(resolveRoute('#overview', ENTRIES), { view: 'overview', sub: null });
  assert.deepEqual(resolveRoute('#notifications', ENTRIES), { view: 'notifications', sub: null });
});

test('resolveRoute matches a group by its label, not by the g- prefixed dom id', () => {
  assert.deepEqual(resolveRoute('#reports', ENTRIES), { view: 'g-reports', sub: null });
  assert.deepEqual(resolveRoute('#g-reports', ENTRIES), { view: 'g-reports', sub: null });
  assert.deepEqual(resolveRoute('#Maps', ENTRIES), { view: 'g-maps', sub: null });
});

test('resolveRoute opens a grouped tab named on its own, without its group', () => {
  // "#Map" is the tab inside the Maps group — the shape a user types.
  assert.deepEqual(resolveRoute('#Map', ENTRIES), { view: 'g-maps', sub: 'map' });
  assert.deepEqual(resolveRoute('#Architecture', ENTRIES), { view: 'g-maps', sub: 'arch' });
  assert.deepEqual(resolveRoute('#monthly', ENTRIES), { view: 'g-reports', sub: 'monthly' });
});

test('resolveRoute reads view/sub pairs and ignores a sub the view does not have', () => {
  assert.deepEqual(resolveRoute('#reports/weekly', ENTRIES), { view: 'g-reports', sub: 'weekly' });
  assert.deepEqual(resolveRoute('#maps/Architecture', ENTRIES), { view: 'g-maps', sub: 'arch' });
  assert.deepEqual(resolveRoute('#reports/nope', ENTRIES), { view: 'g-reports', sub: null });
});

test('resolveRoute returns null for an empty or unknown hash', () => {
  assert.equal(resolveRoute('', ENTRIES), null);
  assert.equal(resolveRoute('#', ENTRIES), null);
  assert.equal(resolveRoute('#nosuchview', ENTRIES), null);
  assert.equal(resolveRoute('#projects', []), null);
});

test('routeHash writes the friendly form, with a sub only where there is a strip', () => {
  assert.equal(routeHash('overview', null, ENTRIES), '#overview');
  assert.equal(routeHash('projects', 'projects', ENTRIES), '#projects');
  assert.equal(routeHash('g-reports', 'daily', ENTRIES), '#reports/daily');
  assert.equal(routeHash('g-maps', 'arch', ENTRIES), '#maps/arch');
  assert.equal(routeHash('g-maps', null, ENTRIES), '#maps');
});

test('routeHash round-trips through resolveRoute for every entry and sub-tab', () => {
  for (const e of ENTRIES) {
    for (const sub of (e.tabs.length ? e.tabs.map((t) => t.id) : [null])) {
      const back = resolveRoute(routeHash(e.id, sub, ENTRIES), ENTRIES);
      assert.equal(back.view, e.id);
      if (e.tabs.length > 1) assert.equal(back.sub, sub);
    }
  }
});

// ---- execDot / runningText --------------------------------------------------
test('execDot marks a workflow with a live execution as running', () => {
  assert.equal(execDot({ count: 4, errors: 0, running: 1 }), 'run');
  assert.equal(execDot({ count: 4, errors: 0, running: 0 }), 'ok');
});

// A red dot must never be masked by activity: a workflow that is erroring AND
// running is a failing workflow that happens to be busy, not a healthy one.
test('execDot keeps failure ahead of activity', () => {
  assert.equal(execDot({ count: 4, errors: 2, running: 1 }), 'fail');
});

// Older servers publish no `running` key at all. Absent must read as "nothing
// to say", never as a running workflow.
test('execDot treats a missing running count as none', () => {
  assert.equal(execDot({ count: 4, errors: 0 }), 'ok');
  assert.equal(execDot(null), 'ok');
});

test('runningText names the count, and says nothing when none are running', () => {
  assert.equal(runningText(1), '1 running');
  assert.equal(runningText(3), '3 running');
  assert.equal(runningText(0), '');
  assert.equal(runningText(undefined), '');
});

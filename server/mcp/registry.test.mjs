import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry, FEEDS } from './registry.mjs';
import { FEEDS as SERVER_FEEDS } from '../http.mjs';

/** Write `content` to a fresh config.json and return its path. */
function configFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-registry-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content);
  return path;
}

const off = { available: () => false };
const sources = {
  feeds: { ...off, readSafe: () => null },
  store: { available: () => false },
  prometheus: off, n8n: off, grafana: off, datatables: off,
};

test('registry exposes ten tools, operations first', () => {
  const { tools } = buildRegistry(sources, '/nope/config.json');
  assert.equal(tools.length, 10);
  assert.equal(tools[0].name, 'po11y_incidents');
  assert.equal(tools[7].name, 'po11y_datasets');
});

test('every tool declares a name, description and input schema', () => {
  for (const t of buildRegistry(sources, '/nope/config.json').tools) {
    assert.ok(t.name.startsWith('po11y_'), `${t.name} is misnamed`);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.handler, 'function');
  }
});

test('a missing config.json degrades to zero datasets, not a crash', async () => {
  const { tools } = buildRegistry(sources, '/nope/config.json');
  const out = await tools.find((t) => t.name === 'po11y_datasets').handler({});
  assert.equal(out.datasets.length, 0);
});

test('a config.json that parses to null degrades to zero datasets, not a crash', async () => {
  // JSON.parse('null') succeeds and returns null: it sails straight past a
  // try/catch built to trap only a throw, so the `{ tabs: [] }` fallback
  // never engages unless buildRegistry checks the parsed *value* too.
  const { tools } = buildRegistry(sources, configFile('null'));
  const out = await tools.find((t) => t.name === 'po11y_datasets').handler({});
  assert.equal(out.datasets.length, 0);
});

test('a config.json that parses to a JSON array degrades to zero datasets, not a crash', async () => {
  const { tools } = buildRegistry(sources, configFile('[1,2,3]'));
  const out = await tools.find((t) => t.name === 'po11y_datasets').handler({});
  assert.equal(out.datasets.length, 0);
});

test('a config.json that parses to a JSON string degrades to zero datasets, not a crash', async () => {
  const { tools } = buildRegistry(sources, configFile('"hello"'));
  const out = await tools.find((t) => t.name === 'po11y_datasets').handler({});
  assert.equal(out.datasets.length, 0);
});

test('the five feeds are exposed as resources', () => {
  const { resources } = buildRegistry(sources, '/nope/config.json');
  assert.deepEqual(resources.map((r) => r.name).sort(),
    ['ai-map.json', 'forms.json', 'map.json', 'notifications.json', 'status.json']);
});

// ---- the feed-name list has one home ----------------------------------------
// FEEDS is the JS home; deploy/nginx/feeds-server.conf (the server proxy's
// own flat + scope regexes) and deploy/k8s's embedded nginx copy repeat the
// names in config languages that cannot import it. These pins make "add a
// feed, miss a layer" a test failure instead of a silent 404.
//
// nginx.conf itself no longer carries the feed blocks — the dashboard
// entrypoint renders feeds-server.conf into /etc/nginx/feeds.conf, which
// nginx.conf only `include`s (see docs/server.md and nginx.conf's own
// feed-routing comment) — so this test reads the file that now actually
// holds the aliases, not nginx.conf.
const FEED_NAMES = FEEDS.map(([name]) => name).sort();
const nginxLocations = (text) => [...text.matchAll(/location = \/([a-z-]+\.json)[\s\S]{0,80}?alias \/po11y-status\//g)]
  .map((m) => m[1]).sort();
const scopeRegexes = (text) => [...text.matchAll(/\(\?<feed>\(([a-z0-9|-]+)\)\\\.json\)/g)]
  .map((m) => m[1].split('|').map((b) => `${b}.json`).sort());

test('deploy/nginx/feeds-server.conf proxies exactly the registry feeds (flat + scope)', () => {
  const feedsServer = readFileSync(new URL('../../deploy/nginx/feeds-server.conf', import.meta.url), 'utf8');
  const flat = /\(\?<feed>([a-z0-9|-]+)\)\\\.json\$/.exec(feedsServer);
  assert.ok(flat, 'feeds-server.conf is missing its flat feed regex');
  assert.deepEqual(flat[1].split('|').sort(), FEED_NAMES.map((n) => n.replace(/\.json$/, '')).sort());

  const regexes = scopeRegexes(feedsServer);
  assert.equal(regexes.length, 1, 'feeds-server.conf no longer has its one scope regex');
  assert.deepEqual(regexes[0], FEED_NAMES);
});

// The k8s path never got a server Deployment and the volume-aliased feeds it
// used to serve were removed along with Mode A's publisher workflows (see
// deploy/k8s/README.md's "Status feeds do not work" section) — so, unlike
// deploy/nginx/feeds-server.conf above, there is nothing here to pin the
// feed list against. This guards the deletion staying deleted: a `location
// = /status.json { alias ... }` block reappearing here would silently claim
// a feed that nothing publishes.
test('the k8s nginx copy does not alias any feed to a status volume', () => {
  const k8s = readFileSync(new URL('../../deploy/k8s/02-configmaps.yaml', import.meta.url), 'utf8');
  assert.deepEqual(nginxLocations(k8s), []);
});

// server/http.mjs imports FEED_NAMES from here directly and re-exports it as
// FEEDS — the MCP modules live under server/, so this is a real import
// rather than the pinned copy it used to be. The assertion stays as the
// guard that the re-export never drifts into a hand-written list again.
test('server/http.mjs FEEDS matches the registry feed list exactly', () => {
  assert.deepEqual([...SERVER_FEEDS].sort(), FEED_NAMES);
});

// The serving-layer wiring that turns the feed-name list into an actual
// route: nginx.conf includes the file the dashboard entrypoint renders one of
// deploy/nginx/feeds-*.conf into, and both docker-compose files' entrypoints
// must render that exact path — a typo in either would 404 every feed with no
// test catching it before deploy.
test('nginx.conf includes the rendered feed-routing file', () => {
  const nginxConf = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
  assert.ok(nginxConf.includes('include /etc/nginx/feeds.conf'));
});

test('the shared dashboard entrypoint renders /etc/nginx/feeds.conf and both compose files use it', () => {
  const script = readFileSync(new URL('../../deploy/nginx/dashboard-entrypoint.sh', import.meta.url), 'utf8');
  assert.ok(script.includes('/etc/nginx/feeds.conf'), 'entrypoint script no longer renders feeds.conf');
  for (const file of ['../../docker-compose.yml', '../../docker-compose.readonly.yml']) {
    const compose = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(compose.includes('/etc/po11y-dashboard-entrypoint.sh'),
      `${file} dashboard no longer runs the shared entrypoint`);
  }
});

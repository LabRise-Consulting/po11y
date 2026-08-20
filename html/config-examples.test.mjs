// The shipped config examples are the first thing an operator copies, so what
// they hardcode becomes what every deployment hardcodes. These assert them
// against the real resolver in app.lib.js rather than against a regex, so a
// change to either side has to keep the pair honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withHost } from './app.lib.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const bundled = load('config.example.json');
const readonly = load('config.readonly.example.json');

/** Every href a card declares, in declaration order. */
const hrefs = (cfg) => Object.values(cfg.cards || {})
  .flat()
  .map((c) => c.href)
  .filter(Boolean);

/** The subset that points at the monitored n8n rather than at this box. */
const n8nHrefs = (cfg) => hrefs(cfg).filter((h) => h.includes('{n8n}') || h.includes('{host}'));

test('both example configs point some card at the monitored n8n', () => {
  assert.ok(n8nHrefs(bundled).length > 0, 'bundled example has no n8n link to check');
  assert.ok(n8nHrefs(readonly).length > 0, 'read-only example has no n8n link to check');
});

// The regression: `http://{host}:5678/...` cannot express an n8n behind TLS,
// or on any other port. A read-only operator whose n8n is at
// https://n8n.example.com got a card pointing at http://n8n.example.com:5678.
test('the read-only example follows n8nUrl to a TLS n8n on the default port', () => {
  const cfg = { ...readonly, baseUrl: 'n8n.example.com', n8nUrl: 'https://{host}' };
  for (const href of n8nHrefs(cfg)) {
    assert.ok(withHost(href, cfg, 'box.local').startsWith('https://n8n.example.com/'),
      `${href} did not resolve onto the configured n8nUrl`);
  }
});

test('the read-only example follows n8nUrl to a non-default port', () => {
  const cfg = { ...readonly, baseUrl: 'n8n.internal', n8nUrl: 'http://{host}:8443' };
  for (const href of n8nHrefs(cfg)) {
    assert.ok(withHost(href, cfg, 'box.local').startsWith('http://n8n.internal:8443/'),
      `${href} did not resolve onto the configured n8nUrl`);
  }
});

// The bundled stack owns its n8n and always publishes it on BIND_ADDR:5678, so
// its example ships no n8nUrl at all — the placeholder must still resolve to
// that default rather than to an empty string.
test('the bundled example resolves n8n links without declaring an n8nUrl', () => {
  assert.equal(bundled.n8nUrl, undefined);
  for (const href of n8nHrefs(bundled)) {
    assert.ok(withHost(href, bundled, 'box.local').startsWith('http://box.local:5678/'),
      `${href} did not resolve onto the bundled default`);
  }
});

// {self} is the box serving the dashboard. On the read-only topology that is a
// different machine from n8n, so a local service linked through {host} would
// point at the remote.
test('the read-only example keeps its local-service cards on {self}', () => {
  const local = hrefs(readonly).filter((h) => /:(9090|3000|20128)\b/.test(h));
  assert.ok(local.length > 0, 'read-only example has no local-service card to check');
  for (const href of local) {
    assert.ok(href.includes('{self}'), `${href} points a local service at the n8n host`);
  }
});

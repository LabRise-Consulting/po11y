import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry } from './registry.mjs';

/** Write `content` to a fresh config.json and return its path. */
function configFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-registry-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content);
  return path;
}

const off = { available: () => false };
const sources = { feeds: { ...off, readSafe: () => null }, prometheus: off, n8n: off, grafana: off, datatables: off };

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

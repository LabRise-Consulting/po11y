import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, setKv } from './db.mjs';
import { seedCache, seedBuiltAt, persistCache } from './cache.mjs';

const DEFAULTS = { 'ai-map.json': null, 'notifications.json': [] };

const withDb = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openDb(join(dir, 'po11y.db'));
};

test('seedCache falls back to defaults on a fresh store', (t) => {
  const db = withDb(t);
  assert.deepEqual(seedCache(db, DEFAULTS), DEFAULTS);
});

test('persisted ai-map and notifications survive a reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'po11y.db');

  const first = openDb(path);
  const cached = {
    ...DEFAULTS,
    'ai-map.json': { generated_at: '2026-08-11T00:00:00.000Z', nodes: [] },
    'notifications.json': [{ id: 'n1', message: 'stale' }],
  };
  persistCache(first, cached);
  first.close();

  const second = openDb(path);
  assert.deepEqual(seedCache(second, DEFAULTS), cached);
  second.close();
});

test('a corrupt kv row falls back to the default rather than throwing', (t) => {
  const db = withDb(t);
  setKv(db, 'ai-map-lastgood', '{not json');
  setKv(db, 'notifications-history', '[also not json');

  assert.deepEqual(seedCache(db, DEFAULTS), DEFAULTS);
});

test('seedBuiltAt reports null on a store no rebuild has ever run against', (t) => {
  const db = withDb(t);
  assert.equal(seedBuiltAt(db), null);
});

test('the build stamp survives a reopen, so a warm cache is not reported as never-built', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'po11y.db');
  const built = 1_760_000_000_000;

  const first = openDb(path);
  persistCache(first, DEFAULTS, built);
  first.close();

  const second = openDb(path);
  assert.equal(seedBuiltAt(second), built);
  second.close();
});

test('a corrupt build stamp reads as never-built rather than throwing or as NaN', (t) => {
  const db = withDb(t);
  setKv(db, 'cache-built-at', 'yesterday');
  assert.equal(seedBuiltAt(db), null);
});

test('a null ai-map persists and reseeds as null, not the default', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'po11y.db');

  const first = openDb(path);
  persistCache(first, { 'ai-map.json': null, 'notifications.json': [{ id: 'n1' }] });
  first.close();

  const second = openDb(path);
  const seeded = seedCache(second, { 'ai-map.json': { stale: true }, 'notifications.json': [] });
  assert.equal(seeded['ai-map.json'], null);
  assert.deepEqual(seeded['notifications.json'], [{ id: 'n1' }]);
  second.close();
});

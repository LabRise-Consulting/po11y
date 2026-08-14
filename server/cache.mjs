// Persistence for the two feeds that are expensive (or impossible) to
// regenerate from a cold store: the AI map's last-good document and the
// notifications history. Everything else in `cached` is a pure function of
// the store's own rows and is rebuilt for free on the next `rebuild()`, so it
// is not persisted here.
//
// Kept out of index.mjs (wiring only, no index.test.mjs by design) so the
// round-trip has a home to be tested from.
import { getKv, setKv } from './db.mjs';

const AI_MAP_KEY = 'ai-map-lastgood';
const NOTIFICATIONS_KEY = 'notifications-history';
const BUILT_AT_KEY = 'cache-built-at';

/**
 * Read persisted state into a fresh `cached` object at boot. Corrupt or
 * absent kv rows fall back to `defaults` rather than throwing — a boot must
 * not fail because of a bad cache entry, since the next rebuild will
 * overwrite it anyway.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{'ai-map.json': object|null, 'notifications.json': object[]}} defaults
 */
export function seedCache(db, defaults) {
  const cached = { ...defaults };

  const rawMap = getKv(db, AI_MAP_KEY);
  if (rawMap != null) {
    try { cached['ai-map.json'] = JSON.parse(rawMap); } catch { /* keep default */ }
  }

  const rawNotifications = getKv(db, NOTIFICATIONS_KEY);
  if (rawNotifications != null) {
    try { cached['notifications.json'] = JSON.parse(rawNotifications); } catch { /* keep default */ }
  }

  return cached;
}

/**
 * When the persisted cache was last built, or null if no rebuild has ever
 * completed against this store.
 *
 * This is what separates "published and empty" from "never published": the
 * cold-start default for notifications.json is `[]`, which on its own reads as
 * a watchdog that ran and found nothing. The MCP feeds adapter gates on this
 * stamp (server/mcp/sources.mjs makeCachedFeeds), so a serving-only server
 * that has never rebuilt reports unavailable instead of "no open failures" —
 * while a restart onto a warm store keeps serving its last-good documents,
 * with an honest age.
 *
 * A corrupt or absent row reads as "never built" rather than throwing, for the
 * same reason seedCache tolerates bad JSON.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number|null}
 */
export function seedBuiltAt(db) {
  const raw = getKv(db, BUILT_AT_KEY);
  const ms = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(ms) ? ms : null;
}

/**
 * Persist the two feeds that must survive a restart, plus the build stamp that
 * says they are real data rather than cold-start defaults. Called after every
 * rebuild — cheap relative to the rebuild it follows, and it closes the boot
 * window where a restart would otherwise serve `null`/`[]` until the first
 * sync/poll tick completes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{'ai-map.json': object|null, 'notifications.json': object[]}} cached
 * @param {number} builtAtMs - epoch ms of the rebuild that produced `cached`
 */
export function persistCache(db, cached, builtAtMs = Date.now()) {
  setKv(db, AI_MAP_KEY, JSON.stringify(cached['ai-map.json'] ?? null));
  setKv(db, NOTIFICATIONS_KEY, JSON.stringify(cached['notifications.json'] ?? []));
  setKv(db, BUILT_AT_KEY, String(Number.isFinite(Number(builtAtMs)) ? Number(builtAtMs) : Date.now()));
}

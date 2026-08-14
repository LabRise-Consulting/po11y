// Routing as a pure function of (request, context) so the whole surface is
// testable without opening a socket. index.mjs owns the socket and the body
// reading; everything decision-shaped lives here.
//
// /ingest is the only write path into the store, so it is the only thing here
// with real security weight: the rows it accepts feed status.json, the watchdog
// and the expectations, which means an unauthenticated ingest is a way to forge
// successes and silence alerts. It is therefore OFF unless a token is
// configured, compared in constant time over a digest (so token length does not
// leak), and size-capped.
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseEvent } from './events.mjs';
import { upsertExecutions } from './db.mjs';
import { FEED_NAMES } from './mcp/sources.mjs';

// The single home of the feed-name list is server/mcp/sources.mjs's
// FEED_NAMES — the MCP modules live under server/, so this is a real import
// rather than a test-pinned copy. The nginx and k8s
// copies still cannot import it; server/mcp/registry.test.mjs keeps pinning
// those.
export const FEEDS = new Set(FEED_NAMES);
const SCOPE_RE = /^[a-z0-9-]+$/;
const DEFAULT_MAX_BODY = 1_000_000;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const FEED_HEADERS = { ...JSON_HEADERS, 'x-po11y-source': 'po11y-server' };

const json = (status, value, headers = JSON_HEADERS) => ({
  status, body: JSON.stringify(value), headers,
});
const notFound = () => json(404, { error: 'not found' });

const digest = (s) => createHash('sha256').update(String(s)).digest();
const tokenMatches = (given, expected) => timingSafeEqual(digest(given), digest(expected));

const bearer = (headers) => {
  const raw = headers?.authorization || headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw));
  return m ? m[1] : (headers?.['x-po11y-token'] || '');
};

/**
 * @param {{method: string, url: string, body: (string|null), headers?: object}} req
 * @param {{db: object, feeds: () => object, scope: string, health: () => object,
 *   ingestToken: string, maxBodyBytes?: number,
 *   mcpDispatch?: (msg: object) => Promise<object|null>,
 *   metricsText?: () => string,
 *   n8nBase?: string, readKey?: string, fetchFn?: typeof fetch}} ctx
 */
export async function route(req, ctx) {
  let path;
  try {
    path = decodeURIComponent(String(req.url || '').split('?')[0]);
  } catch {
    return notFound(); // a malformed percent-escape is not a route
  }

  if (path === '/healthz') {
    const h = ctx.health();
    return json(h.consecutiveFailures >= 3 ? 503 : 200, h);
  }

  if (path === '/metrics') {
    // Absent unless the caller supplies a renderer, so a context without metrics
    // wiring 404s rather than serving an empty exposition that Prometheus would
    // happily scrape as "all series gone".
    if (!ctx.metricsText) return notFound();
    if (req.method !== 'GET') return json(405, { error: 'GET only' });
    return {
      status: 200,
      body: ctx.metricsText(),
      headers: { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' },
    };
  }

  if (path === '/ingest') {
    // Unconfigured means absent, not open: a 405/401 would advertise a write
    // endpoint that the operator never enabled.
    if (!ctx.ingestToken) return notFound();
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    if (!tokenMatches(bearer(req.headers), ctx.ingestToken)) return json(401, { error: 'unauthorized' });

    const max = ctx.maxBodyBytes ?? DEFAULT_MAX_BODY;
    if (Buffer.byteLength(req.body ?? '', 'utf8') > max) return json(413, { error: 'body too large' });

    let body;
    try { body = JSON.parse(req.body ?? ''); } catch { return json(400, { error: 'invalid JSON' }); }
    const events = Array.isArray(body) ? body : [body];
    const rows = events.flatMap((e) => parseEvent(e));
    upsertExecutions(ctx.db, rows);
    return { status: 204, body: '', headers: {} };
  }

  // MCP over streamable HTTP, folded in from the retired mcp container. The
  // dispatcher is pure (msg -> response|null); everything transport-shaped —
  // body cap, stream errors — is already handled by index.mjs's listener.
  // Answer shapes: 405+Allow for non-POST, a 200-wrapped JSON-RPC error for
  // bad bodies (parse error, batch), 202 for notifications, and -32603
  // (never a transport 500) for a handler throw.
  if (path === '/mcp' || path === '/mcp/') {
    if (!ctx.mcpDispatch) return notFound();
    if (req.method !== 'POST') return { status: 405, body: '', headers: { allow: 'POST' } };
    const rpcError = (code, message) =>
      json(200, { jsonrpc: '2.0', id: null, error: { code, message } });
    let msg;
    try { msg = JSON.parse(req.body ?? ''); } catch { return rpcError(-32700, 'parse error'); }
    if (Array.isArray(msg)) return rpcError(-32600, 'JSON-RPC batching was removed in MCP 2025-06-18');
    let out;
    try { out = await ctx.mcpDispatch(msg); } catch (e) {
      return rpcError(-32603, String((e && e.message) || e));
    }
    if (out === null) return { status: 202, body: '', headers: {} };
    return json(200, out);
  }

  // n8n Data Tables read proxy, moved here from nginx. On n8n CE an API key
  // cannot be scoped, so this allowlist — data-tables paths, GET only, 403
  // for everything else — is the ONLY control keeping the injected key
  // read-only-to-data-tables (nginx.conf carried the same warning). Unlike
  // nginx's unanchored `location /n8n-table/data-tables` (a bare prefix that
  // also matches "/n8n-table/data-tablesEVIL"), this check requires a segment
  // boundary: the allowed pathname is exactly "/n8n-table/data-tables" or
  // starts with "/n8n-table/data-tables/". The raw URL is normalised through
  // WHATWG URL first: it resolves dot segments (including their %2e
  // spellings) exactly like nginx's URI normalisation, so a
  // "/data-tables/../workflows" can never pass this check either. What the URL
  // parser does NOT decode is an OPAQUE %2e inside a segment name — those are
  // forwarded verbatim, exactly as nginx forwarded them before, and the
  // decoding is left to n8n's own router. Deferred deliberately, not
  // overlooked: the allowlist above already pins the first two path segments,
  // so an opaque escape can only vary what comes after /data-tables/.
  if (path === '/n8n-table' || path.startsWith('/n8n-table/')) {
    const forbidden = () => json(403, { error: 'forbidden' });
    let u;
    try { u = new URL(String(req.url || ''), 'http://po11y.internal'); } catch { return forbidden(); }
    const isDataTables = u.pathname === '/n8n-table/data-tables' || u.pathname.startsWith('/n8n-table/data-tables/');
    if (!isDataTables) return forbidden();
    if (req.method !== 'GET') return forbidden();
    const target = ctx.n8nBase + u.pathname.replace('/n8n-table/', '/api/v1/') + u.search;
    // BOTH phases are inside the try, request and body. The outbound fetch
    // carries AbortSignal.timeout(N8N_TIMEOUT_MS), which aborts the whole
    // exchange rather than just the connect: headers can arrive inside the
    // deadline and the body still reject afterwards. Reading the body outside
    // this catch lets that rejection escape into makeRequestHandler's
    // catch-all and answer 500 — the very misattribution the 502 exists to
    // prevent.
    try {
      const res = await ctx.fetchFn(target, {
        method: 'GET',
        headers: { 'X-N8N-API-KEY': ctx.readKey ?? '', accept: 'application/json' },
      });
      return {
        status: res.status,
        // The whole upstream body is buffered rather than streamed (nginx
        // streamed it). Bounded in practice: this route only ever reaches n8n's
        // data-table endpoints, which page at limit<=250, and every caller is
        // already behind the dashboard's auth. Revisit if the allowlist ever
        // grows an endpoint without a page cap.
        body: await res.text(),
        headers: {
          'content-type': res.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        },
      };
    } catch (e) {
      // 502, not the handler's catch-all 500: nginx answered 502 for this
      // route before the proxy moved here, and a 500 would blame the po11y
      // server for an n8n outage or a timeout. The message is the fetch's own
      // (connection refused, aborted) — it carries no URL, so no credential.
      return json(502, { error: 'upstream request failed', reason: String((e && e.message) || e) });
    }
  }

  const flat = path.slice(1);
  if (FEEDS.has(flat)) {
    const doc = ctx.feeds()[flat];
    // null means "not built yet" (ai-map.json's cold-start default in
    // index.mjs) — every feed treats it the same way files mode treats a
    // missing file: 404, not a 200 body of the literal string "null".
    return doc == null ? notFound() : json(200, doc, FEED_HEADERS);
  }

  // One server answers for one n8n, so it answers for one scope key.
  const scoped = path.match(/^\/status\/([^/]+)\/([^/]+)$/);
  if (scoped) {
    const [, scope, feed] = scoped;
    if (!SCOPE_RE.test(scope) || scope !== ctx.scope || !FEEDS.has(feed)) return notFound();
    const doc = ctx.feeds()[feed];
    return doc == null ? notFound() : json(200, doc, FEED_HEADERS);
  }

  return notFound();
}

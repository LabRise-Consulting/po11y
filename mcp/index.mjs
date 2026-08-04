// Po11y MCP server — read-only MCP over streamable HTTP.
//
// SECURITY INVARIANTS:
//   - No write path to n8n: every n8n call goes through collector/collect.mjs's
//     apiGet, which hard-codes method:'GET'. The only POST this process makes
//     is to Grafana's /api/ds/query (SQL rides in the body), never to n8n.
//   - No authentication here by design: the process binds inside the compose
//     network and is never published to the host. nginx's /mcp/ location sits
//     behind the same auth guard as the dashboard (Basic Auth, or forward-auth
//     OIDC). MCP access is therefore dashboard access — see docs/security.md.
//   - No execution payloads leave this process; tools report shapes and error
//     text only (see mcp/tools/ops.mjs).
//   - No secret (API key, connection string) appears in any response or log.

import { createServer } from 'node:http';
import { createDispatcher } from './protocol.mjs';
import { detectSources } from './sources.mjs';
import { buildRegistry } from './registry.mjs';

const PORT = Number(process.env.PORT || 8082);
const MAX_BODY = Number(process.env.MCP_MAX_BODY || 1_048_576); // 1 MiB

/**
 * Read a request body, refusing anything over maxBytes. A cap matters because
 * this endpoint is reachable by anything that got past nginx's auth.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks = [];
    req.on('data', (c) => {
      // Once we've rejected once, later chunks just drain to /dev/null: don't
      // allocate a fresh Error and reject an already-settled promise per chunk.
      if (overLimit) return;
      size += c.length;
      if (size > maxBytes) {
        overLimit = true;
        // Don't req.destroy() here: IncomingMessage#destroy() tears down the
        // whole duplex socket, including the writable half the 413 response
        // needs. Just stop buffering and let the handler answer normally;
        // remaining bytes are still read (and discarded) off the wire. The
        // caller is responsible for closing the connection once that 413 is
        // actually flushed — see createApp's 413 branch.
        const err = new Error('body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const rpcError = (res, code, message) =>
  send(res, 200, { jsonrpc: '2.0', id: null, error: { code, message } });

/**
 * Build the node:http request listener. Exported so tests can drive it without
 * binding the real port.
 *
 * @param {{dispatch: Function, health: Function, maxBody?: number}} deps
 */
export function createApp({ dispatch, health, maxBody = MAX_BODY }) {
  return async function app(req, res) {
    const path = String(req.url || '').split('?')[0];

    if (path === '/healthz') return send(res, 200, health());
    if (path !== '/mcp' && path !== '/mcp/') return send(res, 404, { error: 'not found' });

    // No server-initiated streams: nothing here pushes notifications, so the
    // GET half of streamable HTTP has nothing to carry. 405 is the spec's
    // sanctioned answer for a server that does not offer it.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }

    let raw;
    try {
      raw = await readBody(req, maxBody);
    } catch (e) {
      if (e && e.statusCode === 413) {
        // readBody deliberately left the socket open so this response could
        // be written; close it once that write is actually flushed. Without
        // this, a client that declared a huge Content-Length and then went
        // quiet keeps the connection open — bounded only by Node's ~300s
        // default request timeout — which defeats maxBody's purpose as a DoS
        // boundary for anything that got past nginx's auth.
        res.on('finish', () => req.destroy());
        return send(res, 413, { error: 'body too large' });
      }
      return rpcError(res, -32603, 'read error');
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(res, -32700, 'parse error');
    }
    if (Array.isArray(msg)) {
      return rpcError(res, -32600, 'JSON-RPC batching was removed in MCP 2025-06-18');
    }

    // app() is handed straight to createServer(): node:http neither awaits
    // nor catches request listeners, so an uncaught throw/rejection here
    // becomes a process-level unhandled rejection that can take the whole
    // server down over one bad request. Answer with -32603 instead.
    let out;
    try {
      out = await dispatch(msg);
    } catch (e) {
      return rpcError(res, -32603, String((e && e.message) || e));
    }
    if (out === null) {
      res.writeHead(202);
      return res.end();
    }
    return send(res, 200, out);
  };
}

/** Boot: probe sources, build the tool registry, listen. */
async function main() {
  const sources = await detectSources(process.env);
  const { tools, resources } = buildRegistry(sources);
  const dispatch = createDispatcher({
    tools,
    resources,
    serverInfo: { name: 'po11y', version: '1' },
  });
  const health = () => ({
    ok: true,
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.available()])),
    tools: tools.length,
  });

  const enabled = Object.entries(sources).filter(([, v]) => v.available()).map(([k]) => k);
  // Names only — never a URL with credentials in it.
  process.stdout.write(`po11y-mcp: listening on :${PORT}, sources: ${enabled.join(', ') || 'none'}\n`);
  createServer(createApp({ dispatch, health })).listen(PORT);
}

// Import-safe: tests import createApp without starting a listener.
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) main();

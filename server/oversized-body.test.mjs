import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { makeRequestHandler } from './request.mjs';

const MAX = 1000;

function start(t) {
  const handler = makeRequestHandler({
    route: async () => ({ status: 204, headers: {}, body: '' }),
    ctx: {},
    maxBodyBytes: MAX,
    log: () => {},
  });
  const server = createServer(handler);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * Send a declared body larger than the cap, keep writing after the refusal,
 * and report what the client actually received — including whether the
 * connection was reset rather than closed.
 */
function postOversized(port, totalBytes) {
  return new Promise((resolve) => {
    let data = '';
    let reset = null;
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'POST /ingest HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
        + `Content-Length: ${totalBytes}\r\n\r\n`,
      );
      // Written in chunks so the refusal lands while the client is still
      // sending — the case where destroying the socket costs the response.
      const chunk = 'x'.repeat(2048);
      for (let sent = 0; sent < totalBytes; sent += chunk.length) sock.write(chunk);
    });
    sock.on('data', (c) => { data += c; });
    sock.on('error', (e) => { reset = e.code || e.message; });
    sock.on('close', () => resolve({ data, reset }));
  });
}

test('an oversized body is refused with a complete 413, not a reset connection', async (t) => {
  const port = await start(t);
  const { data, reset } = await postOversized(port, MAX * 40);

  assert.equal(reset, null, `the client must not see a connection reset (got ${reset})`);
  assert.match(data, /^HTTP\/1\.1 413\b/, `expected a 413 status line, got: ${JSON.stringify(data.slice(0, 80))}`);
  assert.match(data, /\{"error":"body too large"\}/, 'the documented error body must arrive intact');
});

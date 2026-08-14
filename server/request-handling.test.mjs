import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';

// index.mjs is process wiring with no test file by design (see its own top
// comment) — it self-executes on import and requires N8N_API_URL/N8N_API_KEY
// or it process.exit(1)s, so booting the real thing here would mean mocking
// n8n's network surface just to reach a socket-plumbing bug. This test
// instead reproduces index.mjs's exact request-handling shape (buffer the
// body, guard against an aborted stream) in an isolated server, to prove the
// mechanism the fix relies on: a client that aborts mid-body must not take
// the process down with it.
//
// The malformed chunked-encoding trick below is what actually reaches
// IncomingMessage's 'error' event (a client socket RST during a
// Content-Length body routes through the server's own 'clientError' handler
// instead, which Node already guards by default). Empirically, on Node 24
// this specific failure did not crash an otherwise-unguarded server either —
// so the standing risk this handler defends against is Node-version/timing
// dependent, not reliably reproducible as a before/after crash in a fast
// test. The guard is cheap and correct regardless, so it stays; this test
// proves the guard fires and the server keeps serving requests afterward.
function makeGuardedServer() {
  let errors = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('error', (e) => {
      errors += 1;
      res.destroy();
      void e;
    });
    res.on('error', () => { errors += 1; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  return { server, errorCount: () => errors };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Poll until `check()` is truthy or `ms` elapses, without depending on a
 * socket 'close' event — after res.destroy() the client side of a broken
 * chunked stream does not reliably emit 'close' on every platform/timing, so
 * waiting on it made this test flaky. Polling the guard's own effect
 * (errorCount) is what the test actually needs to prove. */
async function waitFor(check, ms = 2000, step = 20) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return check();
}

function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('a client that aborts mid-body with malformed chunked framing does not crash the server', async (t) => {
  const { server, errorCount } = makeGuardedServer();
  const port = await listen(server);
  t.after(() => server.close());

  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write('POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n');
    sock.write('not-a-hex-chunk-size\r\n');
  });
  sock.on('error', () => {}); // the client side of the same broken stream
  t.after(() => sock.destroy());

  assert.ok(await waitFor(() => errorCount() >= 1), 'the req/res error guard must have fired at least once');
  // The server process is still this test process — reaching this line at
  // all is the proof an unhandled 'error' event did not throw. Prove it is
  // still functionally alive too: a normal request still gets a normal reply.
  const reply = await get(port, '/');
  assert.match(reply, /200/);
  assert.match(reply, /\bok\b/);
});

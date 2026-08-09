import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createApp } from './index.mjs';

async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const echoDispatch = async (msg) => (msg.method === 'ping'
  ? { jsonrpc: '2.0', id: msg.id, result: {} }
  : null);
const app = createApp({ dispatch: echoDispatch, health: () => ({ ok: true, sources: {} }) });

test('POST /mcp returns the dispatcher result', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).result, {});
  });
});

test('a notification gets 202 with an empty body', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });
});

test('GET /mcp is 405 — this server opens no server-initiated stream', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

test('a JSON-RPC batch is rejected: batching is gone in 2025-06-18', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    });
    assert.equal((await res.json()).error.code, -32600);
  });
});

test('unparseable JSON is a parse error, not a crash', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    });
    assert.equal((await res.json()).error.code, -32700);
  });
});

test('/healthz reports source availability', async () => {
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

test('/healthz answers GET and HEAD, and refuses anything that could change state', async () => {
  // The health branch sat above the method check, so POST and DELETE to
  // /healthz both answered 200 — a read-only server advertising a write it
  // does not implement.
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/healthz`, { method });
      assert.equal(res.status, 405, `${method} /healthz`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
  });
});

test('an oversized body is rejected with 413', async () => {
  const small = createApp({ dispatch: echoDispatch, health: () => ({}), maxBody: 16 });
  await withServer(small, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(500) } }),
    });
    assert.equal(res.status, 413);
  });
});

test('a stalled oversized upload does not leave the connection open after the 413', async () => {
  // Reproduces the reviewer's scenario directly: a client declares a huge
  // Content-Length, sends only enough bytes to trip maxBody, then goes
  // quiet. fetch() can't express "declare 1MB, send 150 bytes, stop" — it
  // always sends a matching body — so this drives a raw socket instead.
  const small = createApp({ dispatch: echoDispatch, health: () => ({}), maxBody: 16 });
  await withServer(small, async (base) => {
    const url = new URL(base);
    const socket = connect(Number(url.port), url.hostname);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const stalledBody = 'x'.repeat(150); // over maxBody, far short of the declared length
    socket.write(
      'POST /mcp HTTP/1.1\r\n'
      + `Host: ${url.host}\r\n`
      + 'Content-Type: application/json\r\n'
      + 'Content-Length: 1000000\r\n'
      + '\r\n'
      + stalledBody,
    );
    // A raw net.Socket starts paused: without a 'data' consumer it never
    // reads off the wire at all, so it wouldn't notice the server's FIN
    // either. Drain (and ignore) the 413 body so 'close' can actually fire.
    socket.resume();

    const closed = await new Promise((resolve) => {
      socket.once('close', () => resolve(true));
      // If the fix regresses, the socket sits open until Node's request
      // timeout (~300s); fail the test well before that instead of hanging.
      setTimeout(() => resolve(false), 2000);
    });
    socket.destroy();
    assert.equal(closed, true, 'server should close the connection once the 413 is flushed');
  });
});

test('a throwing dispatch yields a -32603 response instead of crashing the process', async () => {
  // app() is the raw node:http request listener — nothing awaits or
  // catches it upstream. A throw/rejection here must be turned into a JSON-RPC
  // error by createApp itself; if it isn't, this becomes an unhandled
  // rejection that node:test reports as a process-level failure, not a
  // clean assertion failure, so a green run of this test is itself evidence
  // the process survived.
  const throwingDispatch = async () => { throw new Error('boom'); };
  const brittle = createApp({ dispatch: throwingDispatch, health: () => ({}) });
  await withServer(brittle, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error.code, -32603);
  });
});

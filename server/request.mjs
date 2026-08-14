// Moved out of index.mjs so the socket plumbing is testable against the real
// handler rather than a copy of its shape.

// How long an over-cap request may keep streaming after it has been refused,
// before the socket is taken away from it.
const DRAIN_GRACE_MS = 5000;

/**
 * @param {{ route: Function, ctx: object, maxBodyBytes: number,
 *           onAccepted?: () => void, log?: (msg: string) => void }} opts
 * @returns {(req: import('node:http').IncomingMessage,
 *            res: import('node:http').ServerResponse) => void}
 */
export function makeRequestHandler({ route, ctx, maxBodyBytes, onAccepted = () => {}, log = console.error }) {
  return (req, res) => {
    const chunks = [];
    let bytes = 0;
    let aborted = false;
    // A client aborting mid-body (dropped connection, closed tab, curl Ctrl-C)
    // can surface as an 'error' event on the IncomingMessage rather than a
    // clean 'end' — with no listener, that is an unhandled 'error' event, which
    // Node treats as fatal: the whole process exits over one bad client. Same
    // reasoning on the response side, mirrored below, for a write that lands
    // after the peer is already gone.
    req.on('error', (e) => {
      aborted = true;
      log(`server: request stream error — ${e.message}`);
      res.destroy();
    });
    res.on('error', (e) => {
      log(`server: response stream error — ${e.message}`);
    });
    req.on('data', (c) => {
      if (aborted) return;
      bytes += c.length;
      // Refuse before buffering the whole thing: the cap must bound memory, not
      // just the response code.
      if (bytes > maxBodyBytes) {
        aborted = true;
        // Deliberately NOT `connection: close`: Node tears the socket down as
        // soon as a close-marked response finishes, and tearing it down while
        // the client is still sending is exactly the reset this avoids. The
        // socket is ended below instead, once the client has finished.
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end('{"error":"body too large"}');
        // Drain the rest of the body instead of destroying the socket under
        // the response. Destroying in this tick tears the connection down
        // while the 413 is still queued: the client sees ECONNRESET (measured:
        // 5 of 6 attempts on loopback) rather than the refusal it was sent,
        // and over a real network the bytes can be lost outright. Reading and
        // discarding lets the response flush and the connection close on a
        // FIN. The discarded chunks are never appended to `chunks`, so this
        // costs no memory — the cap still holds.
        req.resume();
        // A client that keeps streaming forever must not hold the socket for
        // as long as it likes, so the drain has a deadline. By then the
        // response has long since flushed, which is the part that matters.
        const graceTimer = setTimeout(() => req.destroy(), DRAIN_GRACE_MS);
        graceTimer.unref?.();
        req.on('close', () => clearTimeout(graceTimer));
        req.on('end', () => {
          clearTimeout(graceTimer);
          // Nothing is left unread now, so a FIN here is a clean close rather
          // than a reset. The refusal already went out; this only declines to
          // keep the connection alive for a client that just over-sent.
          req.socket?.end();
        });
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
      try {
        const out = await route({ method: req.method, url: req.url, body, headers: req.headers }, ctx);
        res.writeHead(out.status, out.headers);
        res.end(out.body);
        if (out.status === 204) onAccepted();
      } catch (e) {
        log(`server: request failed — ${e.message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal error"}');
      }
    });
  };
}

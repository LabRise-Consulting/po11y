import test from 'node:test';
import assert from 'node:assert/strict';
import { every } from './timers.mjs';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('a tick still running does not overlap with the next one', async (t) => {
  // The failure this guards: n8n accepts the connection and never answers.
  // With a fixed-rate timer, every interval starts another poll on top of the
  // stuck one — sockets and pending fetches accumulate for as long as the hang
  // lasts. Overlapping workflow syncs are worse than wasteful: an older tick's
  // stamp re-upserts rows a newer tick just pruned. The (now-retired)
  // collector daemon re-armed only after a poll settled; the server has to
  // do the same.
  let running = 0;
  let peak = 0;
  let calls = 0;
  const stop = every(0.02, 'slow', async () => {
    calls += 1;
    running += 1;
    peak = Math.max(peak, running);
    await sleep(80);
    running -= 1;
  }, { log: () => {} });
  t.after(stop);

  await sleep(250);
  assert.equal(peak, 1, 'at most one tick may be in flight at a time');
  assert.ok(calls >= 2, `the loop must keep ticking (saw ${calls})`);
});

test('a tick that throws is logged and the loop keeps running', async (t) => {
  const logged = [];
  let calls = 0;
  const stop = every(0.02, 'flaky', async () => {
    calls += 1;
    throw new Error('n8n unreachable');
  }, { log: (m) => logged.push(m) });
  t.after(stop);

  await sleep(120);
  assert.ok(calls >= 2, `a failed tick must not end the loop (saw ${calls})`);
  assert.match(logged[0], /server: flaky — n8n unreachable/);
});

test('a failed tick retries before the full interval when a retry delay is set', async (t) => {
  // The failure this guards: on a cold `bootstrap.sh` the server starts while
  // n8n is still running its first-boot migrations, so the immediate first
  // workflow sync fails. Re-arming at SYNC_INTERVAL left the architecture map
  // empty for the next ten minutes — long enough that CI saw it as a broken
  // stack and an operator sees it as a broken install. n8n also restarts
  // mid-bootstrap, so this is not only a first-boot window.
  let calls = 0;
  const stop = every(10, 'workflow sync', async () => {
    calls += 1;
    throw new Error('fetch failed');
  }, { log: () => {}, retrySeconds: 0.02 });
  t.after(stop);

  await sleep(150);
  assert.ok(calls >= 3, `a failed tick must retry at the retry delay, not the interval (saw ${calls})`);
});

test('a tick that recovers returns to the normal interval', async (t) => {
  // The retry delay must not become the loop's real cadence once n8n is back:
  // a 15 s sync against a healthy instance would page the whole workflow list
  // forty times as often as SYNC_INTERVAL asks for.
  let calls = 0;
  const stop = every(0.25, 'workflow sync', async () => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed');
  }, { log: () => {}, retrySeconds: 0.02 });
  t.after(stop);

  await sleep(120);
  assert.equal(calls, 2, 'the retry after the failure must be fast');
  await sleep(60);
  assert.equal(calls, 2, 'after a success the loop must wait the full interval again');
});

test('without a retry delay a failed tick still waits the full interval', async (t) => {
  // every() is shared with poll-fill, whose 30 s interval is already short
  // enough to self-heal. Retrying faster than that on failure would mean more
  // load on an n8n instance that is already struggling, so the backoff stays
  // opt-in.
  let calls = 0;
  const stop = every(10, 'poll-fill', async () => {
    calls += 1;
    throw new Error('fetch failed');
  }, { log: () => {} });
  t.after(stop);

  await sleep(150);
  assert.equal(calls, 1, `no retry delay means no early retry (saw ${calls})`);
});

test('a non-positive interval disables the loop instead of spinning', () => {
  const logged = [];
  let calls = 0;
  every(0, 'poll-fill', async () => { calls += 1; }, { log: (m) => logged.push(m) });
  assert.equal(calls, 0);
  assert.deepEqual(logged, ['server: poll-fill disabled']);
});

test('stopping the loop stops the ticks', async () => {
  let calls = 0;
  const stop = every(0.02, 'x', async () => { calls += 1; }, { log: () => {} });
  await sleep(60);
  stop();
  const after = calls;
  await sleep(80);
  assert.equal(calls, after, 'no tick may run after stop()');
});

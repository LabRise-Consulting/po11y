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

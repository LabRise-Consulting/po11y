// The server's only repeating schedule. Split out of index.mjs so the one
// property that matters here is testable: ticks never overlap.
//
// A fixed-rate timer (setInterval) is the wrong shape for work that talks to
// n8n. When the instance accepts a connection and then stalls, every interval
// starts another tick on top of the stuck one and they accumulate — sockets,
// pending fetches, and, for workflow sync, two passes racing on the same rows
// (an older tick's stamp re-upserting what a newer one just pruned). Re-arming
// only after a tick settles bounds that to one in flight, whatever n8n does.
// Same discipline the (now-retired) collector daemon's poll loop used.
//
// The interval therefore means "at least this long between ticks", not "every
// this many seconds" — the honest reading for work of unbounded duration.
// Bounding the duration itself is a separate concern: withTimeout in sync.mjs.

/**
 * @param {number} seconds - gap between ticks; <= 0 disables the loop
 * @param {string} label - used in log lines
 * @param {() => Promise<void>} fn - the tick
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {() => void} stop
 */
export function every(seconds, label, fn, { log = console.error } = {}) {
  if (seconds <= 0) { log(`server: ${label} disabled`); return () => {}; }

  let timer = null;
  let stopped = false;

  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      log(`server: ${label} — ${e.message}`);
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      schedule(); // re-arm only after the tick settles
    }, seconds * 1000);
    timer.unref?.();
  };

  // Run once immediately so a restart does not wait a full interval for its
  // first sync, then fall into the settle-then-re-arm loop.
  tick().then(schedule);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

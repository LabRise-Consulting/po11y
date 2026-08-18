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
//
// One asymmetry the interval alone cannot express: a tick that FAILS should
// not wait as long as one that succeeded. The workflow sync runs every 600 s,
// and its first tick fires the moment the process starts — which on a cold
// `bootstrap.sh` is while n8n is still running its first-boot migrations. That
// tick fails, and re-arming at the full interval left the map and ai-map feeds
// empty for the following ten minutes. `retrySeconds` shortens the gap after a
// failure only; a success always returns to the full interval. It is opt-in
// because poll-fill's 30 s interval already self-heals, and retrying faster
// than that would only add load to an n8n instance that is already unwell.

/**
 * @param {number} seconds - gap between ticks; <= 0 disables the loop
 * @param {string} label - used in log lines
 * @param {() => Promise<void>} fn - the tick
 * @param {{ log?: (msg: string) => void, retrySeconds?: number }} [opts]
 *   retrySeconds: after a FAILED tick, wait this long instead of `seconds`.
 *   Opt-in, because it is only worth having where the interval is long enough
 *   that one failure strands the feeds — see the note above.
 * @returns {() => void} stop
 */
export function every(seconds, label, fn, { log = console.error, retrySeconds = 0 } = {}) {
  if (seconds <= 0) { log(`server: ${label} disabled`); return () => {}; }

  // A retry delay longer than the interval would slow recovery rather than
  // speed it up, so it is clamped to the interval it is meant to shorten.
  const retry = retrySeconds > 0 ? Math.min(retrySeconds, seconds) : 0;

  let timer = null;
  let stopped = false;

  const tick = async () => {
    try {
      await fn();
      return true;
    } catch (e) {
      log(`server: ${label} — ${e.message}`);
      return false;
    }
  };

  // A failed tick re-arms at the retry delay; a successful one always returns
  // to the full interval, so recovery never becomes the loop's real cadence.
  const nextDelay = (ok) => ((ok || !retry) ? seconds : retry);

  const schedule = (delaySeconds) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const ok = await tick();
      schedule(nextDelay(ok)); // re-arm only after the tick settles
    }, delaySeconds * 1000);
    timer.unref?.();
  };

  // Run once immediately so a restart does not wait a full interval for its
  // first sync, then fall into the settle-then-re-arm loop.
  tick().then((ok) => schedule(nextDelay(ok)));

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

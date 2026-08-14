// Outbound push for watchdog alerts — Slack, Discord, Telegram, or a raw JSON
// POST to anything that speaks webhooks (including n8n itself).
//
// SECURITY
//   - The target URL IS the credential. A Slack incoming webhook and a Telegram
//     bot endpoint both carry their secret in the path, so the URL is never
//     logged, never echoed in an error string, and never written into a feed.
//     redactUrl() is the only way it may appear in output.
//   - This POSTs to an operator-configured host that is NOT the n8n host, which
//     is exactly the shape of the existing AI-annotation call the GET-only
//     invariant test already permits. The n8n API key is not in scope here and
//     is never passed to this module.
//   - Nothing from the webhook's *response* is parsed or acted on; only the
//     status code is read. A hostile endpoint cannot feed data back in.
//
// Failure is always reported, never thrown: a broken webhook must not stop the
// server publishing feeds. Alerting is an addition to the feeds, not a
// precondition for them.

import { alertLink } from './watchdog.mjs';

export const FORMATS = ['slack', 'discord', 'telegram', 'raw'];

const MARK = { firing: '🔴', resolved: '✅' };

// The product name, emphasised the way each platform actually spells emphasis.
// `*text*` is bold ONLY in Slack mrkdwn: Discord reads it as italic, and
// Telegram — which we send without parse_mode, deliberately — renders the
// asterisks literally. A single shared string looked right in exactly one of
// the four sinks. `raw` stays plain because its consumer owns the rendering.
const HEADER = {
  slack: '*Po11y*',
  discord: '**Po11y**',
  telegram: 'Po11y',
  raw: 'Po11y',
};

/**
 * Reduce a URL to scheme + host. Both Slack and Telegram put the shared secret
 * in the path, so anything beyond the host is unsafe to print.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Does urlStr point at the same host:port as baseStr? Backs the startup check
 * for docs/security.md's claim that the outbound URLs (AI_MAP_BASE_URL,
 * ALERT_WEBHOOK_URL, ALERT_HEARTBEAT_URL) never target the n8n host — the
 * server refuses such a URL instead of merely documenting that it won't
 * happen. host (not hostname) so a webhook on the same machine but another
 * port — a local Uptime Kuma next to n8n — stays legal.
 *
 * Unparseable URLs return false: the fetch will fail loudly on its own, and
 * this check must never be the thing that hides that error.
 *
 * @param {string} urlStr
 * @param {string} baseStr
 * @returns {boolean}
 */
export function targetsHost(urlStr, baseStr) {
  try {
    return new URL(urlStr).host === new URL(baseStr).host;
  } catch {
    return false;
  }
}

/**
 * One human-readable line per alert, with a deep link when we can build one.
 *
 * Link syntax is per-platform and cannot be shared:
 *   slack     <url|label> — mrkdwn. A bare URL would unfurl into a preview card
 *             for every alert, which is how a channel becomes unreadable.
 *   discord   bare URL. Markdown links work in embeds but NOT in `content`,
 *             so `[open](url)` would post those literal characters.
 *   telegram  bare URL. We send no parse_mode (see buildPushPayload), so any
 *             markup would show up verbatim; Telegram autolinks bare URLs.
 */
function lineOf(a, format, baseUrl) {
  const head = `${MARK[a.kind] || '•'} ${a.title}${a.message ? ` — ${a.message}` : ''}`;
  const url = alertLink(a, baseUrl);
  if (!url) return head;
  return format === 'slack' ? `${head} <${url}|open>` : `${head} ${url}`;
}

/**
 * Shape the reconciled alerts into the body for one POST.
 *
 * Batched into a single message rather than one request per alert: a restart or
 * a broad outage can produce a dozen alerts at once, and a dozen separate pings
 * is how a channel gets muted. Long bursts are truncated with a count for the
 * same reason.
 *
 * @param {object[]} fire - `fire` from reconcileAlerts (carries `kind`)
 * @param {{format: string, chatId?: string, maxLines?: number}} opts
 * @returns {object|null} request body, or null when there is nothing to say
 */
export function buildPushPayload(fire, { format, chatId = '', maxLines = 10, baseUrl = '' } = {}) {
  if (!FORMATS.includes(format)) {
    throw new Error(`unknown push format "${format}" — expected one of ${FORMATS.join(', ')}`);
  }
  const alerts = Array.isArray(fire) ? fire : [];
  if (!alerts.length) return null;

  const shown = alerts.slice(0, maxLines);
  const lines = shown.map((a) => lineOf(a, format, baseUrl));
  if (alerts.length > shown.length) lines.push(`…and ${alerts.length - shown.length} more`);
  const text = [HEADER[format] || 'Po11y', ...lines].join('\n');

  switch (format) {
    case 'slack': return { text };
    case 'discord': return { content: text };
    // No parse_mode, deliberately. With Markdown/MarkdownV2 Telegram rejects
    // the WHOLE message with a 400 "can't parse entities" when the text holds
    // an unescaped `_`, `*` or `[` — and workflow names like `sync_daily` are
    // ordinary. Losing every alert about a workflow because of its name is a
    // far worse trade than a header that is not bold.
    case 'telegram': return { chat_id: chatId, text, disable_web_page_preview: true };
    // `raw` keeps the structured alerts for a consumer that wants to branch on
    // them (an n8n webhook, most likely), with the summary alongside so a
    // human-facing sink still renders something useful. The link is a real
    // field here rather than embedded in prose, so the consumer does not have
    // to scrape it back out.
    default: return {
      text,
      alerts: alerts.map((a) => {
        const link = alertLink(a, baseUrl);
        return link ? { ...a, link } : a;
      }),
    };
  }
}

/**
 * POST the alerts to the configured webhook.
 *
 * Never throws. Returns {sent, error} so the caller can log a redacted line and
 * carry on; an unreachable Slack must not cost you your feeds.
 *
 * @param {typeof fetch} fetchFn
 * @param {{url: string, format: string, chatId?: string, timeoutMs?: number, maxLines?: number}} cfg
 * @param {object[]} fire
 * @returns {Promise<{sent: boolean, error: (string|null)}>}
 */
export async function pushAlerts(fetchFn, cfg, fire) {
  const { url, format, chatId = '', timeoutMs = 10_000, maxLines = 10, baseUrl = '' } = cfg || {};
  if (!url) return { sent: false, error: null };

  let body;
  try {
    body = buildPushPayload(fire, { format, chatId, maxLines, baseUrl });
  } catch (e) {
    return { sent: false, error: e.message };
  }
  if (!body) return { sent: false, error: null };

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Deliberately not including the response body: a hostile or misconfigured
      // endpoint could echo the request (and therefore nothing secret here), but
      // keeping logs terse and predictable is worth more than its diagnostics.
      return { sent: false, error: `webhook ${redactUrl(url)} -> ${res.status}` };
    }
    return { sent: true, error: null };
  } catch (e) {
    // A transport error can quote the full URL (Node does this) — scrub it, or
    // the webhook secret lands in the container logs.
    const msg = String(e.message || e).split(url).join(redactUrl(url));
    return { sent: false, error: msg };
  }
}

/**
 * Ping an external dead-man switch to say this poll succeeded.
 *
 * The watchdog rules and the unreachable alert both run *inside* the server,
 * so neither survives the machine dying — a dead process cannot send a message.
 * The only way to detect that is to invert it: ping out on every healthy poll
 * and let a service that is not on this box alert when the pings stop.
 * Healthchecks.io, Uptime Kuma push monitors and Better Stack heartbeats all
 * take a plain GET, which is why this is a GET and not a POST.
 *
 * Called ONLY after a successful poll. Firing it on failure too would defeat
 * the entire mechanism.
 *
 * SECURITY: the ping URL is a credential in the same way the webhook URL is —
 * every one of those services puts the monitor id in the path, and anyone
 * holding it can forge a healthy ping and mute the switch. Same treatment:
 * redacted in every log line and scrubbed out of transport errors.
 *
 * Never throws; the poll already succeeded and must not be un-succeeded by a
 * flaky third party.
 *
 * @param {typeof fetch} fetchFn
 * @param {{url: string, timeoutMs?: number}} cfg
 * @returns {Promise<{sent: boolean, error: (string|null)}>}
 */
export async function pingHeartbeat(fetchFn, cfg) {
  const { url, timeoutMs = 10_000 } = cfg || {};
  if (!url) return { sent: false, error: null };
  try {
    const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { sent: false, error: `heartbeat ${redactUrl(url)} -> ${res.status}` };
    return { sent: true, error: null };
  } catch (e) {
    const msg = String(e.message || e).split(url).join(redactUrl(url));
    return { sent: false, error: msg };
  }
}

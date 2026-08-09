// Mode B daemon plumbing — the parts of index.mjs that are pure decisions or
// a plain (req, res) function, extracted so they are unit-testable. index.mjs
// keeps the process-shaped work (env, timers, signals, listen).

import { targetsHost, redactUrl } from './notify.mjs';

/**
 * Enforce docs/security.md's promise that no optional outbound URL targets the
 * n8n host: the webhook/heartbeat URLs are credentials that must not be pointed
 * back at n8n by a copy-paste .env mistake, and the AI call is the only non-GET
 * the core issues. Offending features are disabled — never silently (each one
 * yields an error line), never fatally (the feeds still publish).
 *
 * @param {{ pushUrl?: string, heartbeatUrl?: string, aiBase?: string, aiConfigured?: boolean }} cfg
 * @param {string} n8nUrl
 * @returns {{ pushUrl: string, heartbeatUrl: string, aiConfigured: boolean, errors: string[] }}
 */
export function guardOutbound({ pushUrl = '', heartbeatUrl = '', aiBase = '', aiConfigured = false }, n8nUrl) {
  const errors = [];
  if (pushUrl && targetsHost(pushUrl, n8nUrl)) {
    errors.push(`collector: ALERT_WEBHOOK_URL targets the n8n host (${redactUrl(pushUrl)}) — push disabled`);
    pushUrl = '';
  }
  if (heartbeatUrl && targetsHost(heartbeatUrl, n8nUrl)) {
    errors.push(`collector: ALERT_HEARTBEAT_URL targets the n8n host (${redactUrl(heartbeatUrl)}) — heartbeat disabled`);
    heartbeatUrl = '';
  }
  if (aiConfigured && targetsHost(aiBase, n8nUrl)) {
    errors.push(`collector: AI_MAP_BASE_URL targets the n8n host (${redactUrl(aiBase)}) — falling back to the heuristic map`);
    aiConfigured = false;
  }
  return { pushUrl, heartbeatUrl, aiConfigured, errors };
}

/**
 * A scoped STATUS_DIR whose nginx route can never match, or null when fine.
 *
 * nginx's namespaced location only captures scopes matching [a-z0-9-]+ (the
 * charset IS the traversal sandbox — see nginx.conf), so a second collector
 * pointed at STATUS_DIR=/po11y-status/My_Team publishes feeds the dashboard
 * 404s on forever, silently. mkdirSync accepts any name, hence this startup
 * check. Loud, not fatal: STATUS_DIR may also be a mount point of its own
 * (any basename works for the FLAT default-scope files), and the collector
 * cannot tell the two layouts apart.
 *
 * @param {string} statusDir
 * @returns {string|null} warning line, or null
 */
export function scopeDirWarning(statusDir) {
  const base = String(statusDir).replace(/\/+$/, '').split('/').pop();
  if (/^[a-z0-9-]+$/.test(base)) return null;
  return `collector: STATUS_DIR basename "${base}" is outside nginx's scope charset [a-z0-9-] — ` +
    'if this directory is a scope under the shared status volume, /status/<scope>/ will 404 on it';
}

/**
 * The health/metrics request handler. Exposes ONLY liveness counters and the
 * metrics exposition — no config, no key, no feed data. /healthz answers 503
 * once three consecutive polls have failed so an orchestrator can restart the
 * container.
 *
 * @param {{ health: () => object, metricsText: () => string }} deps - getters,
 *   so the handler always reads the daemon's CURRENT state, not a boot-time copy
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function makeRequestHandler({ health, metricsText }) {
  return (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url.startsWith('/healthz?'))) {
      const h = health();
      const code = h.consecutiveFailures >= 3 ? 503 : 200;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h));
      return;
    }
    if (req.method === 'GET' && (req.url === '/metrics' || req.url.startsWith('/metrics?'))) {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metricsText());
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  };
}

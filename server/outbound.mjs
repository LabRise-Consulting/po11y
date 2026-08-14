// Outbound-URL guarding, split out of the old collector daemon plumbing so it
// is unit-testable independent of the health/metrics HTTP handler.

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
    errors.push(`server: ALERT_WEBHOOK_URL targets the n8n host (${redactUrl(pushUrl)}) — push disabled`);
    pushUrl = '';
  }
  if (heartbeatUrl && targetsHost(heartbeatUrl, n8nUrl)) {
    errors.push(`server: ALERT_HEARTBEAT_URL targets the n8n host (${redactUrl(heartbeatUrl)}) — heartbeat disabled`);
    heartbeatUrl = '';
  }
  if (aiConfigured && targetsHost(aiBase, n8nUrl)) {
    errors.push(`server: AI_MAP_BASE_URL targets the n8n host (${redactUrl(aiBase)}) — falling back to the heuristic map`);
    aiConfigured = false;
  }
  return { pushUrl, heartbeatUrl, aiConfigured, errors };
}

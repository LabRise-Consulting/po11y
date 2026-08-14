import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardOutbound } from './outbound.mjs';

const N8N = 'http://n8n.internal:5678';

// ---- guardOutbound ----------------------------------------------------------
test('guardOutbound passes urls that target other hosts through untouched', () => {
  const g = guardOutbound({
    pushUrl: 'https://hooks.slack.test/T/B/x',
    heartbeatUrl: 'https://hc.example.test/ping/abc',
    aiBase: 'https://llm.example.test/v1',
    aiConfigured: true,
  }, N8N);
  assert.equal(g.pushUrl, 'https://hooks.slack.test/T/B/x');
  assert.equal(g.heartbeatUrl, 'https://hc.example.test/ping/abc');
  assert.equal(g.aiConfigured, true);
  assert.deepEqual(g.errors, []);
});

test('guardOutbound disables each feature whose url targets the n8n host', () => {
  const g = guardOutbound({
    pushUrl: `${N8N}/webhook/x`,
    heartbeatUrl: `${N8N}/ping`,
    aiBase: `${N8N}/v1`,
    aiConfigured: true,
  }, N8N);
  assert.equal(g.pushUrl, '');
  assert.equal(g.heartbeatUrl, '');
  assert.equal(g.aiConfigured, false);
  assert.equal(g.errors.length, 3);
});

test('guardOutbound never leaks the credential path into its error lines', () => {
  const g = guardOutbound({ pushUrl: `${N8N}/services/SECRET-TOKEN` }, N8N);
  assert.equal(g.errors.length, 1);
  assert.doesNotMatch(g.errors[0], /SECRET-TOKEN/);
  assert.match(g.errors[0], /ALERT_WEBHOOK_URL/);
});

test('guardOutbound treats unset urls as nothing to guard', () => {
  assert.deepEqual(guardOutbound({}, N8N),
    { pushUrl: '', heartbeatUrl: '', aiConfigured: false, errors: [] });
});

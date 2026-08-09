import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardOutbound, scopeDirWarning, makeRequestHandler } from './daemon.mjs';

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

// ---- scopeDirWarning --------------------------------------------------------
test('scopeDirWarning accepts the default dir and nginx-routable scope subdirs', () => {
  assert.equal(scopeDirWarning('/po11y-status'), null);
  assert.equal(scopeDirWarning('/po11y-status/team-a'), null);
  assert.equal(scopeDirWarning('/po11y-status/team-a/'), null, 'trailing slash tolerated');
});

test('scopeDirWarning flags a basename nginx\'s scope route can never match', () => {
  for (const dir of ['/po11y-status/My_Team', '/po11y-status/team.a', '/po11y-status/TEAM']) {
    const w = scopeDirWarning(dir);
    assert.ok(w, `${dir} should warn`);
    assert.match(w, /404/);
  }
});

// ---- makeRequestHandler -----------------------------------------------------
const fakeRes = () => {
  const r = { code: null, headers: null, body: null };
  r.writeHead = (code, headers) => { r.code = code; r.headers = headers; };
  r.end = (body) => { r.body = body; };
  return r;
};

test('/healthz answers 200 with the current health state', () => {
  const handler = makeRequestHandler({
    health: () => ({ lastSuccess: 's', lastError: null, consecutiveFailures: 0 }),
    metricsText: () => '',
  });
  const res = fakeRes();
  handler({ method: 'GET', url: '/healthz' }, res);
  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).consecutiveFailures, 0);
});

test('/healthz flips to 503 at three consecutive failures, so an orchestrator restarts', () => {
  let failures = 2;
  const handler = makeRequestHandler({
    health: () => ({ consecutiveFailures: failures }),
    metricsText: () => '',
  });
  const res2 = fakeRes();
  handler({ method: 'GET', url: '/healthz?x=1' }, res2);
  assert.equal(res2.code, 200);
  failures = 3; // getter, not a boot-time copy: the handler sees the new value
  const res3 = fakeRes();
  handler({ method: 'GET', url: '/healthz' }, res3);
  assert.equal(res3.code, 503);
});

test('/metrics serves the exposition text with the prometheus content type', () => {
  const handler = makeRequestHandler({
    health: () => ({}),
    metricsText: () => '# HELP po11y_n8n_up …\npo11y_n8n_up 1\n',
  });
  const res = fakeRes();
  handler({ method: 'GET', url: '/metrics' }, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  assert.match(res.body, /po11y_n8n_up 1/);
});

test('anything else — other paths, non-GET — answers 404', () => {
  const handler = makeRequestHandler({ health: () => ({}), metricsText: () => '' });
  for (const req of [
    { method: 'GET', url: '/' },
    { method: 'GET', url: '/config.json' },
    { method: 'POST', url: '/healthz' },
    { method: 'POST', url: '/metrics' },
  ]) {
    const res = fakeRes();
    handler(req, res);
    assert.equal(res.code, 404, `${req.method} ${req.url}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPushPayload, pushAlerts, pingHeartbeat, redactUrl, targetsHost, FORMATS } from './notify.mjs';
import { alertLink } from './watchdog.mjs';

const firing = (name, msg = 'something broke') => ({
  rule: 'failing', workflowId: 'wf-1', workflowName: name, severity: 'failure',
  title: `${name} is failing`, message: msg, since: null, kind: 'firing',
});
const resolved = (name) => ({
  rule: 'failing', workflowId: 'wf-1', workflowName: name, severity: 'success',
  title: `${name} recovered`, message: 'no longer true', since: null, kind: 'resolved',
});

// ---- buildPushPayload -------------------------------------------------------
test('nothing to say produces no payload, so no request is made', () => {
  assert.equal(buildPushPayload([], { format: 'slack' }), null);
  assert.equal(buildPushPayload(null, { format: 'slack' }), null);
});

test('slack uses the text field', () => {
  const p = buildPushPayload([firing('Nightly sync')], { format: 'slack' });
  assert.ok(typeof p.text === 'string');
  assert.match(p.text, /Nightly sync is failing/);
});

test('discord uses the content field, because it ignores text', () => {
  const p = buildPushPayload([firing('Nightly sync')], { format: 'discord' });
  assert.ok(typeof p.content === 'string');
  assert.equal(p.text, undefined);
  assert.match(p.content, /Nightly sync is failing/);
});

test('telegram carries chat_id alongside the text', () => {
  const p = buildPushPayload([firing('Nightly sync')], { format: 'telegram', chatId: '-100123' });
  assert.equal(p.chat_id, '-100123');
  assert.match(p.text, /Nightly sync is failing/);
});

test('raw sends the structured alerts for a consumer that wants to parse them', () => {
  const p = buildPushPayload([firing('Nightly sync')], { format: 'raw' });
  assert.equal(p.alerts.length, 1);
  assert.equal(p.alerts[0].workflowName, 'Nightly sync');
  assert.equal(p.alerts[0].rule, 'failing');
  assert.ok(typeof p.text === 'string', 'still carries a human summary');
});

test('firing and resolved are visually distinguishable at a glance', () => {
  const p = buildPushPayload([firing('A'), resolved('B')], { format: 'slack' });
  const [l1, l2] = p.text.split('\n').filter((l) => /A |B /.test(l));
  assert.notEqual(l1.slice(0, 2), l2.slice(0, 2), 'the two kinds share a leading marker');
});

test('the message body is included, not just the title', () => {
  const p = buildPushPayload([firing('A', '4 of the last 6 executions errored.')], { format: 'slack' });
  assert.match(p.text, /4 of the last 6 executions errored/);
});

test('a long burst is truncated with a count rather than sent in full', () => {
  const many = Array.from({ length: 25 }, (_, i) => firing(`WF ${i}`));
  const p = buildPushPayload(many, { format: 'slack', maxLines: 10 });
  assert.ok(p.text.split('\n').length <= 12, 'kept short');
  assert.match(p.text, /15 more/);
});

test('a burst inside the limit says nothing about extras', () => {
  const p = buildPushPayload([firing('A'), firing('B')], { format: 'slack', maxLines: 10 });
  assert.doesNotMatch(p.text, /more/);
});

test('an unknown format is rejected rather than silently posting the wrong shape', () => {
  assert.throws(() => buildPushPayload([firing('A')], { format: 'carrier-pigeon' }), /format/i);
});

test('every advertised format produces a payload', () => {
  for (const format of FORMATS) {
    const p = buildPushPayload([firing('A')], { format, chatId: '1' });
    assert.ok(p && typeof p === 'object', `${format} produced nothing`);
  }
});

// ---- redactUrl --------------------------------------------------------------
// Webhook URLs ARE the credential — a Slack incoming webhook and a Telegram bot
// URL both carry their secret in the path. They must never reach a log line.
test('redactUrl keeps the host and drops the secret path', () => {
  assert.equal(redactUrl('https://hooks.slack.com/services/T00/B00/XXXXSECRET'), 'https://hooks.slack.com/…');
  assert.equal(redactUrl('https://api.telegram.org/bot12345:AAsecret/sendMessage'), 'https://api.telegram.org/…');
});

test('redactUrl never echoes an unparseable value back', () => {
  assert.equal(redactUrl('not a url'), '(unparseable url)');
  assert.equal(redactUrl(''), '(unset)');
});

// ---- pushAlerts -------------------------------------------------------------
const okRes = { ok: true, status: 204, text: async () => '' };

test('pushAlerts POSTs JSON to the configured url', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push({ url, opts }); return okRes; };
  const r = await pushAlerts(fetchFn, { url: 'https://hook.test/x', format: 'slack' }, [firing('A')]);
  assert.equal(r.sent, true);
  assert.equal(seen[0].url, 'https://hook.test/x');
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.headers['content-type'], 'application/json');
  assert.match(seen[0].opts.body, /A is failing/);
});

test('pushAlerts makes no request when there is nothing to say', async () => {
  let calls = 0;
  const r = await pushAlerts(async () => { calls++; return okRes; }, { url: 'https://hook.test/x', format: 'slack' }, []);
  assert.equal(calls, 0);
  assert.equal(r.sent, false);
});

test('pushAlerts makes no request when no url is configured', async () => {
  let calls = 0;
  const r = await pushAlerts(async () => { calls++; return okRes; }, { url: '', format: 'slack' }, [firing('A')]);
  assert.equal(calls, 0);
  assert.equal(r.sent, false);
});

test('a rejected webhook is reported, not thrown — the poll must survive it', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const r = await pushAlerts(fetchFn, { url: 'https://hook.test/x', format: 'slack' }, [firing('A')]);
  assert.equal(r.sent, false);
  assert.match(r.error, /403/);
});

test('a network failure is reported, not thrown', async () => {
  const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
  const r = await pushAlerts(fetchFn, { url: 'https://hook.test/x', format: 'slack' }, [firing('A')]);
  assert.equal(r.sent, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('the error never contains the webhook url, which is itself a secret', async () => {
  const secret = 'https://hooks.slack.com/services/T00/B00/SUPERSECRET';
  const fetchFn = async () => { throw new Error(`connect failed to ${secret}`); };
  const r = await pushAlerts(fetchFn, { url: secret, format: 'slack' }, [firing('A')]);
  assert.doesNotMatch(r.error, /SUPERSECRET/);
});

test('the request carries an abort signal so a hung webhook cannot stall the poller', async () => {
  let signal;
  const fetchFn = async (_u, opts) => { signal = opts.signal; return okRes; };
  await pushAlerts(fetchFn, { url: 'https://hook.test/x', format: 'slack', timeoutMs: 50 }, [firing('A')]);
  assert.ok(signal, 'no signal passed');
  assert.equal(typeof signal.aborted, 'boolean');
});

// ---- pingHeartbeat ----------------------------------------------------------
// The watchdog and the unreachable alert both run inside the collector, so
// neither survives the host dying — a dead process cannot send a message. Only
// an outbound ping on every healthy poll lets something OUTSIDE the box notice
// the silence.
test('pingHeartbeat GETs the configured url', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push({ url, opts }); return okRes; };
  const r = await pingHeartbeat(fetchFn, { url: 'https://hc.test/uuid' });
  assert.equal(r.sent, true);
  assert.equal(seen[0].url, 'https://hc.test/uuid');
  assert.equal(seen[0].opts.method, 'GET');
});

test('pingHeartbeat makes no request when no url is configured', async () => {
  let calls = 0;
  const r = await pingHeartbeat(async () => { calls++; return okRes; }, { url: '' });
  assert.equal(calls, 0);
  assert.equal(r.sent, false);
});

test('a failed heartbeat is reported, not thrown — it must not fail the poll', async () => {
  const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
  const r = await pingHeartbeat(fetchFn, { url: 'https://hc.test/uuid' });
  assert.equal(r.sent, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('a non-2xx heartbeat is reported with the url redacted', async () => {
  const fetchFn = async () => ({ ok: false, status: 404 });
  const r = await pingHeartbeat(fetchFn, { url: 'https://hc.test/SECRETUUID' });
  assert.equal(r.sent, false);
  assert.match(r.error, /404/);
  assert.doesNotMatch(r.error, /SECRETUUID/);
});

test('the heartbeat url is a credential too and never appears in an error', async () => {
  // Healthchecks.io and Uptime Kuma both put the monitor id in the path;
  // anyone holding it can forge a healthy ping and mute the dead-man switch.
  const secret = 'https://hc-ping.com/2f7d1b0e-SECRET';
  const fetchFn = async () => { throw new Error(`connect failed to ${secret}`); };
  const r = await pingHeartbeat(fetchFn, { url: secret });
  assert.doesNotMatch(r.error, /SECRET/);
});

test('the heartbeat carries an abort signal so a hung endpoint cannot stall the poller', async () => {
  let signal;
  const fetchFn = async (_u, opts) => { signal = opts.signal; return okRes; };
  await pingHeartbeat(fetchFn, { url: 'https://hc.test/uuid', timeoutMs: 50 });
  assert.ok(signal, 'no signal passed');
});

// ---- deep links -------------------------------------------------------------
// The whole point of a chat alert is to be one click from the thing that broke.
const N8N = 'https://n8n.example.com';
const stuck = { rule: 'stuck', workflowId: 'wf-9', executionId: 'ex-42', workflowName: 'ETL', severity: 'failure', title: 'ETL has a stuck execution', message: '1 running.', since: null, kind: 'firing' };
const unreachable = { rule: 'unreachable', workflowId: '', workflowName: 'n8n', severity: 'failure', title: 'Cannot reach n8n', message: 'no route.', since: null, kind: 'firing' };

test('alertLink points a workflow alert at the n8n workflow', () => {
  assert.equal(alertLink(firing('A'), N8N), `${N8N}/workflow/wf-1`);
});

test('alertLink points a stuck alert at the specific execution, not just the workflow', () => {
  assert.equal(alertLink(stuck, N8N), `${N8N}/workflow/wf-9/executions/ex-42`);
});

test('alertLink returns null when there is no base url or no workflow', () => {
  assert.equal(alertLink(firing('A'), ''), null);
  assert.equal(alertLink(unreachable, N8N), null);
});

test('slack wraps the link in mrkdwn so the line stays readable', () => {
  const body = buildPushPayload([firing('Alpha')], { format: 'slack', baseUrl: N8N });
  assert.match(body.text, /<https:\/\/n8n\.example\.com\/workflow\/wf-1\|open>/);
});

test('discord and telegram get a bare url, which both autolink', () => {
  for (const format of ['discord', 'telegram']) {
    const body = buildPushPayload([firing('Alpha')], { format, baseUrl: N8N, chatId: 'c' });
    const text = body.text || body.content;
    assert.ok(text.includes(`${N8N}/workflow/wf-1`), `${format} carries the url`);
    assert.ok(!text.includes('<https'), `${format} must not use slack mrkdwn link syntax`);
  }
});

test('raw carries the link as a field, so a consumer can branch on it', () => {
  const body = buildPushPayload([firing('Alpha')], { format: 'raw', baseUrl: N8N });
  assert.equal(body.alerts[0].link, `${N8N}/workflow/wf-1`);
});

test('no base url means no link rather than a half-formed one', () => {
  const body = buildPushPayload([firing('Alpha')], { format: 'slack' });
  assert.ok(!body.text.includes('http'), 'nothing that looks like a link');
});

test('the unreachable alert gets no link — a /workflow/ href would 404', () => {
  const body = buildPushPayload([unreachable], { format: 'slack', baseUrl: N8N });
  assert.ok(!body.text.includes('http'));
});

// ---- per-format header ------------------------------------------------------
// `*text*` is bold in Slack mrkdwn, ITALIC in Discord, and literal asterisks in
// Telegram (which we send without parse_mode). One string cannot serve all three.
test('slack gets mrkdwn bold', () => {
  const p = buildPushPayload([firing('A')], { format: 'slack' });
  assert.equal(p.text.split('\n')[0], '*Po11y*');
});

test('discord gets double-asterisk bold, not slack single', () => {
  const p = buildPushPayload([firing('A')], { format: 'discord' });
  assert.equal(p.content.split('\n')[0], '**Po11y**');
});

test('telegram gets a plain header — no parse_mode means markup renders literally', () => {
  const p = buildPushPayload([firing('A')], { format: 'telegram', chatId: '1' });
  assert.equal(p.text.split('\n')[0], 'Po11y');
});

test('raw gets a plain header, since the consumer decides its own rendering', () => {
  const p = buildPushPayload([firing('A')], { format: 'raw' });
  assert.equal(p.text.split('\n')[0], 'Po11y');
});

test('telegram still sends no parse_mode, so a workflow named a_b cannot 400 the message', () => {
  const p = buildPushPayload([firing('sync_daily_v2')], { format: 'telegram', chatId: '1' });
  assert.equal(p.parse_mode, undefined);
  assert.match(p.text, /sync_daily_v2/);
});

test('targetsHost: same host:port as n8n is caught, other ports and hosts are not', () => {
  const n8n = 'http://n8n.internal:5678';
  assert.equal(targetsHost('http://n8n.internal:5678/webhook/x', n8n), true);
  // Same machine, different port — a local Uptime Kuma next to n8n is legal.
  assert.equal(targetsHost('http://n8n.internal:3001/api/push/x', n8n), false);
  assert.equal(targetsHost('https://hooks.slack.com/services/x', n8n), false);
  // Scheme does not matter; the claim is about where bytes go.
  assert.equal(targetsHost('https://n8n.internal:5678/x', n8n), true);
});

test('targetsHost: unparseable URLs are false — the fetch must be what fails loudly', () => {
  assert.equal(targetsHost('not a url', 'http://n8n:5678'), false);
  assert.equal(targetsHost('http://ok:1', 'not a url'), false);
  assert.equal(targetsHost('', 'http://n8n:5678'), false);
});

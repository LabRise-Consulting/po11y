import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, PROTOCOL_VERSION } from './protocol.mjs';

const tools = [{
  name: 'po11y_echo', title: 'Echo', description: 'echoes',
  inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
  handler: async (args) => ({ echoed: args.v }),
}];
const resources = [{
  uri: 'po11y://feeds/status.json', name: 'status.json',
  description: 'status feed', mimeType: 'application/json',
  read: async () => '{"ok":true}',
}];
const dispatch = createDispatcher({ tools, resources, serverInfo: { name: 'po11y', version: '0' } });

test('initialize returns the protocol version and capabilities', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(out.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(Object.keys(out.result.capabilities).sort(), ['resources', 'tools']);
});

test('notifications/initialized produces no response', async () => {
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('any method without an id is a notification: no response body', async () => {
  for (const method of ['initialize', 'ping', 'tools/list', 'resources/list', 'nonsense']) {
    assert.equal(await dispatch({ jsonrpc: '2.0', method }), null, method);
  }
});

test('a tools/call notification does not run the handler', async () => {
  let calls = 0;
  const d = createDispatcher({ serverInfo: {}, resources: [], tools: [
    { name: 'count', inputSchema: {}, handler: async () => { calls += 1; return {}; } }] });
  assert.equal(await d({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'count' } }), null);
  assert.equal(calls, 0);
});

test('tools/list exposes every tool without its handler', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(out.result.tools.length, 1);
  assert.equal(out.result.tools[0].name, 'po11y_echo');
  assert.equal(out.result.tools[0].handler, undefined);
});

test('tools/call runs the handler and returns text content', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'po11y_echo', arguments: { v: 'hi' } } });
  assert.equal(JSON.parse(out.result.content[0].text).echoed, 'hi');
});

test('tools/call on an unknown tool is an invalid-params error', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(out.error.code, -32602);
});

test('a throwing handler becomes an internal error, not a crash', async () => {
  const d = createDispatcher({ serverInfo: {}, resources: [], tools: [
    { name: 'boom', inputSchema: {}, handler: async () => { throw new Error('kaboom'); } }] });
  const out = await d({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(out.error.code, -32603);
  assert.match(out.error.message, /kaboom/);
});

test('resources/read returns the resource text', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 6, method: 'resources/read',
    params: { uri: 'po11y://feeds/status.json' } });
  assert.equal(out.result.contents[0].text, '{"ok":true}');
});

test('resources/read on an unknown resource is an invalid-params error', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 7, method: 'resources/read',
    params: { uri: 'po11y://unknown' } });
  assert.equal(out.error.code, -32602);
});

test('an unknown method is a method-not-found error', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/frobnicate' });
  assert.equal(out.error.code, -32601);
});

test('a malformed message is an invalid-request error', async () => {
  const out = await dispatch({ id: 9, method: 'initialize' });
  assert.equal(out.error.code, -32600);
});

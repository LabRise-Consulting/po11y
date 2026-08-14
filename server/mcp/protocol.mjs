// MCP protocol dispatcher — JSON-RPC 2.0 over a single request/response pair.
//
// Hand-rolled on purpose: @modelcontextprotocol/sdk pulls 17 direct
// dependencies (two HTTP frameworks and OAuth machinery this server does not
// use — auth is nginx's job), which is a large supply-chain surface for a
// container whose neighbours hold n8n API keys and a Docker socket. The server
// side of a read-only MCP server is small enough to own outright.
//
// This module is transport-free: it maps a parsed JSON-RPC message to a
// response object (or null for a notification). node:http lives in index.mjs.

/** MCP revision implemented here. Batching was removed in this revision. */
export const PROTOCOL_VERSION = '2025-06-18';

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Strip handlers/readers so only the advertised surface goes over the wire. */
const publicTool = ({ name, title, description, inputSchema }) =>
  ({ name, title, description, inputSchema });
const publicResource = ({ uri, name, description, mimeType }) =>
  ({ uri, name, description, mimeType });

/**
 * Build the request handler.
 *
 * @param {{tools: object[], resources: object[], serverInfo: object}} deps
 * @returns {(msg: any) => Promise<object|null>} null = notification, no body
 */
export function createDispatcher({ tools = [], resources = [], serverInfo = {} } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const byUri = new Map(resources.map((r) => [r.uri, r]));

  return async function dispatch(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return failure(msg && msg.id !== undefined ? msg.id : null, -32600, 'invalid request');
    }
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case 'initialize':
          return result(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {} },
            serverInfo,
          });

        // Client lifecycle notifications: acknowledged by silence.
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return result(id, {});

        case 'tools/list':
          return result(id, { tools: tools.map(publicTool) });

        case 'tools/call': {
          const tool = byName.get(params.name);
          if (!tool) return failure(id, -32602, `unknown tool: ${params.name}`);
          const out = await tool.handler(params.arguments || {});
          // Text content only: structuredContent is validated by clients
          // against an outputSchema this server deliberately does not declare.
          return result(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        }

        case 'resources/list':
          return result(id, { resources: resources.map(publicResource) });

        case 'resources/read': {
          const res = byUri.get(params.uri);
          if (!res) return failure(id, -32602, `unknown resource: ${params.uri}`);
          return result(id, {
            contents: [{ uri: res.uri, mimeType: res.mimeType, text: await res.read() }],
          });
        }

        default:
          return isNotification ? null : failure(id, -32601, `unknown method: ${method}`);
      }
    } catch (e) {
      // Handlers redact their own messages (see mcp/sources.mjs); this is the
      // last net, so it forwards the message rather than the whole error.
      return failure(id === undefined ? null : id, -32603, String((e && e.message) || e));
    }
  };
}

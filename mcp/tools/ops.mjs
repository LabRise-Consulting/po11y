// Operations tools. Po11y is a monitoring tool first, so this is the headline
// group: what is broken, why, and how it connects.
//
// Every tool here is read-only and payload-free (see the module note in
// mcp/index.mjs). Tools that need a source they do not have return
// unavailable() — never an empty result.

import { unavailable, assertSelect } from '../sources.mjs';

/** Failures first, then newest — an agent reads the top of the list. */
const RANK = { failure: 0, info: 1, success: 2 };
const bySeverityThenTime = (a, b) =>
  (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1) || String(b.ts).localeCompare(String(a.ts));

/**
 * Open problems, ranked. Reads the watchdog's own verdicts out of
 * notifications.json rather than recomputing them, so the MCP and the dashboard
 * never disagree about what is wrong.
 */
export function incidentsTool({ feeds }) {
  return {
    name: 'po11y_incidents',
    title: 'Open incidents',
    description: 'Ranked open problems from the watchdog: failing, stale, stuck and unreachable '
      + 'workflows, newest and most severe first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries to return (default 20).' },
      },
    },
    async handler({ limit = 20 } = {}) {
      if (!feeds.available()) return unavailable('po11y_incidents', 'STATUS_DIR');
      // null means nothing has written the feed; [] means a writer ran and found
      // nothing. Collapsing them would answer "no open failures" when we
      // actually have no data.
      //
      // A missing feed is not necessarily a fault: nothing in workflows/core/
      // writes notifications.json, so a stock Mode A deploy legitimately has
      // none unless an example or a workflow of your own publishes one. Say so,
      // or an agent goes looking for a watchdog that was never running.
      const all = feeds.readSafe('notifications.json');
      if (!all) {
        return {
          error: 'notifications.json has not been written',
          reason: 'In Mode B the collector watchdog writes this feed (on by default; ALERTS_ENABLED=false disables it). '
            + 'In Mode A nothing in workflows/core/ does — the feed appears once a workflow '
            + 'of yours publishes it, as workflows/examples/hn-notify.json does.',
          open: 0,
          incidents: [],
        };
      }
      // Array.isArray, not just the truthiness guard above: a Code node of your
      // own can publish an object ({notifications: […]}) where the watchdog
      // writes a bare array, and [...all] on that throws a TypeError that
      // escapes as a bare -32603. Same defensiveness watchdog.mjs's
      // mergeNotifications already applies to the same file. (No in-tree
      // workflow writes the wrapper shape; this guards user-written ones.)
      if (!Array.isArray(all)) {
        return {
          error: 'notifications.json is not a feed array; po11y writes a top-level array of alerts',
          open: 0,
          incidents: [],
        };
      }
      const sorted = [...all].sort(bySeverityThenTime);
      // Count failures in the full feed, not the limit-capped page an agent sees:
      // the headline number must not shrink just because the list view is capped.
      const open = sorted.filter((n) => n.status === 'failure').length;
      const incidents = sorted.slice(0, limit);
      return {
        open,
        summary: open
          ? `${open} open failure${open === 1 ? '' : 's'} in the newest ${incidents.length} entries.`
          : 'No open failures in the notification feed.',
        feed_age_seconds: feeds.ageSeconds('notifications.json'),
        incidents,
      };
    },
  };
}

/**
 * Collect neighbours of `start` out to `depth` hops, following edges both ways.
 *
 * ai-map.json spells an edge as the array `[from, to, kind]` — see
 * lib/build-ai-map.mjs, which serialises exactly that, and site/ai-map.html,
 * which reads e[0]/e[1]. Anything else in `edges` is from a publisher we do not
 * know and is skipped rather than guessed at.
 */
function slice(graph, startId, depth) {
  const edges = (graph.edges || []).filter((e) => Array.isArray(e) && e.length >= 2);
  const keep = new Set([startId]);
  let frontier = [startId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const [from, to] of edges) {
      if (frontier.includes(from) && !keep.has(to)) { keep.add(to); next.push(to); }
      if (frontier.includes(to) && !keep.has(from)) { keep.add(from); next.push(from); }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: (graph.nodes || []).filter((n) => keep.has(n.id)),
    edges: edges.filter(([from, to]) => keep.has(from) && keep.has(to)),
  };
}

/**
 * The dependency graph. ai-map.json is the structured feed (nodes + edges);
 * map.json is mermaid text and is deliberately not parsed here.
 */
export function graphTool({ feeds }) {
  return {
    name: 'po11y_graph',
    title: 'Workflow dependency graph',
    description: 'How workflows, triggers, published feeds and external services connect. '
      + 'Omit `node` for an instance-wide summary, or name a workflow for a local slice.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Workflow name or node id (e.g. "wf:42").' },
        depth: { type: 'number', description: 'Hops around `node` (default 1).' },
      },
    },
    async handler({ node = '', depth = 1 } = {}) {
      if (!feeds.available()) return unavailable('po11y_graph', 'STATUS_DIR');
      const graph = feeds.readSafe('ai-map.json');
      if (!graph) return { error: 'ai-map.json has not been written yet', nodes: 0, edges: 0 };

      if (!node) {
        return {
          nodes: (graph.nodes || []).length,
          edges: (graph.edges || []).length,
          feed_age_seconds: feeds.ageSeconds('ai-map.json'),
          entries: (graph.nodes || []).filter((n) => n.kind === 'entry')
            .map((n) => ({ id: n.id, name: n.name, sub: n.sub })),
        };
      }

      const needle = String(node).toLowerCase();
      const hit = (graph.nodes || []).find((n) =>
        n.id === node || String(n.name || '').toLowerCase() === needle);
      if (!hit) {
        return {
          error: `node not found: ${node}`,
          known: (graph.nodes || []).map((n) => n.name).filter(Boolean).slice(0, 50),
        };
      }
      return {
        node: { id: hit.id, name: hit.name, sub: hit.sub, kind: hit.kind },
        depth,
        feed_age_seconds: feeds.ageSeconds('ai-map.json'),
        slice: slice(graph, hit.id, depth),
      };
    },
  };
}

/**
 * Describe a value's structure without revealing any of it.
 *
 * This is the mechanism behind the payload rule: n8n execution data holds
 * whatever the workflows touched — API responses, customer records, message
 * bodies — and none of it belongs in a model's context by default. The
 * operator reads the real payload in n8n, via the link every tool returns.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeShape(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (Array.isArray(value)) return `array, ${value.length} items`;
  if (typeof value === 'object') return `object, ${Object.keys(value).length} keys`;
  if (typeof value === 'string') return `string, ${value.length} chars`;
  return typeof value;
}

const seconds = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null);

/**
 * Sanitise a caller-supplied limit: non-finite (NaN, missing, a stray string)
 * falls back to `def`; anything else is clamped into [1, max]. Without this a
 * bad `limit` reaches a query string as "NaN" or passes a negative value
 * straight through to the source.
 *
 * Exported for the content tools, which clamp the same caller-supplied budgets.
 *
 * @param {unknown} value
 * @param {number} def
 * @param {number} max
 * @returns {number}
 */
export const clampLimit = (value, def, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : def;
};

/** One compact row per execution. Field list is closed: no payload can slip in. */
const execRow = (e) => ({
  id: e.id,
  // executions fetched without includeData=true omit workflowData, so
  // workflowName (present on list rows) is the primary source; workflowId is
  // the last resort so the row is never silently unnamed. Same idea as the
  // chains in collector/collect.mjs (fetchStatus) and collector/watchdog.mjs
  // (summarizeExecutions), but deliberately SHORTER: those two consult a
  // workflow-list name map the caller already fetched; this tool has no such
  // map and accepts the id as a name rather than paying a second round-trip.
  workflow: e.workflowName || (e.workflowData && e.workflowData.name) || e.workflowId || null,
  workflow_id: e.workflowId,
  status: e.status,
  // startedAt is NULL until an execution actually starts, so a queued run has
  // only createdAt (same reason the Mode A alert rules guard on IS NOT NULL —
  // observability/grafana/alerting/rules.yml:271).
  started_at: e.startedAt || e.createdAt,
  duration_seconds: seconds(e.startedAt, e.stoppedAt),
});

/** Recent executions as a compact table. */
export function executionsTool({ n8n }) {
  return {
    name: 'po11y_executions',
    title: 'Recent executions',
    description: 'Recent workflow runs, filterable by workflow and status. Returns timings and '
      + 'statuses only — never the data that flowed through the run.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Restrict to one workflow id.' },
        status: { type: 'string', enum: ['success', 'error', 'waiting'], description: 'Restrict to one status.' },
        limit: { type: 'number', description: 'Max rows (default 20, n8n caps at 250).' },
      },
    },
    async handler({ workflowId = '', status = '', limit = 20 } = {}) {
      if (!n8n.available()) return unavailable('po11y_executions', 'N8N_API_URL + N8N_API_KEY');
      const q = new URLSearchParams({ limit: String(clampLimit(limit, 20, 250)) });
      if (workflowId) q.set('workflowId', workflowId);
      if (status) q.set('status', status);
      const body = await n8n.get(`/api/v1/executions?${q}`);
      const executions = (body.data || []).map(execRow);
      return {
        count: executions.length,
        summary: executions.length
          ? `${executions.filter((e) => e.status === 'error').length} of ${executions.length} recent runs failed.`
          : 'No executions matched.',
        executions,
      };
    },
  };
}

const MAX_ERROR_MESSAGE = 2000;

/**
 * n8n's NodeApiError.message routinely embeds the failed HTTP response body
 * verbatim, which can run to many kilobytes. Capping it is not the payload
 * rule (an error message is explicitly allowed through) — it is bounding an
 * otherwise-unbounded string before it reaches a model's context.
 */
const capMessage = (msg) => {
  if (typeof msg !== 'string') return msg || null;
  return msg.length > MAX_ERROR_MESSAGE ? `${msg.slice(0, MAX_ERROR_MESSAGE)}… [truncated]` : msg;
};

/** Why one execution failed: node, message, timing. Never the payload. */
export function failureTool({ n8n, grafana }) {
  return {
    name: 'po11y_failure',
    title: 'Explain a failed execution',
    description: 'The failing node, its error message and timing for one execution. Payload data '
      + 'is deliberately not returned — only its shape, plus a link to read it in n8n.',
    inputSchema: {
      type: 'object',
      required: ['executionId'],
      properties: { executionId: { type: ['string', 'number'], description: 'n8n execution id.' } },
    },
    async handler({ executionId } = {}) {
      if (!n8n.available()) {
        return grafana.available()
          ? unavailable('po11y_failure', 'N8N_API_URL + N8N_API_KEY (per-execution detail needs the API)')
          : unavailable('po11y_failure', 'N8N_API_URL + N8N_API_KEY');
      }
      const e = await n8n.get(`/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`);
      const rd = ((e.data || {}).resultData) || {};
      const err = rd.error || {};
      const node = (err.node && err.node.name) || rd.lastNodeExecuted || null;

      // Shapes only — walk the run data for the failing node and describe it.
      const runs = (rd.runData || {})[node] || [];
      const firstOut = (((runs[0] || {}).data || {}).main || [])[0] || [];
      const shapes = {
        items: describeShape(firstOut),
        first_item: describeShape((firstOut[0] || {}).json),
      };

      return {
        id: e.id,
        workflow: (e.workflowData && e.workflowData.name) || null,
        workflow_id: e.workflowId,
        status: e.status,
        failing_node: node,
        node_type: (err.node && err.node.type) || null,
        error: { name: err.name || null, message: capMessage(err.message), http_code: err.httpCode || null },
        started_at: e.startedAt || e.createdAt,
        duration_seconds: seconds(e.startedAt, e.stoppedAt),
        payload_shapes: shapes,
        payload_note: 'Payload data is not returned by design; open the link to inspect it in n8n.',
        link: `${n8n.baseUrl}/executions/${e.id}`,
      };
    },
  };
}

/** One workflow's health card: definition, neighbours, recent run record. */
export function workflowTool({ feeds, n8n }) {
  return {
    name: 'po11y_workflow',
    title: 'Workflow health',
    description: 'Health card for one workflow: active state, recent success/error counts, and its '
      + 'upstream and downstream neighbours from the architecture map.',
    inputSchema: {
      type: 'object',
      required: ['workflow'],
      properties: { workflow: { type: 'string', description: 'Workflow name or id.' } },
    },
    async handler({ workflow } = {}) {
      if (!n8n.available()) return unavailable('po11y_workflow', 'N8N_API_URL + N8N_API_KEY');
      const needle = String(workflow).toLowerCase();
      const list = await n8n.get('/api/v1/workflows?limit=250&excludePinnedData=true');
      const wf = (list.data || []).find((w) =>
        String(w.id) === String(workflow) || String(w.name).toLowerCase() === needle);
      if (!wf) {
        return {
          error: `workflow not found: ${workflow}`,
          known: (list.data || []).map((w) => w.name).slice(0, 50),
        };
      }

      const runs = await n8n.get(`/api/v1/executions?limit=50&workflowId=${encodeURIComponent(wf.id)}`);
      const executions = (runs.data || []).map(execRow);
      const errors = executions.filter((e) => e.status === 'error').length;

      // Mirror graphTool's distinction (feeds volume missing vs. present-but-
      // empty file) so a workflow with genuinely no graph neighbours is never
      // confused with "the map was never written" — an empty {nodes:[],
      // edges:[]} here would silently read as the former.
      let neighbours;
      if (!feeds.available()) {
        neighbours = unavailable('po11y_workflow', 'STATUS_DIR (for graph neighbours)');
      } else {
        const graph = feeds.readSafe('ai-map.json');
        neighbours = graph
          ? slice(graph, `wf:${wf.id}`, 1)
          : { error: 'ai-map.json has not been written yet', nodes: [], edges: [] };
      }

      return {
        workflow: { id: wf.id, name: wf.name, active: wf.active },
        recent: {
          total: executions.length,
          errors,
          error_rate: executions.length ? Number((errors / executions.length).toFixed(2)) : 0,
          last: executions[0] || null,
        },
        neighbours,
        link: `${n8n.baseUrl}/workflow/${wf.id}`,
      };
    },
  };
}

/** Raw PromQL escape hatch. */
export function promqlTool({ prometheus }) {
  return {
    name: 'po11y_promql',
    title: 'Prometheus query',
    description: 'Run a PromQL query against the stack Prometheus. Use for trends the curated '
      + 'tools do not cover ("has this been getting worse").',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'PromQL expression.' },
        start: { type: 'string', description: 'Range start (RFC3339 or unix). Omit for an instant query.' },
        end: { type: 'string', description: 'Range end.' },
        step: { type: 'string', description: 'Range step, e.g. "60s".' },
      },
    },
    async handler({ query, start = '', end = '', step = '60s' } = {}) {
      if (!prometheus.available()) return unavailable('po11y_promql', 'PROMETHEUS_URL');
      const data = start && end
        ? await prometheus.queryRange(query, start, end, step)
        : await prometheus.query(query);
      return { query, data };
    },
  };
}

/** Read-only SQL escape hatch, Mode A only. */
export function sqlTool({ grafana }) {
  return {
    name: 'po11y_sql',
    title: 'Query the n8n database (read-only)',
    description: 'Run one SELECT against n8n\'s database through Grafana\'s datasource proxy, as '
      + 'a read-only role: credentials_entity and execution_data are denied. Mode A only. Note '
      + 'execution_entity."startedAt" is NULL until a run starts — filter on "createdAt" when '
      + 'enqueue time is what you mean.',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'A single SELECT statement.' },
        from: { type: 'string', description: 'Grafana range start (default "now-7d").' },
        to: { type: 'string', description: 'Grafana range end (default "now").' },
        limit: { type: 'number', description: 'Max rows to return (default 500).' },
      },
    },
    async handler({ sql, from = 'now-7d', to = 'now', limit = 500 } = {}) {
      if (!grafana.available()) return unavailable('po11y_sql', 'GRAFANA_URL (Mode A only)');
      try {
        // Validated here, not just inside the grafana adapter: the adapter's
        // own guard runs right before it issues the HTTP request, but calling
        // assertSelect first — and only then awaiting grafana.query — is what
        // guarantees a rejected statement never reaches the network, even if
        // a future adapter implementation forgot its own check.
        assertSelect(sql);
        const { columns, rows, truncated } = await grafana.query(sql, { from, to });
        // Deliberately no table allowlist or column denylist here: a caller
        // who names execution_data and gets payloads back is an accepted,
        // documented trade-off of this escape hatch, not something to police
        // in code. What IS this tool's job: never hand back an unbounded
        // result, and always say so when the result was cut — either by the
        // adapter's own frame limit or by the cap applied here.
        const cap = clampLimit(limit, 500, 5000);
        const cappedRows = rows.length > cap;
        return {
          columns,
          row_count: Math.min(rows.length, cap),
          rows: rows.slice(0, cap),
          truncated: Boolean(truncated) || cappedRows,
        };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  };
}

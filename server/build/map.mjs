// Build a mermaid graph of every workflow on this instance and how they
// link: trigger entry points (schedule/form/webhook), Execute Workflow
// references, plus best-effort webhook/form-call edges (an HTTP Request
// whose URL contains another workflow's webhook or form path).
//
// The caller owns I/O (reading the workflow list, writing map.json) and the
// generated_at timestamp.

/**
 * @typedef {Object} N8nNode
 * @property {string} [name]
 * @property {string} [type]
 * @property {Object} [parameters]
 * @property {string} [webhookId]
 *
 * @typedef {Object} N8nWorkflow
 * @property {string|number} id
 * @property {string} [name]
 * @property {boolean} [active]
 * @property {boolean} [isArchived]
 * @property {N8nNode[]} [nodes]
 */

// First // comment in any Code node's jsCode → 90-char description; the same
// heuristic build-ai-map.mjs uses for its node subs. Fallback: node count.
function firstComment(wf) {
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  for (const n of wf.nodes || []) {
    const c = String((n.parameters || {}).jsCode || '').split('\n').find((l) => l.startsWith('//'));
    if (c) return cut(c.replace(/^\/\/\s*/, ''), 90);
  }
  return `${(wf.nodes || []).length} nodes`;
}

/**
 * Build the mermaid workflow map.
 *
 * @param {N8nWorkflow[]} workflows - raw workflow list (archived entries are
 *   filtered out inside; the caller may feed raw n8n API results).
 * @returns {{ mermaid: string, workflows: number, edges: number,
 *   entries: Array<{nid: string, id: string|number, name: string, sub: string}> }}
 */
export function buildMap(workflows) {
  const wfs = workflows.filter((w) => !w.isArchived);
  const esc = (s) => String(s || '').replace(/["`]/g, "'");
  // Mermaid node ids allow only [A-Za-z0-9_], so anything else in an n8n id has
  // to be sanitised away — which is lossy: "a-b" and "a.b" both became "a_b",
  // mermaid merged the two workflows into one box, and the last entry silently
  // won the dialog. Ids that lose nothing (the normal n8n case) keep their
  // plain form so published maps do not churn; the rest carry a short digest of
  // the original, which is deterministic and collision-free between them.
  const digest = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  const nid = (id) => {
    const raw = String(id);
    const safe = raw.replace(/[^A-Za-z0-9]/g, '_');
    return 'wf_' + (safe === raw ? safe : `${safe}_${digest(raw)}`);
  };
  const lines = ['graph TD'];
  const edges = new Set();
  const entries = [];
  // hook paths per workflow: webhook + formTrigger nodes
  const hooks = [];
  for (const wf of wfs) {
    for (const n of wf.nodes || []) {
      const p = (n.parameters || {}).path;
      if (!p) continue;
      if (n.type === 'n8n-nodes-base.webhook') hooks.push({ path: `/webhook/${p}`, wf: wf.id });
      if (n.type === 'n8n-nodes-base.formTrigger') hooks.push({ path: `/form/${p}`, wf: wf.id });
    }
  }
  let t = 0;
  for (const wf of wfs) {
    entries.push({ nid: nid(wf.id), id: wf.id, name: wf.name, sub: firstComment(wf) });
    const label = esc(wf.name) + (wf.active ? '' : ' (inactive)');
    lines.push(`  ${nid(wf.id)}["${label}"]`);
    if (wf.active) lines.push(`  class ${nid(wf.id)} active`);
    for (const n of wf.nodes || []) {
      const prm = n.parameters || {};
      // trigger entry points as small round nodes
      let trig = '';
      if (n.type === 'n8n-nodes-base.scheduleTrigger') {
        // n8n names the count after the unit (minutesInterval, weeksInterval,
        // …), so derive it from `field` rather than listing the units twice —
        // a fixed four-field list rendered every weeks/months schedule as a
        // bare "schedule". build-ai-map.mjs carries the identical block.
        const iv = ((prm.rule || {}).interval || [])[0] || {};
        const num = iv[`${iv.field}Interval`];
        const unit = { seconds: 's', minutes: 'min', hours: 'h', days: 'd', weeks: 'w', months: 'mo' }[iv.field]
          || iv.field || '';
        trig = num ? `every ${num} ${unit}` : 'schedule';
      } else if (n.type === 'n8n-nodes-base.formTrigger') {
        trig = `form /${prm.path || '?'}`;
      } else if (n.type === 'n8n-nodes-base.webhook') {
        trig = `webhook /${prm.path || '?'}`;
      }
      if (trig) {
        const tid = `t${t++}`;
        lines.push(`  ${tid}(("${esc(trig)}"))`);
        lines.push(`  class ${tid} trigger`);
        edges.add(`  ${tid} --> ${nid(wf.id)}`);
      }
      // Execute Workflow: workflowId is a string (old) or {value} (resource locator)
      if (n.type === 'n8n-nodes-base.executeWorkflow') {
        const ref = typeof prm.workflowId === 'object' ? (prm.workflowId || {}).value : prm.workflowId;
        if (ref) edges.add(`  ${nid(wf.id)} -->|sub-workflow| ${nid(ref)}`);
      }
      // HTTP Request calling another workflow's webhook/form
      if (n.type === 'n8n-nodes-base.httpRequest' && typeof prm.url === 'string') {
        for (const h of hooks) {
          if (h.wf !== wf.id && prm.url.includes(h.path)) edges.add(`  ${nid(wf.id)} -.->|http| ${nid(h.wf)}`);
        }
      }
    }
  }
  lines.push(...edges);
  lines.push('  classDef active stroke-width:3px');
  lines.push('  classDef trigger stroke-dasharray:3 3,font-size:11px');
  return { mermaid: lines.join('\n'), workflows: wfs.length, edges: edges.size, entries };
}

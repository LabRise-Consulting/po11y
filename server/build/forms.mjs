// Publish the live form-trigger inventory for the dashboard's Actions
// group: every active workflow's formTrigger nodes as { name, sub, path }.
// The dashboard (app.js) merges /forms.json into its Actions cards, so a
// new form trigger becomes a button without touching config.json.
//
// Originally a pure extraction of the "Publish forms.json" Code node from
// Mode A's workflows/core/maps.json (deleted along with Mode A): same
// traversal order and fallbacks. The caller owns I/O (reading the workflow
// list, writing forms.json) and generated_at.

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

/**
 * Build the form-trigger inventory.
 *
 * @param {N8nWorkflow[]} workflows - raw workflow list (archived entries are
 *   filtered out inside; only active workflows contribute forms).
 * @returns {{ forms: {name: string, sub: string, path: string, fields: number}[] }}
 */
export function buildForms(workflows) {
  const wfs = workflows.filter((w) => !w.isArchived);
  const forms = [];
  for (const wf of wfs) {
    if (!wf.active) continue;
    for (const n of wf.nodes || []) {
      if (n.type !== 'n8n-nodes-base.formTrigger') continue;
      const p = n.parameters || {};
      const path = p.path || n.webhookId;
      if (!path) continue;
      forms.push({ name: p.formTitle || n.name, sub: p.formDescription || wf.name, path, fields: ((p.formFields || {}).values || []).length });
    }
  }
  return { forms };
}

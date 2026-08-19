// Deterministic architecture map. Structure (columns, nodes, edges) is
// computed from the live export — the same references the mermaid map uses —
// so the layout is identical run-to-run. An optional LLM (AI_MAP_*) only
// writes prose: per-node one-liners, the lede, insight cards. Without a key
// the map publishes with heuristic text. Annotation is differential: per-node content
// signatures (sigs) let unchanged nodes keep their previous prose, so the
// LLM only ever sees the workflows that actually changed.
//
// The caller owns all I/O and time: it supplies the previous map (`prev`), the
// "Build now" form state (`forced`), the wall clock (`now`), the AI config
// booleans (`aiConfigured`/`model`) and the LLM transport (`llm`), and it
// stamps `generated_at` + writes the file. An unusable LLM reply is reported
// as a `warnings` array on the returned summary, not logged.

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
 *
 * @typedef {Object} BuildAiMapOptions
 * @property {Object|null} [prev] - previously published ai-map.json object, or null
 * @property {boolean} [forced] - true when the "Build now" form fired
 * @property {number} now - ms epoch (caller supplies Date.now())
 * @property {boolean} aiConfigured - caller derived from its AI config
 * @property {string} [model] - model name for map.model when annotated
 * @property {((prompt: string) => Promise<string>)|null} [llm] - async raw-completion transport, or null
 *
 * @typedef {Object} BuildAiMapResult
 * @property {'skip-fresh'|'keep-annotated'|'republish'|'publish'} action
 * @property {Object} [map] - the map object to write (generated_at LEFT UNSET; caller stamps)
 * @property {Object} summary - the small object the node returns as its item json
 */

/**
 * Build the differential AI-annotated architecture map.
 *
 * @param {N8nWorkflow[]} workflows - raw workflow list (archived entries are
 *   filtered out inside).
 * @param {BuildAiMapOptions} opts
 * @returns {Promise<BuildAiMapResult>}
 */
export async function buildAiMap(workflows, {
  prev = null,
  forced = false,
  now,
  aiConfigured,
  model = '',
  llm = null,
} = {}) {
  const wfs = workflows.filter((w) => !w.isArchived);
  const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

  // ---- skeleton ----------------------------------------------------------------
  const TRIG = {
    'n8n-nodes-base.scheduleTrigger': 'schedule',
    'n8n-nodes-base.formTrigger': 'form',
    'n8n-nodes-base.webhook': 'webhook',
  };
  const wfCol = new Map(); // 1 = entry workflow, 2 = called sub-workflow
  for (const wf of wfs) {
    const hasOwnTrigger = (wf.nodes || []).some((n) => TRIG[n.type]);
    const isCalled = (wf.nodes || []).some((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
    wfCol.set(wf.id, !hasOwnTrigger && isCalled ? 2 : 1);
  }
  const nodes = [], edgeSet = new Set(), files = new Set(), externals = new Set();
  const edge = (a, b, k) => edgeSet.add(JSON.stringify([a, b, k]));
  const firstComment = (wf) => {
    for (const n of wf.nodes || []) {
      const c = String((n.parameters || {}).jsCode || '').split('\n').find((l) => l.startsWith('//'));
      if (c) return cut(c.replace(/^\/\/\s*/, ''), 90);
    }
    return `${(wf.nodes || []).length} nodes`;
  };
  for (const wf of wfs) {
    const col = wfCol.get(wf.id);
    nodes.push({ id: 'wf:' + wf.id, col, kind: col === 2 ? 'worker' : 'entry',
      tag: col === 2 ? 'sub-workflow' : 'workflow', name: wf.name, sub: firstComment(wf) });
    for (const n of wf.nodes || []) {
      const p = n.parameters || {};
      const kind = TRIG[n.type];
      if (kind) {
        let tag;
        if (kind === 'schedule') {
          // n8n names the count after the unit (minutesInterval, weeksInterval,
          // …), so derive it from `field` rather than listing the units twice —
          // a fixed four-field list rendered every weeks/months schedule as a
          // bare "schedule". build-map.mjs carries the identical block.
          const iv = ((p.rule || {}).interval || [])[0] || {};
          const num = iv[`${iv.field}Interval`];
          const unit = { seconds: 's', minutes: 'min', hours: 'h', days: 'd', weeks: 'w', months: 'mo' }[iv.field]
            || iv.field || '';
          tag = num ? `every ${num} ${unit}` : 'schedule';
        } else tag = `/${kind}/${p.path || n.webhookId || '?'}`;
        const id = `t:${wf.id}:${n.name}`;
        nodes.push({ id, col: 0, kind, tag, name: n.name, sub: `starts ${wf.name}` });
        edge(id, 'wf:' + wf.id, kind);
      }
      if (n.type === 'n8n-nodes-base.executeWorkflow') {
        const ref = typeof p.workflowId === 'object' ? (p.workflowId || {}).value : p.workflowId;
        if (ref && wfCol.has(ref)) edge('wf:' + wf.id, 'wf:' + ref, 'worker');
      }
      const code = String(p.jsCode || '');
      for (const m of code.matchAll(/\/po11y-status\/([A-Za-z0-9_-]+\.json)/g)) {
        files.add(m[1]);
        edge('wf:' + wf.id, 'f:' + m[1], 'file');
      }
      // regex host extraction — URL/globals can be absent in the Code sandbox
      const hay = code + ' ' + (typeof p.url === 'string' ? p.url : '');
      for (const m of hay.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
        const host = m[1];
        if (/localhost|127\.0\.0\.1/.test(host)) continue;
        externals.add(host);
        edge('wf:' + wf.id, 'x:' + host, 'external');
      }
    }
  }
  for (const f of files) nodes.push({ id: 'f:' + f, col: 3, kind: 'file', tag: 'feed', name: '/' + f, sub: 'dashboard feed' });
  for (const h of externals) nodes.push({ id: 'x:' + h, col: 3, kind: 'external', tag: 'external', name: h, sub: 'external service' });
  nodes.sort((a, b) => a.col - b.col
    || String(a.name || '').localeCompare(String(b.name || '')) || a.id.localeCompare(b.id));
  const edges = [...edgeSet].sort().map((e) => JSON.parse(e));

  const KIND_LABEL = { schedule: 'Schedule trigger', form: 'Form trigger', webhook: 'Webhook trigger',
    entry: 'Workflow', worker: 'Sub-workflow', file: 'Published feed', external: 'External service' };
  const map = {
    eyebrow: 'po11y · architecture',
    title: 'How the workflows link',
    lede: 'Triggers on the left start the workflows; edges follow real references (sub-workflow calls, published feeds, external services).',
    columns: ['Triggers', 'Workflows', 'Sub-workflows', 'Outputs'],
    kinds: { schedule: 'sky', form: 'amber', webhook: 'violet', entry: 'cyan', worker: 'emerald', file: 'sink', external: 'neutral' },
    nodes, edges,
    legend: Object.keys(KIND_LABEL).filter((k) => nodes.some((n) => n.kind === k)).map((k) => [KIND_LABEL[k], k]),
    notes: [],
  };

  // ---- change detection ----------------------------------------------------------
  // One digest entry per workflow (also the LLM's context). A node's signature
  // hashes the digest of the workflow it belongs to, so prose is re-generated
  // for exactly the nodes whose underlying workflow changed.
  const digestOf = (wf) => ({
    id: wf.id, name: wf.name, active: !!wf.active,
    nodes: (wf.nodes || []).map((nd) => {
      const p = nd.parameters || {};
      const o = { name: nd.name, type: String(nd.type || '').replace('n8n-nodes-base.', '') };
      if (p.rule) o.rule = p.rule;
      if (p.path) o.path = p.path;
      if (p.url) o.url = cut(p.url, 120);
      if (p.command) o.command = cut(p.command, 160);
      if (p.workflowId) o.calls = typeof p.workflowId === 'object' ? p.workflowId.value : p.workflowId;
      if (p.jsCode) o.code_comment = cut(String(p.jsCode).split('\n').filter((l) => l.startsWith('//')).join(' '), 300);
      return o;
    }),
  });
  const digest = wfs.map(digestOf);
  const digestJson = new Map(digest.map((d) => [d.id, JSON.stringify(d)]));
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const wfIdOf = (id) => id.startsWith('wf:') ? id.slice(3) : id.startsWith('t:') ? id.split(':')[1] : null;
  const sigs = {};
  for (const n of nodes) {
    const w = wfIdOf(n.id);
    sigs[n.id] = hash((w ? digestJson.get(w) || '' : '') + '|' + n.tag + '|' + n.name);
  }
  map.sigs = sigs;

  // ---- publish policy ------------------------------------------------------------
  // `prev`, `forced`, `now`, `aiConfigured` and `model` are supplied by the
  // caller; the original read them from fs / $() / Date.now() / an AICFG file.
  const warnings = [];
  const prevAnnotated = !!prev && !!prev.model && prev.model !== 'heuristic';
  // The early-exit branches, named so they read as the decision table they are.
  // Returns a finished BuildAiMapResult, or null for "fall through to a full
  // publish" (with or without LLM prose):
  //   skip-fresh      same structure, under 20 h old, not forced — nothing new
  //   keep-annotated  AI not configured now, but the published file carries LLM
  //                   prose for this same structure — do not downgrade it
  //   republish       content-identical — refresh the timestamp, no LLM tokens
  //   null            something changed, or the form forced it — build
  const publishPolicy = () => {
    const sameStructure = !!prev && Array.isArray(prev.nodes) && prev.nodes.length === nodes.length
      && nodes.every((n) => prev.nodes.some((o) => o.id === n.id));
    const sameContent = sameStructure && !!prev.sigs && nodes.every((n) => prev.sigs[n.id] === sigs[n.id]);
    const fresh = (prev ? now - new Date(prev.generated_at).getTime() : Infinity) < 20 * 3600 * 1000;
    if (sameStructure && fresh && !forced) return { action: 'skip-fresh', summary: { skipped: 'fresh' } };
    if (!aiConfigured && sameStructure && prevAnnotated && !forced) {
      return { action: 'keep-annotated', summary: { skipped: 'structure unchanged; keeping annotated map' } };
    }
    if (sameContent && !forced && (prevAnnotated || !aiConfigured)) {
      // generated_at is LEFT UNSET here; the caller stamps it and writes.
      delete prev.generated_at;
      return { action: 'republish', map: prev, summary: { republished: 'content unchanged — no LLM call' } };
    }
    return null;
  };
  const early = publishPolicy();
  if (early) return early;

  // ---- optional LLM annotation (prose only; structure stays fixed) ----------------
  if (aiConfigured) {
    // Differential: nodes whose signature is unchanged keep their previous
    // prose; only changed/new nodes (and their workflows' digest) go to the
    // LLM. A forced rebuild (the form) re-annotates everything.
    const prevSubs = new Map(((prev || {}).nodes || []).map((o) => [o.id, o.sub]));
    const prevSummaries = new Map(((prev || {}).nodes || []).map((o) => [o.id, o.summary]));
    let target = nodes;
    if (!forced && prevAnnotated && prev.sigs) {
      target = nodes.filter((n) => prev.sigs[n.id] !== sigs[n.id] || !prevSubs.get(n.id));
      for (const n of nodes) if (!target.includes(n)) {
        if (prevSubs.get(n.id)) n.sub = prevSubs.get(n.id);
        if (prevSummaries.get(n.id)) n.summary = prevSummaries.get(n.id);
      }
    }
    const partial = target.length < nodes.length;
    if (partial) {
      // Mostly the same stack — the previous lede/notes still describe it.
      if (typeof prev.lede === 'string' && prev.lede) map.lede = prev.lede;
      if (Array.isArray(prev.notes)) map.notes = prev.notes;
    }
    if (partial && !target.length) {
      // Node set shrank but every remaining node is unchanged — nothing to ask.
      map.model = prev.model;
    } else {
      const targetWfIds = new Set(target.map((n) => wfIdOf(n.id)).filter(Boolean));
      const sendDigest = partial ? digest.filter((d) => targetWfIds.has(d.id)) : digest;
      const skeleton = JSON.stringify(nodes.map(({ id, kind, tag, name }) => ({ id, kind, tag, name })));
      const prompt = partial
        ? `You annotate a fixed architecture map of an n8n automation stack. Only the listed node ids changed — you ONLY write text for those.\n\nReturn STRICT JSON (no markdown): {"subs": {"<node id>": "concrete one-line description, max 90 chars"}, "summaries": {"<workflow node id>": "2-3 sentence summary of what the workflow does"}}\n\nRules: cover exactly these node ids: ${JSON.stringify(target.map((n) => n.id))}; 'subs' must say what the thing concretely does (use the digest's code comments); 'summaries' only for ids starting "wf:" — richer than the one-line sub.\n\nAll map nodes (context):\n${skeleton}\n\nDigest of the changed workflows:\n${JSON.stringify(sendDigest)}`
        : `You annotate a fixed architecture map of an n8n automation stack. The structure is already decided — you ONLY write text.\n\nReturn STRICT JSON (no markdown): {"lede": "1-2 sentences describing the left-to-right flow", "subs": {"<node id>": "concrete one-line description, max 90 chars"}, "summaries": {"<workflow node id>": "2-3 sentence summary of what the workflow does"}, "notes": [{"title": "short", "text": "2-3 sentences of real operational insight"}]}\n\nRules: cover every node id; 'subs' must say what the thing concretely does (use the digest's code comments); 'summaries' only for ids starting "wf:" — richer than the one-line sub; notes max 3, skip generic filler.\n\nMap nodes:\n${skeleton}\n\nWorkflow digest:\n${JSON.stringify(sendDigest)}`;
      let text = (await llm(prompt)) || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try {
        const ann = JSON.parse(text);
        for (const n of target) {
          const s = (ann.subs || {})[n.id];
          if (typeof s === 'string' && s.trim()) n.sub = cut(s.trim(), 120);
          if (n.id.startsWith('wf:')) {
            const sm = (ann.summaries || {})[n.id];
            if (typeof sm === 'string' && sm.trim()) n.summary = cut(sm.trim(), 400);
          }
        }
        if (!partial) {
          if (typeof ann.lede === 'string' && ann.lede.trim()) map.lede = cut(ann.lede.trim(), 240);
          map.notes = (Array.isArray(ann.notes) ? ann.notes : []).slice(0, 3)
            .filter((x) => x && x.title && x.text)
            .map((x) => ({ title: cut(String(x.title), 60), text: cut(String(x.text), 400) }));
        }
        map.model = model;
      } catch (e) {
        warnings.push('ai-map: annotation unusable, keeping previous/heuristic text — ' + e.message);
        map.model = partial ? (prev.model || 'heuristic') : 'heuristic';
        // subs fall back to their heuristic seed; summaries have no seed, so
        // restore the previously published ones rather than dropping them.
        for (const n of target) {
          if (n.id.startsWith('wf:') && prevSummaries.get(n.id)) n.summary = prevSummaries.get(n.id);
        }
      }
    }
  } else {
    map.model = 'heuristic';
  }
  // generated_at is LEFT UNSET; the caller stamps it and writes the file.
  return { action: 'publish', map, summary: { published: true, model: map.model, nodes: nodes.length, edges: edges.length, warnings } };
}

// Pure, dependency-free layout maths for the Architecture tab. Imported by
// ai-map.html (browser) and ai-map.layout.test.mjs (node --test). No DOM here —
// same split as map.lib.js.
//
// Two layouts share one coordinate pass: `layoutColumns` reproduces the
// published column view, `layoutDag` computes a free layered DAG from the
// edges alone (Sugiyama-lite: longest-path layering, then barycenter crossing
// reduction). Both return { pos: {id: {x, y}}, width, height, heads } in
// content coordinates; the page applies pan/zoom on top.

export const SIZES = { NODE_W: 190, NODE_H: 86, VGAP: 44, XSTEP: 380, PAD: 60 };
const { NODE_W, NODE_H, VGAP, XSTEP, PAD } = SIZES;

const byName = (a, b) =>
  String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

/**
 * Sort a stack of nodes by an ordered chain of keys (primary first, the rest
 * break ties). Stats come from status.json's executions.byWorkflow, keyed by
 * node id; a node that never ran has no entry and ranks as zero. Name — the
 * workflow names carry `01 -` style prefixes, hence numeric compare — is
 * always the final tie-break so equal counts still land in a stable order.
 *
 * @param {Array<{id: string, name?: string}>} list
 * @param {string[]} chain - ordered subset of name|runs|errors|recent
 * @param {Object<string, {count?: number, errors?: number, lastAt?: string}>} [stats]
 * @returns {Array} a new array; an empty chain returns the input order
 */
export function sortStack(list, chain, stats = {}) {
  const stat = (n) => stats[n.id] || {};
  const CMP = {
    name: byName,
    runs: (a, b) => (stat(b).count || 0) - (stat(a).count || 0),
    errors: (a, b) => (stat(b).errors || 0) - (stat(a).errors || 0),
    recent: (a, b) => (Date.parse(stat(b).lastAt) || 0) - (Date.parse(stat(a).lastAt) || 0),
  };
  if (!chain.length) return list;
  return [...list].sort((a, b) => {
    for (const k of chain) {
      const d = (CMP[k] || (() => 0))(a, b);
      if (d) return d;
    }
    return chain.includes('name') ? 0 : byName(a, b);
  });
}

/**
 * Shared coordinate pass: an array of node stacks (columns or DAG layers)
 * becomes centred x/y per node — stack index on x, slot on y, each stack
 * vertically centred against the tallest.
 *
 * @param {Array<Array<{id: string}>>} stacks
 * @param {string[]|null} titles - column titles, or null for no heads (DAG)
 * @returns {{pos: Object, width: number, height: number, heads: Array}}
 */
export function stackColumns(stacks, titles) {
  const heights = stacks.map((l) => Math.max(NODE_H, l.length * NODE_H + (l.length - 1) * VGAP));
  const maxH = stacks.length ? Math.max(...heights) : 0;
  const pos = {};
  stacks.forEach((l, c) => {
    const top = PAD + (maxH - heights[c]) / 2;
    l.forEach((n, i) => {
      pos[n.id] = { x: PAD + NODE_W / 2 + c * XSTEP, y: top + i * (NODE_H + VGAP) + NODE_H / 2 };
    });
  });
  return {
    pos,
    width: PAD * 2 + (stacks.length ? NODE_W + (stacks.length - 1) * XSTEP : 0),
    height: PAD * 2 + maxH,
    heads: titles ? titles.map((t, c) => ({ text: t, x: PAD + NODE_W / 2 + c * XSTEP })) : [],
  };
}

/**
 * The published column view: nodes grouped by their `col` index under the
 * given titles (capped at six, matching the renderer's legend cap era).
 *
 * @param {Array<{id: string, col?: number}>} nodes
 * @param {string[]} columns
 * @param {string[]} chain - see sortStack
 * @param {Object} [stats] - see sortStack
 */
export function layoutColumns(nodes, columns, chain, stats = {}) {
  const COLS = columns.slice(0, 6);
  const byCol = COLS.map((_, c) => sortStack(nodes.filter((n) => n.col === c), chain, stats));
  return stackColumns(byCol, COLS);
}

/**
 * Free layered DAG from the edges alone, Sugiyama-lite:
 *   1. layer = longest path from the sources over forward edges. Edges are
 *      LLM-emitted, so cycles are guarded even though live data has none: a
 *      DFS marks back-edges and layering ignores them.
 *   2. crossing reduction: four fixed barycenter sweeps (down then up), ties
 *      keep the current slot — deterministic, no randomness.
 *   3. shared coordinate pass; the sort chain reorders inside each layer.
 * An isolated node (no forward edges either way) has no path evidence, so it
 * falls back to its `col` for a layer instead of piling onto layer 0.
 *
 * @param {Array<{id: string, col?: number}>} nodes
 * @param {Array<[string, string, string?]>} edges
 * @param {string[]} chain - see sortStack
 * @param {Object} [stats] - see sortStack
 */
export function layoutDag(nodes, edges, chain, stats = {}) {
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(ids.map((id) => [id, []]));
  edges.filter((e) => e[0] !== e[1]).forEach((e) => out.get(e[0]).push(e[1]));

  // DFS back-edge marking: an edge into a node still on the visit stack
  // (state 1) closes a cycle; everything else is forward.
  const state = new Map();
  const back = new Set();
  function dfs(u) {
    state.set(u, 1);
    for (const v of out.get(u)) {
      if (state.get(v) === 1) back.add(u + ' ' + v);
      else if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  }
  ids.forEach((id) => { if (!state.has(id)) dfs(id); });
  const F = edges.filter((e) => e[0] !== e[1] && !back.has(e[0] + ' ' + e[1]));

  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  F.forEach((e) => { succs.get(e[0]).push(e[1]); preds.get(e[1]).push(e[0]); });

  const layer = new Map();
  function layerOf(u, seen = new Set()) {
    if (layer.has(u)) return layer.get(u);
    if (seen.has(u)) return 0; // belt-and-braces; back-edges are already gone
    seen.add(u);
    const p = preds.get(u);
    let l;
    if (p.length) l = 1 + Math.max(...p.map((v) => layerOf(v, seen)));
    else if (!succs.get(u).length) {
      const n = byId.get(u);
      l = Number.isInteger(n.col) && n.col >= 0 ? n.col : 0;
    } else l = 0;
    layer.set(u, l);
    return l;
  }
  ids.forEach((id) => layerOf(id));

  const L = ids.length ? Math.max(...layer.values()) + 1 : 0;
  const layers = Array.from({ length: L }, () => []);
  ids.forEach((id) => layers[layer.get(id)].push(id));

  // Barycenter sweeps: order each layer by the mean slot of its neighbours in
  // the fixed layer — downward off preds, then upward off succs.
  const slot = new Map();
  const reslot = () => layers.forEach((l) => l.forEach((id, i) => slot.set(id, i)));
  reslot();
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const sweep = (c, neighbours) => {
    layers[c].sort((a, b) => {
      const ba = mean(neighbours.get(a).map((v) => slot.get(v))) ?? slot.get(a);
      const bb = mean(neighbours.get(b).map((v) => slot.get(v))) ?? slot.get(b);
      return ba - bb || slot.get(a) - slot.get(b);
    });
    reslot();
  };
  for (let it = 0; it < 4; it++) {
    for (let c = 1; c < L; c++) sweep(c, preds);
    for (let c = L - 2; c >= 0; c--) sweep(c, succs);
  }

  return stackColumns(layers.map((l) => sortStack(l.map((id) => byId.get(id)), chain, stats)), null);
}

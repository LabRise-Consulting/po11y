import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, sortStack, layoutColumns, layoutDag } from './ai-map.layout.js';

const { NODE_W, NODE_H, VGAP, XSTEP, PAD } = SIZES;

// Column/layer index -> the x every node in it shares.
const colX = (c) => PAD + NODE_W / 2 + c * XSTEP;
// Row index -> the y of the i-th node in the tallest stack.
const rowY = (i) => PAD + i * (NODE_H + VGAP) + NODE_H / 2;

const node = (id, extra = {}) => ({ id, name: id, ...extra });

// ---- sortStack --------------------------------------------------------------
test('sortStack orders names numerically, not lexically', () => {
  const list = [node('a', { name: '10 - late' }), node('b', { name: '2 - early' })];
  assert.deepEqual(sortStack(list, ['name']).map((n) => n.id), ['b', 'a']);
});

test('sortStack applies chain keys in order, later keys break ties', () => {
  const stats = {
    a: { count: 5, errors: 0 },
    b: { count: 5, errors: 3 },
    c: { count: 9, errors: 0 },
  };
  const list = [node('a'), node('b'), node('c')];
  assert.deepEqual(sortStack(list, ['runs', 'errors'], stats).map((n) => n.id), ['c', 'b', 'a']);
});

test('sortStack falls back to name as the final tie-break', () => {
  const stats = { a: { count: 1 }, b: { count: 1 } };
  const list = [node('b'), node('a')];
  assert.deepEqual(sortStack(list, ['runs'], stats).map((n) => n.id), ['a', 'b']);
});

test('sortStack ranks nodes without stats as zero', () => {
  const stats = { b: { count: 4 } };
  const list = [node('a'), node('b')];
  assert.deepEqual(sortStack(list, ['runs'], stats).map((n) => n.id), ['b', 'a']);
});

test('sortStack with an empty chain keeps the given order', () => {
  const list = [node('z'), node('a')];
  assert.deepEqual(sortStack(list, []).map((n) => n.id), ['z', 'a']);
});

test('sortStack sorts by recency from lastAt timestamps', () => {
  const stats = {
    a: { lastAt: '2026-08-01T00:00:00Z' },
    b: { lastAt: '2026-08-20T00:00:00Z' },
  };
  const list = [node('a'), node('b')];
  assert.deepEqual(sortStack(list, ['recent'], stats).map((n) => n.id), ['b', 'a']);
});

test('sortStack does not mutate its input', () => {
  const list = [node('b'), node('a')];
  sortStack(list, ['name']);
  assert.deepEqual(list.map((n) => n.id), ['b', 'a']);
});

// ---- layoutColumns ----------------------------------------------------------
test('layoutColumns places each column at its x step with titles as heads', () => {
  const nodes = [node('a', { col: 0 }), node('b', { col: 1 })];
  const r = layoutColumns(nodes, ['Left', 'Right'], []);
  assert.equal(r.pos.a.x, colX(0));
  assert.equal(r.pos.b.x, colX(1));
  assert.deepEqual(r.heads, [{ text: 'Left', x: colX(0) }, { text: 'Right', x: colX(1) }]);
  assert.equal(r.width, PAD * 2 + NODE_W + XSTEP);
});

test('layoutColumns stacks a column top to bottom with the gap', () => {
  const nodes = [node('a', { col: 0 }), node('b', { col: 0 })];
  const r = layoutColumns(nodes, ['Only'], []);
  assert.equal(r.pos.a.y, rowY(0));
  assert.equal(r.pos.b.y, rowY(1));
  assert.equal(r.height, PAD * 2 + 2 * NODE_H + VGAP);
});

test('layoutColumns centres a short column against the tallest', () => {
  const nodes = [node('a', { col: 0 }), node('b', { col: 0 }), node('c', { col: 0 }), node('d', { col: 1 })];
  const r = layoutColumns(nodes, ['Tall', 'Short'], []);
  const mid = (r.pos.a.y + r.pos.c.y) / 2;
  assert.equal(r.pos.d.y, mid);
});

test('layoutColumns caps at six columns', () => {
  const titles = ['0', '1', '2', '3', '4', '5', '6'];
  const nodes = titles.map((t, c) => node('n' + c, { col: c }));
  const r = layoutColumns(nodes, titles, []);
  assert.equal(r.heads.length, 6);
  assert.equal(r.pos.n6, undefined);
});

test('layoutColumns sorts inside a column by the chain', () => {
  const stats = { hot: { count: 9 }, cold: { count: 1 } };
  const nodes = [node('cold', { col: 0 }), node('hot', { col: 0 })];
  const r = layoutColumns(nodes, ['Only'], ['runs'], stats);
  assert.ok(r.pos.hot.y < r.pos.cold.y, 'busier node should sit on top');
});

// ---- layoutDag --------------------------------------------------------------
test('layoutDag lays a chain out left to right by depth', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const r = layoutDag(nodes, [['a', 'b'], ['b', 'c']], []);
  assert.equal(r.pos.a.x, colX(0));
  assert.equal(r.pos.b.x, colX(1));
  assert.equal(r.pos.c.x, colX(2));
});

test('layoutDag layers a diamond with the join after both branches', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const r = layoutDag(nodes, [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']], []);
  assert.equal(r.pos.b.x, colX(1));
  assert.equal(r.pos.c.x, colX(1));
  assert.equal(r.pos.d.x, colX(2));
});

test('layoutDag uses longest path, not shortest, for layering', () => {
  // a -> b -> c and a -> c: c must sit after b, not beside it.
  const nodes = [node('a'), node('b'), node('c')];
  const r = layoutDag(nodes, [['a', 'b'], ['b', 'c'], ['a', 'c']], []);
  assert.equal(r.pos.c.x, colX(2));
});

test('layoutDag survives a cycle by dropping back-edges', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const r = layoutDag(nodes, [['a', 'b'], ['b', 'c'], ['c', 'a']], []);
  assert.equal(r.pos.a.x, colX(0));
  assert.equal(r.pos.c.x, colX(2));
  for (const p of Object.values(r.pos)) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test('layoutDag ignores self-edges', () => {
  const nodes = [node('a')];
  const r = layoutDag(nodes, [['a', 'a']], []);
  assert.equal(r.pos.a.x, colX(0));
});

test('layoutDag drops an isolated node into the layer its col names', () => {
  const nodes = [node('a'), node('b'), node('z', { col: 1 })];
  const r = layoutDag(nodes, [['a', 'b']], []);
  assert.equal(r.pos.z.x, colX(1), 'isolated node should use its col as the layer');
});

test('layoutDag puts an isolated node without a col in the first layer', () => {
  const nodes = [node('a'), node('b'), node('z')];
  const r = layoutDag(nodes, [['a', 'b']], []);
  assert.equal(r.pos.z.x, colX(0));
});

test('layoutDag reduces crossings so children follow their parents', () => {
  // Children inserted in reverse order of their parents: barycenter must
  // re-order layer 1 to t1-above-t2, matching s1-above-s2.
  const nodes = [node('s1'), node('s2'), node('t2'), node('t1')];
  const r = layoutDag(nodes, [['s1', 't1'], ['s2', 't2']], []);
  assert.ok(r.pos.s1.y < r.pos.s2.y);
  assert.ok(r.pos.t1.y < r.pos.t2.y, 'crossing not untangled');
});

test('layoutDag emits no column heads', () => {
  const r = layoutDag([node('a')], [], []);
  assert.deepEqual(r.heads, []);
});

test('layoutDag sorts inside a layer by the chain', () => {
  const stats = { hot: { errors: 7 }, cold: { errors: 0 } };
  const nodes = [node('root'), node('cold'), node('hot')];
  const r = layoutDag(nodes, [['root', 'cold'], ['root', 'hot']], ['errors'], stats);
  assert.ok(r.pos.hot.y < r.pos.cold.y, 'erroring node should sit on top');
});

test('layoutDag is deterministic', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id));
  const edges = [['a', 'c'], ['b', 'c'], ['b', 'd'], ['c', 'e'], ['d', 'e'], ['a', 'f']];
  const one = layoutDag(nodes, edges, []);
  const two = layoutDag(nodes, edges, []);
  assert.deepEqual(one, two);
});

test('layoutDag handles empty input without NaN or throw', () => {
  const r = layoutDag([], [], []);
  assert.deepEqual(r.pos, {});
  assert.ok(Number.isFinite(r.width) && r.width >= 0);
  assert.ok(Number.isFinite(r.height) && r.height >= 0);
});

test('layoutColumns handles empty input without NaN or throw', () => {
  const r = layoutColumns([], [], []);
  assert.deepEqual(r.pos, {});
  assert.ok(Number.isFinite(r.width) && r.width >= 0);
  assert.ok(Number.isFinite(r.height) && r.height >= 0);
});

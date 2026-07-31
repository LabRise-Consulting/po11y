import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScale, zoomAt, fitView, isClick, LIMITS } from './map.lib.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// ---- clampScale -------------------------------------------------------------
test('clampScale holds the scale inside the configured limits', () => {
  assert.equal(clampScale(0.01), LIMITS.min);
  assert.equal(clampScale(99), LIMITS.max);
  assert.equal(clampScale(1), 1);
});

test('clampScale rejects NaN rather than poisoning the transform', () => {
  assert.equal(clampScale(NaN), 1);
  assert.equal(clampScale(undefined), 1);
});

// ---- zoomAt -----------------------------------------------------------------
// The whole point of anchored zoom: whatever is under the pointer must stay
// under the pointer, otherwise zooming feels like the map runs away.
test('zoomAt keeps the anchor point fixed on the screen', () => {
  const before = { x: 0, y: 0, k: 1 };
  const anchor = { x: 300, y: 200 };
  const after = zoomAt(before, anchor, 2);
  // Content coordinate under the anchor, before and after.
  const contentBefore = { x: (anchor.x - before.x) / before.k, y: (anchor.y - before.y) / before.k };
  const contentAfter = { x: (anchor.x - after.x) / after.k, y: (anchor.y - after.y) / after.k };
  near(contentAfter.x, contentBefore.x, 'anchor drifted horizontally');
  near(contentAfter.y, contentBefore.y, 'anchor drifted vertically');
});

test('zoomAt keeps the anchor fixed when already panned and zoomed', () => {
  const before = { x: -140, y: 65, k: 1.75 };
  const anchor = { x: 410, y: 128 };
  const after = zoomAt(before, anchor, 1 / 1.2);
  const cb = { x: (anchor.x - before.x) / before.k, y: (anchor.y - before.y) / before.k };
  const ca = { x: (anchor.x - after.x) / after.k, y: (anchor.y - after.y) / after.k };
  near(ca.x, cb.x, 'anchor drifted horizontally');
  near(ca.y, cb.y, 'anchor drifted vertically');
});

test('zoomAt clamps at the ceiling and stops translating once clamped', () => {
  const at = { x: 0, y: 0, k: LIMITS.max };
  const after = zoomAt(at, { x: 100, y: 100 }, 4);
  assert.equal(after.k, LIMITS.max);
  assert.deepEqual({ x: after.x, y: after.y }, { x: 0, y: 0 }, 'a refused zoom must not pan the map');
});

test('zoomAt clamps at the floor and stops translating once clamped', () => {
  const at = { x: 10, y: 20, k: LIMITS.min };
  const after = zoomAt(at, { x: 100, y: 100 }, 0.25);
  assert.equal(after.k, LIMITS.min);
  assert.deepEqual({ x: after.x, y: after.y }, { x: 10, y: 20 });
});

// ---- fitView ----------------------------------------------------------------
test('fitView scales a too-wide diagram down to the viewport width', () => {
  const v = fitView({ width: 2000, height: 500 }, { width: 1000, height: 1000 }, { padding: 0 });
  assert.equal(v.k, 0.5, 'width is the binding constraint');
});

test('fitView scales to the binding dimension, not merely the width', () => {
  const v = fitView({ width: 1000, height: 4000 }, { width: 1000, height: 1000 }, { padding: 0 });
  assert.equal(v.k, 0.25, 'height is the binding constraint here');
});

test('fitView centres the scaled diagram in the viewport', () => {
  const v = fitView({ width: 1000, height: 500 }, { width: 1000, height: 1000 }, { padding: 0 });
  assert.equal(v.k, 1);
  assert.equal(v.x, 0, 'already full width, no horizontal slack');
  assert.equal(v.y, 250, 'vertical slack is split evenly');
});

test('fitView honours padding so the diagram does not touch the edges', () => {
  const v = fitView({ width: 1000, height: 1000 }, { width: 1000, height: 1000 }, { padding: 50 });
  assert.equal(v.k, 0.9, 'padding shrinks the usable box on both sides');
});

test('fitView never exceeds the zoom ceiling on a tiny diagram', () => {
  const v = fitView({ width: 10, height: 10 }, { width: 4000, height: 4000 }, { padding: 0 });
  assert.equal(v.k, LIMITS.max);
});

test('fitView survives a zero-sized diagram instead of returning NaN', () => {
  const v = fitView({ width: 0, height: 0 }, { width: 800, height: 600 });
  assert.equal(v.k, 1);
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y));
});

test('fitView survives a zero-sized viewport', () => {
  const v = fitView({ width: 100, height: 100 }, { width: 0, height: 0 });
  assert.ok(Number.isFinite(v.k) && v.k > 0);
});

// ---- isClick ----------------------------------------------------------------
// Nodes open a dialog on click, and the map pans on drag. Without a movement
// threshold every pan that starts on a node would also open its dialog.
test('a press that barely moves is still a click', () => {
  assert.equal(isClick(2, 1), true);
});

test('a press that moves past the threshold is a drag, not a click', () => {
  assert.equal(isClick(20, 0), false);
  assert.equal(isClick(0, 20), false);
});

test('the threshold is diagonal distance, not per-axis', () => {
  // 4px on each axis is ~5.66px of travel — past a 5px threshold.
  assert.equal(isClick(4, 4, 5), false);
  assert.equal(isClick(3, 3, 5), true);
});

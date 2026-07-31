// Pure, dependency-free pan/zoom maths for the Map tab. Imported by map.html
// (browser) and map.lib.test.mjs (node --test). No DOM here.
//
// The view is a single transform applied to a wrapper around mermaid's SVG:
//   transform: translate(x, y) scale(k)   with transform-origin: 0 0
// so screen = content * k + translate, and content = (screen - translate) / k.
// Every function below is a pure map from one {x, y, k} to the next.

export const LIMITS = { min: 0.2, max: 4 };

/** Keep a scale inside LIMITS; a non-finite input falls back to 1 rather than
 *  propagating NaN into the transform, which would blank the map entirely. */
export function clampScale(k) {
  const n = Number(k);
  if (!Number.isFinite(n)) return 1;
  return Math.min(LIMITS.max, Math.max(LIMITS.min, n));
}

/**
 * Zoom by `factor` about a screen-space anchor (usually the pointer), keeping
 * whatever sits under that anchor pinned there.
 *
 * Solving screen = content * k + t for a fixed content point gives
 *   t2 = anchor - (anchor - t1) * (k2 / k1)
 * When the clamp refuses the zoom, k2 === k1 and that reduces to t2 = t1 — so a
 * refused zoom leaves the view completely untouched instead of sliding it.
 *
 * @param {{x: number, y: number, k: number}} view
 * @param {{x: number, y: number}} anchor - screen coords relative to the viewport
 * @param {number} factor
 * @returns {{x: number, y: number, k: number}}
 */
export function zoomAt(view, anchor, factor) {
  const k1 = clampScale(view.k);
  const k2 = clampScale(k1 * factor);
  const ratio = k2 / k1;
  return {
    k: k2,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/**
 * Scale a diagram to fit a viewport and centre it.
 *
 * Fits the *binding* dimension — scaling on width alone leaves a tall map
 * running off the bottom, which is the common shape for a workflow graph.
 * Degenerate sizes (a map that has not laid out yet, a hidden iframe reporting
 * 0x0) must not produce NaN: they fall back to an identity-ish view.
 *
 * @param {{width: number, height: number}} content
 * @param {{width: number, height: number}} viewport
 * @param {{padding?: number}} [opts]
 * @returns {{x: number, y: number, k: number}}
 */
export function fitView(content, viewport, { padding = 16 } = {}) {
  const cw = Number(content?.width) || 0;
  const ch = Number(content?.height) || 0;
  const vw = Number(viewport?.width) || 0;
  const vh = Number(viewport?.height) || 0;
  if (cw <= 0 || ch <= 0) return { x: 0, y: 0, k: 1 };

  // Padding is taken off both sides; never let it collapse the box entirely.
  const boxW = Math.max(1, vw - padding * 2);
  const boxH = Math.max(1, vh - padding * 2);
  const k = clampScale(Math.min(boxW / cw, boxH / ch));

  return {
    k,
    x: (vw - cw * k) / 2,
    y: (vh - ch * k) / 2,
  };
}

/**
 * Was a pointer press a click or the start of a pan?
 *
 * Map nodes open a dialog on click and the canvas pans on drag, so without a
 * movement threshold every pan that happened to begin on a node would also pop
 * that node's dialog open. Measured as diagonal travel, so a slow drag that
 * creeps a few pixels on both axes still counts as a drag.
 *
 * @param {number} dx
 * @param {number} dy
 * @param {number} [threshold] - pixels of travel still considered a click
 */
export function isClick(dx, dy, threshold = 5) {
  return Math.hypot(Number(dx) || 0, Number(dy) || 0) <= threshold;
}

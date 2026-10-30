// SVG -> extruded geometry. Filled shapes only (strokes are ignored).
// The result is normalised: centred on the origin, longest side = 2 units,
// Y up, depth along Z.

import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

const cache = new Map(); // svg text -> { shapes, w, h, cx, cy, strokesOnly }

function parse(text) {
  let c = cache.get(text);
  if (c) return c;
  const data = new SVGLoader().parse(text);
  const shapes = [];
  let strokes = 0;
  for (const path of data.paths) {
    const st = path.userData && path.userData.style;
    if (st && st.fill === 'none') {
      if (st.stroke && st.stroke !== 'none') strokes++;
      continue;
    }
    for (const sh of path.toShapes()) shapes.push(sh);
  }
  if (!shapes.length) {
    c = { shapes, strokesOnly: strokes > 0 };
  } else {
    const probe = new THREE.ShapeGeometry(shapes);
    probe.computeBoundingBox();
    const b = probe.boundingBox;
    probe.dispose();
    const w = b.max.x - b.min.x;
    const h = b.max.y - b.min.y;
    c = { shapes, w, h, cx: (b.max.x + b.min.x) / 2, cy: (b.max.y + b.min.y) / 2, strokesOnly: false };
  }
  if (cache.size > 12) cache.clear();
  cache.set(text, c);
  return c;
}

/** Quick validity check used on import. Returns { ok, message }. */
export function inspectSvg(text) {
  try {
    const c = parse(text);
    if (!c.shapes.length) {
      return { ok: false, message: c.strokesOnly ? 'That SVG only has strokes. Convert strokes to filled paths first.' : 'No filled shapes found in that SVG.' };
    }
    return { ok: true, shapes: c.shapes.length };
  } catch (err) {
    return { ok: false, message: 'Could not read that SVG: ' + err.message };
  }
}

export function makeSvgGeometry(text, { depth = 0.3, detail = 2 } = {}) {
  const c = text ? parse(text) : null;
  if (!c || !c.shapes.length) return new THREE.BufferGeometry();
  const s = 2 / Math.max(c.w, c.h, 1e-9);
  const g = new THREE.ExtrudeGeometry(c.shapes, {
    depth: depth / s,
    bevelEnabled: false,
    curveSegments: Math.round(4 + 4 * detail),
  });
  g.translate(-c.cx, -c.cy, -depth / s / 2);
  g.scale(s, -s, s); // SVG is Y-down; mirroring flips the winding, fixed below
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    for (const a of [pos, nor, uv]) {
      if (!a) continue;
      const n = a.itemSize;
      for (let k = 0; k < n; k++) {
        const t = a.array[(i + 1) * n + k];
        a.array[(i + 1) * n + k] = a.array[(i + 2) * n + k];
        a.array[(i + 2) * n + k] = t;
      }
    }
  }
  g.clearGroups();
  const idx = new Uint32Array(pos.count);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();
  return g;
}

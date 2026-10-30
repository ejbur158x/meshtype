// Meshtype shape generators.
//
// The squircle primitive is a superellipsoid, built by walking its Gauss map
// (the direction of the surface normal) instead of a plain lat/long grid.
// Stepping evenly in normal angle puts vertices where the surface actually
// bends and almost none on the flat faces, so high-n shapes stay crisp and
// smooth-shaded without needing a huge triangle count.
//
// n is the Lamé exponent of the outline: n=2 is an ellipse, n=4 is the
// classic squircle, larger n gets boxier.

import * as THREE from 'three';

const PI = Math.PI;
const HALF_PI = PI / 2;
const spow = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);

// Cosine ease clusters samples near 0 and 1 (the flat faces) for boxy shapes.
const ease = (a, s) => (1 - s) * a + s * 0.5 * (1 - Math.cos(PI * a));
const easeStrength = (n) => Math.min(1, Math.max(0, (n - 2) / 2));

export const SHAPES = {
  squircle: {
    defaults: { nPlan: 4, nProf: 4, detail: 2 },
    limits: { nPlan: [2, 20], nProf: [2, 20], detail: [1, 4] },
  },
  pill: {
    defaults: { radius: 0.25, length: 0.5, detail: 2 },
    limits: { radius: [0.05, 0.5], length: [0, 2], detail: [1, 4] },
  },
};

function superellipsoid({ nPlan, nProf, detail }) {
  const d = Math.max(1, Math.round(detail));
  const nu = 16 * d; // columns around the outline (multiple of 4)
  const nv = 8 * d; // rows pole to pole (even)
  const mu = nu / 4;
  const mv = nv / 2;
  const e1 = 2 / nProf;
  const e2 = 2 / nPlan;
  const a1 = 1 / (2 - e1);
  const a2 = 1 / (2 - e2);
  const sPlan = easeStrength(nPlan);
  const sProf = easeStrength(nProf);

  // Per-column values depend only on the outline angle.
  const cols = [];
  for (let i = 0; i <= nu; i++) {
    const qi = Math.floor(i / mu);
    const k = i - qi * mu;
    const q = qi % 4; // i = nu wraps to quadrant 0, k = 0: exact seam duplicate
    const lam = ease(k / mu, sPlan) * HALF_PI;
    const cl = Math.cos(lam);
    const sl = Math.sin(lam);
    let c2, s2;
    if (q === 0) { c2 = cl; s2 = sl; }
    else if (q === 1) { c2 = -sl; s2 = cl; }
    else if (q === 2) { c2 = -cl; s2 = -sl; }
    else { c2 = sl; s2 = -cl; }
    const K = Math.pow(Math.pow(Math.abs(c2), 2 * a2) + Math.pow(Math.abs(s2), 2 * a2), -0.5);
    cols.push({
      c2,
      s2,
      fx: spow(spow(c2, a2) * K, e2),
      fz: spow(spow(s2, a2) * K, e2),
      R: Math.pow(K, 2 - e2),
    });
  }

  const count = (nu + 1) * (nv + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);

  let p = 0;
  let t = 0;
  for (let j = 0; j <= nv; j++) {
    let c1, s1;
    const pole = j === 0 || j === nv;
    if (pole) {
      c1 = 0;
      s1 = j === 0 ? -1 : 1;
    } else {
      const lower = j < mv;
      const a = lower ? (mv - j) / mv : (j - mv) / mv;
      const psi = (lower ? -1 : 1) * ease(a, sProf) * HALF_PI;
      c1 = Math.cos(psi);
      s1 = Math.sin(psi);
    }
    for (let i = 0; i <= nu; i++) {
      const col = cols[i];
      let ch, sh;
      if (pole) {
        ch = 0;
        sh = s1;
      } else {
        const m = (s1 / c1) * col.R;
        const tt = spow(m, a1);
        ch = 1 / Math.sqrt(1 + tt * tt);
        sh = tt * ch;
      }
      const rch = spow(ch, e1);
      pos[p] = 0.5 * rch * col.fx;
      pos[p + 1] = 0.5 * spow(sh, e1);
      pos[p + 2] = 0.5 * rch * col.fz;
      nor[p] = c1 * col.c2;
      nor[p + 1] = s1;
      nor[p + 2] = c1 * col.s2;
      p += 3;
      uv[t++] = i / nu;
      uv[t++] = j / nv;
    }
  }

  return gridGeometry(pos, nor, uv, nu, nv + 1);
}

// Turns a (nu+1) x rows vertex grid into an indexed, outward-facing geometry.
// Rows 0 and rows-1 are expected to be poles (collapsed rings).
function gridGeometry(pos, nor, uv, nu, rows) {
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < nu; i++) {
      const i0 = j * (nu + 1) + i;
      const i1 = i0 + 1;
      const i2 = i0 + nu + 1;
      const i3 = i2 + 1;
      if (j !== 0) idx.push(i0, i1, i2);
      if (j !== rows - 2) idx.push(i1, i3, i2);
    }
  }

  // Orient the winding so faces point outward (normals are already outward).
  let vol = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) {
    for (let f = 0; f < idx.length; f += 3) {
      const tmp = idx[f + 1];
      idx[f + 1] = idx[f + 2];
      idx[f + 2] = tmp;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Capsule along Y: two hemispherical caps joined by a straight wall.
// Built by hand (not THREE.CapsuleGeometry) so the seam and poles are exact
// and the mesh stays watertight for booleans.
function pill({ radius, length, detail }) {
  const d = Math.max(1, Math.round(detail));
  const nu = 8 * d + 8;
  const cap = 4 * d;
  const half = length / 2;
  const rows = [];
  for (let k = 0; k <= cap; k++) {
    // lower cap: pole (k = 0) up to the equator (k = cap)
    const psi = -HALF_PI + (HALF_PI * k) / cap;
    rows.push({ c1: k === 0 ? 0 : k === cap ? 1 : Math.cos(psi), s1: k === 0 ? -1 : k === cap ? 0 : Math.sin(psi), cy: -half });
  }
  for (let k = 0; k <= cap; k++) {
    // upper cap: equator (k = 0) up to the pole (k = cap)
    if (k === 0 && length < 1e-4) continue; // no wall, share the equator row
    const psi = (HALF_PI * k) / cap;
    rows.push({ c1: k === 0 ? 1 : k === cap ? 0 : Math.cos(psi), s1: k === 0 ? 0 : k === cap ? 1 : Math.sin(psi), cy: half });
  }
  const count = (nu + 1) * rows.length;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let p = 0;
  let t = 0;
  rows.forEach((row, j) => {
    for (let i = 0; i <= nu; i++) {
      const ang = (2 * PI * (i % nu)) / nu;
      const c2 = Math.cos(ang);
      const s2 = Math.sin(ang);
      pos[p] = radius * row.c1 * c2;
      pos[p + 1] = row.cy + radius * row.s1;
      pos[p + 2] = radius * row.c1 * s2;
      nor[p] = row.c1 * c2;
      nor[p + 1] = row.s1;
      nor[p + 2] = row.c1 * s2;
      p += 3;
      uv[t++] = i / nu;
      uv[t++] = j / (rows.length - 1);
    }
  });
  return gridGeometry(pos, nor, uv, nu, rows.length);
}

export function makeGeometry(type, params) {
  if (type === 'pill') return pill(params);
  return superellipsoid(params);
}

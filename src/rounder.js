// Meshtype edge rounder.
//
// Rounds the sharp edges of any closed triangle mesh by working on a signed
// distance field instead of the mesh itself:
//
//   1. Voxelise: exact distance to the surface in a narrow band, sign from
//      ray parity along all three axes (majority vote, so a few pinholes in a
//      boolean result don't matter).
//   2. Round outer (convex) edges: this is a morphological opening. Erode the
//      shape by r, re-solve the distance field outward from the eroded
//      boundary (fast sweeping), then grow it back by r. Flat faces stay put,
//      convex edges and corners become true r-radius fillets.
//   3. Round inner (concave) edges: the same trick on the inverted field
//      (a morphological closing).
//   4. Extract the surface with surface nets, smooth normals from the field
//      gradient, and carry the source material of each triangle across.
//
// Pure JS with no imports, so it runs in a worker or in Node tests.

const BIG = 1e9;

/* ---------------------------- geometry helpers ---------------------------- */

function ptTriSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = px - (ax + v * abx), qy = py - (ay + v * aby), qz = pz - (az + v * abz);
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = px - (ax + w * acx), qy = py - (ay + w * acy), qz = pz - (az + w * acz);
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = px - (bx + w * (cx - bx)), qy = py - (by + w * (cy - by)), qz = pz - (bz + w * (cz - bz));
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = px - (ax + abx * v + acx * w), qy = py - (ay + aby * v + acy * w), qz = pz - (az + abz * v + acz * w);
  return qx * qx + qy * qy + qz * qz;
}

/* ------------------------------- grid setup ------------------------------- */

function buildGrid(positions, outer, inner, resolution, maxCells) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const longest = Math.max(maxx - minx, maxy - miny, maxz - minz);
  if (!(longest > 0)) return null;
  const rMax = Math.max(outer, inner);
  const rMin = Math.min(outer > 0 ? outer : Infinity, inner > 0 ? inner : Infinity);
  let h = Math.min(longest / resolution, rMin / 2.5);
  let nx, ny, nz, W, pad;
  for (let guard = 0; guard < 60; guard++) {
    W = rMax + 3 * h;
    pad = W + 2 * h;
    nx = Math.ceil((maxx - minx + 2 * pad) / h) + 1;
    ny = Math.ceil((maxy - miny + 2 * pad) / h) + 1;
    nz = Math.ceil((maxz - minz + 2 * pad) / h) + 1;
    if (nx * ny * nz <= maxCells) break;
    h *= 1.08;
  }
  return {
    h, W, nx, ny, nz,
    ox: minx - pad, oy: miny - pad, oz: minz - pad,
    warnSmall: rMin / h < 1.5,
  };
}

/* ------------------------- distance + inside/outside ----------------------- */

function distancePass(positions, grid, nTri) {
  const { h, W, nx, ny, nz, ox, oy, oz } = grid;
  const N = nx * ny * nz;
  const bandR = W + h;
  const bandR2 = bandR * bandR;
  const best = new Float32Array(N).fill(BIG);
  const triOf = new Int32Array(N).fill(-1);
  const inv = 1 / h;
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nxv = e1y * e2z - e1z * e2y, nyv = e1z * e2x - e1x * e2z, nzv = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nxv, nyv, nzv);
    if (len < 1e-14) continue;
    nxv /= len; nyv /= len; nzv /= len;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - bandR - ox) * inv));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) + bandR - ox) * inv));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - bandR - oy) * inv));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) + bandR - oy) * inv));
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - bandR - oz) * inv));
    const k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) + bandR - oz) * inv));
    for (let k = k0; k <= k1; k++) {
      const pz = oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * h;
        let id = i0 + nx * (j + ny * k);
        for (let i = i0; i <= i1; i++, id++) {
          const px = ox + i * h;
          const pd = nxv * (px - ax) + nyv * (py - ay) + nzv * (pz - az);
          if (pd * pd > bandR2) continue;
          const d2 = ptTriSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
          if (d2 < best[id]) {
            best[id] = d2;
            triOf[id] = t;
          }
        }
      }
    }
  }
  return { best, triOf };
}

/** Ray-parity inside test along one axis. Adds 1 to votes[] for every cell found inside. */
function parityVotes(positions, grid, nTri, axis, votes) {
  const dims = [grid.nx, grid.ny, grid.nz];
  const org = [grid.ox, grid.oy, grid.oz];
  const h = grid.h;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const nu = dims[u];
  const nv = dims[v];
  const nAx = dims[axis];
  // Offset the rays a hair so they never run exactly along a shared triangle edge.
  const ju = h * (0.0123 + 0.0031 * axis);
  const jv = h * (0.0071 + 0.0047 * axis);
  const counts = new Int32Array(nu * nv);

  const P = new Float64Array(9);
  const visit = (t, fn) => {
    const o = t * 9;
    for (let q = 0; q < 9; q++) P[q] = positions[o + q];
    const au = P[u], av = P[v];
    const bu = P[3 + u], bv = P[3 + v];
    const cu = P[6 + u], cv = P[6 + v];
    const area = (bu - au) * (cv - av) - (cu - au) * (bv - av);
    if (Math.abs(area) < 1e-18) return;
    const ia = 1 / area;
    const j0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - org[u] - ju) / h));
    const j1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - org[u] - ju) / h));
    const k0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - org[v] - jv) / h));
    const k1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - org[v] - jv) / h));
    if (j1 < j0 || k1 < k0) return;
    // plane normal component along the ray axis
    const e1 = [P[3] - P[0], P[4] - P[1], P[5] - P[2]];
    const e2 = [P[6] - P[0], P[7] - P[1], P[8] - P[2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.abs(nrm[axis]) < 1e-14) return;
    for (let k = k0; k <= k1; k++) {
      const pv = org[v] + k * h + jv;
      for (let j = j0; j <= j1; j++) {
        const pu = org[u] + j * h + ju;
        const w0 = ((bu - pu) * (cv - pv) - (cu - pu) * (bv - pv)) * ia;
        const w1 = ((cu - pu) * (av - pv) - (au - pu) * (cv - pv)) * ia;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const x = P[axis] - (nrm[u] * (pu - au) + nrm[v] * (pv - av)) / nrm[axis];
        fn(j + nu * k, x);
      }
    }
  };

  for (let t = 0; t < nTri; t++) visit(t, (col) => { counts[col]++; });
  const offsets = new Int32Array(nu * nv + 1);
  for (let c = 0; c < nu * nv; c++) offsets[c + 1] = offsets[c] + counts[c];
  const cross = new Float64Array(offsets[nu * nv]);
  const fillPos = offsets.slice(0, nu * nv);
  for (let t = 0; t < nTri; t++) visit(t, (col, x) => { cross[fillPos[col]++] = x; });

  const strideAx = axis === 0 ? 1 : axis === 1 ? grid.nx : grid.nx * grid.ny;
  const strideU = u === 0 ? 1 : u === 1 ? grid.nx : grid.nx * grid.ny;
  const strideV = v === 0 ? 1 : v === 1 ? grid.nx : grid.nx * grid.ny;
  for (let c = 0; c < nu * nv; c++) {
    const s = offsets[c];
    const e = offsets[c + 1];
    if (e - s < 2) continue;
    const seg = cross.subarray(s, e);
    seg.sort();
    const j = c % nu;
    const k = (c - j) / nu;
    const base = j * strideU + k * strideV;
    for (let q = 0; q + 1 < seg.length; q += 2) {
      const a = Math.max(0, Math.ceil((seg[q] - org[axis]) / h));
      const b = Math.min(nAx - 1, Math.floor((seg[q + 1] - org[axis]) / h));
      for (let a2 = a; a2 <= b; a2++) votes[base + a2 * strideAx]++;
    }
  }
}

/* ------------------------------ field morphology --------------------------- */

/**
 * Exact squared Euclidean feature transform (Felzenszwalb), in cell units.
 * mask[id] = 1 marks source cells. Returns { d2, src } where src is the index
 * of the nearest source cell.
 */
function featureTransform(mask, nx, ny, nz) {
  const N = nx * ny * nz;
  const INF = 1e20;
  const d2 = new Float32Array(N);
  const src = new Int32Array(N).fill(-1);
  // pass 1: along x, plain nearest-source sweep
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k);
      let last = -1;
      for (let i = 0; i < nx; i++) {
        if (mask[row + i]) last = i;
        if (last >= 0) { const d = i - last; d2[row + i] = d * d; src[row + i] = row + last; } else d2[row + i] = INF;
      }
      last = -1;
      for (let i = nx - 1; i >= 0; i--) {
        if (mask[row + i]) last = i;
        if (last >= 0) {
          const d = last - i;
          if (d * d < d2[row + i]) { d2[row + i] = d * d; src[row + i] = row + last; }
        }
      }
    }
  }
  const m = Math.max(nx, ny, nz);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const f = new Float64Array(m);
  const sIn = new Int32Array(m);
  const dOut = new Float64Array(m);
  const sOut = new Int32Array(m);
  const pass = (n, stride, outerA, strideA, outerB, strideB) => {
    for (let b = 0; b < outerB; b++) {
      for (let a = 0; a < outerA; a++) {
        const base = a * strideA + b * strideB;
        for (let q = 0; q < n; q++) { f[q] = d2[base + q * stride]; sIn[q] = src[base + q * stride]; }
        let kk = -1;
        for (let q = 0; q < n; q++) {
          if (f[q] >= INF) continue;
          if (kk < 0) { kk = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
          for (;;) {
            const vk = v[kk];
            const sv = (f[q] + q * q - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
            if (sv <= z[kk]) {
              kk--;
              if (kk < 0) { kk = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; break; }
              continue;
            }
            kk++; v[kk] = q; z[kk] = sv; z[kk + 1] = Infinity;
            break;
          }
        }
        if (kk < 0) continue;
        let c = 0;
        for (let q = 0; q < n; q++) {
          while (z[c + 1] < q) c++;
          const dq = q - v[c];
          dOut[q] = dq * dq + f[v[c]];
          sOut[q] = sIn[v[c]];
        }
        for (let q = 0; q < n; q++) { d2[base + q * stride] = dOut[q]; src[base + q * stride] = sOut[q]; }
      }
    }
  };
  pass(ny, nx, nx, 1, nz, nx * ny); // along y
  pass(nz, nx * ny, nx, 1, ny, nx); // along z
  return { d2, src };
}

/** Morphological opening of the shape {F < 0} by radius r. Returns the new signed field. */
function openField(F, r, grid) {
  const { nx, ny, nz, h, W } = grid;
  const N = F.length;
  const mask = new Uint8Array(N);
  let any = false;
  for (let id = 0; id < N; id++) if (F[id] + r <= 0) { mask[id] = 1; any = true; }
  // the shape is thinner than 2r everywhere: opening removes all of it
  if (!any) return new Float32Array(N).fill(BIG);
  const { d2, src } = featureTransform(mask, nx, ny, nz);
  const H = new Float32Array(N);
  for (let id = 0; id < N; id++) {
    if (mask[id] || F[id] >= W || src[id] < 0) { H[id] = F[id]; continue; }
    // distance to the continuous eroded set: centre distance minus how deep
    // the nearest source cell sits inside it (F + r <= 0 there)
    const dist = h * Math.sqrt(d2[id]) + (F[src[id]] + r);
    H[id] = dist - r;
  }
  return H;
}

/**
 * One light [1 2 1] blur per axis, only near the surface. Flat faces are
 * linear fields so they pass through unchanged; it just removes the
 * cell-to-cell noise the distance estimate leaves on curved fillets.
 */
function smoothField(H, grid) {
  const { nx, ny, nz, h } = grid;
  const band = 3 * h;
  const strides = [1, nx, nx * ny];
  const dims = [nx, ny, nz];
  const tmp = new Float32Array(H.length);
  for (let axis = 0; axis < 3; axis++) {
    const st = strides[axis];
    const n = dims[axis];
    tmp.set(H);
    for (let id = 0; id < H.length; id++) {
      if (Math.abs(tmp[id]) > band) continue;
      const pos = Math.floor(id / st) % n;
      if (pos === 0 || pos === n - 1) continue;
      H[id] = 0.25 * tmp[id - st] + 0.5 * tmp[id] + 0.25 * tmp[id + st];
    }
  }
}

/* ------------------------------ surface nets ------------------------------- */

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function surfaceNets(H, grid) {
  const { nx, ny, nz, h, ox, oy, oz } = grid;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const verts = [];
  const v = new Float32Array(8);
  const sx = 1, sy = nx, sz = nx * ny;
  let count = 0;

  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const base = i + nx * (j + ny * k);
        v[0] = H[base]; v[1] = H[base + sx]; v[2] = H[base + sy]; v[3] = H[base + sx + sy];
        v[4] = H[base + sz]; v[5] = H[base + sz + sx]; v[6] = H[base + sz + sy]; v[7] = H[base + sz + sx + sy];
        let neg = 0;
        for (let q = 0; q < 8; q++) if (v[q] < 0) neg++;
        if (neg === 0 || neg === 8) continue;
        let ex = 0, ey = 0, ez = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const va = v[a], vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a], cb = CORNERS[b];
          ex += ca[0] + t * (cb[0] - ca[0]);
          ey += ca[1] + t * (cb[1] - ca[1]);
          ez += ca[2] + t * (cb[2] - ca[2]);
          n++;
        }
        cellVert[i + cx * (j + cy * k)] = count++;
        verts.push(ox + (i + ex / n) * h, oy + (j + ey / n) * h, oz + (k + ez / n) * h);
      }
    }
  }

  const idx = [];
  const cellAt = (i, j, k) => cellVert[i + cx * (j + cy * k)];
  const dimsN = [nx, ny, nz];
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const id = i + nx * (j + ny * k);
        const inside0 = H[id] < 0;
        for (let axis = 0; axis < 3; axis++) {
          const step = axis === 0 ? sx : axis === 1 ? sy : sz;
          const pos = axis === 0 ? i : axis === 1 ? j : k;
          if (pos >= dimsN[axis] - 1) continue;
          if (inside0 === H[id + step] < 0) continue;
          const u = (axis + 1) % 3;
          const w = (axis + 2) % 3;
          const c = [i, j, k];
          const q = [];
          const offs = [[-1, -1], [0, -1], [0, 0], [-1, 0]];
          let ok = true;
          for (const [du, dw] of offs) {
            const cc = [c[0], c[1], c[2]];
            cc[u] += du;
            cc[w] += dw;
            const vi = cellAt(cc[0], cc[1], cc[2]);
            if (vi < 0) { ok = false; break; }
            q.push(vi);
          }
          if (!ok) continue;
          if (inside0) idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
          else idx.push(q[0], q[2], q[1], q[0], q[3], q[2]);
        }
      }
    }
  }
  return { verts: Float32Array.from(verts), idx: Uint32Array.from(idx) };
}

function signedVolume(pos, idx) {
  let vol = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return vol / 6;
}

/* ------------------------------- mesh post ------------------------------- */

function adjacency(nVert, idx) {
  const deg = new Uint32Array(nVert + 1);
  for (let f = 0; f < idx.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      deg[idx[f + e] + 1]++;
      deg[idx[f + ((e + 1) % 3)] + 1]++;
    }
  }
  for (let i = 0; i < nVert; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nVert);
  const nb = new Uint32Array(deg[nVert]);
  for (let f = 0; f < idx.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[f + e];
      const b = idx[f + ((e + 1) % 3)];
      nb[fill[a]++] = b;
      nb[fill[b]++] = a;
    }
  }
  return { start: deg, nb };
}

/** Taubin lambda/mu smoothing: removes high-frequency bumps without shrinking the shape. */
function taubin(pos, idx, passes) {
  const n = pos.length / 3;
  const { start, nb } = adjacency(n, idx);
  const tmp = new Float32Array(pos.length);
  const step = (k) => {
    for (let i = 0; i < n; i++) {
      const s0 = start[i];
      const s1 = start[i + 1];
      if (s1 === s0) {
        tmp[i * 3] = pos[i * 3]; tmp[i * 3 + 1] = pos[i * 3 + 1]; tmp[i * 3 + 2] = pos[i * 3 + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (let q = s0; q < s1; q++) {
        const j = nb[q] * 3;
        x += pos[j]; y += pos[j + 1]; z += pos[j + 2];
      }
      const inv = 1 / (s1 - s0);
      tmp[i * 3] = pos[i * 3] + k * (x * inv - pos[i * 3]);
      tmp[i * 3 + 1] = pos[i * 3 + 1] + k * (y * inv - pos[i * 3 + 1]);
      tmp[i * 3 + 2] = pos[i * 3 + 2] + k * (z * inv - pos[i * 3 + 2]);
    }
    pos.set(tmp);
  };
  for (let p = 0; p < passes; p++) {
    step(0.5);
    step(-0.53);
  }
}

function meshNormals(pos, idx, out) {
  out.fill(0);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { out[v] += nx; out[v + 1] += ny; out[v + 2] += nz; }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
}

/** Box-projected UVs in world units (1 UV = 1 unit), so textures tile evenly. */
export function boxUVs(pos, nor) {
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const ax = Math.abs(nor[i]), ay = Math.abs(nor[i + 1]), az = Math.abs(nor[i + 2]);
    if (ax >= ay && ax >= az) { uv[j] = pos[i + 2] * Math.sign(nor[i] || 1); uv[j + 1] = pos[i + 1]; }
    else if (ay >= az) { uv[j] = pos[i]; uv[j + 1] = pos[i + 2] * -Math.sign(nor[i + 1] || 1); }
    else { uv[j] = pos[i] * -Math.sign(nor[i + 2] || 1); uv[j + 1] = pos[i + 1]; }
  }
  return uv;
}

/* ---------------------------------- main ---------------------------------- */

/**
 * @param {object} opts
 * @param {Float32Array} opts.positions triangle soup, 9 floats per triangle
 * @param {Uint16Array|Uint8Array|null} opts.triMat material index per triangle
 * @param {number} opts.outer radius for convex (outer) edges, 0 to skip
 * @param {number} opts.inner radius for concave (inner) edges, 0 to skip
 * @param {number} opts.resolution grid cells along the longest side
 */
export function roundMesh(opts) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const positions = opts.positions;
  const triMat = opts.triMat || null;
  const outer = Math.max(0, +opts.outer || 0);
  const inner = Math.max(0, +opts.inner || 0);
  const resolution = Math.max(24, Math.min(256, opts.resolution || 96));
  const maxCells = opts.maxCells || 5.5e6;
  const sand = Math.max(0, Math.min(10, +opts.sand || 0));
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  if (!(outer > 0 || inner > 0)) return null;
  const nTri = Math.floor(positions.length / 9);
  if (nTri < 4) return null;

  const grid = buildGrid(positions, outer, inner, resolution, maxCells);
  if (!grid) return null;
  const { nx, ny, nz, h, W } = grid;
  const N = nx * ny * nz;

  report(0.05);
  const { best, triOf } = distancePass(positions, grid, nTri);
  report(0.3);
  const votes = new Uint8Array(N);
  for (let axis = 0; axis < 3; axis++) parityVotes(positions, grid, nTri, axis, votes);

  const bandR = W + h;
  let F = new Float32Array(N);
  let insideBefore = 0;
  for (let id = 0; id < N; id++) {
    const d = Math.min(Math.sqrt(best[id]), bandR);
    if (votes[id] >= 2) { F[id] = -d; insideBefore++; }
    else F[id] = d;
  }
  if (insideBefore === 0) return null;

  report(0.45);
  let H = F;
  if (outer > 0) H = openField(H, outer, grid);
  report(0.6);
  if (inner > 0) {
    const neg = new Float32Array(N);
    for (let id = 0; id < N; id++) neg[id] = -H[id];
    const opened = openField(neg, inner, grid);
    H = new Float32Array(N);
    for (let id = 0; id < N; id++) H[id] = -opened[id];
  }

  report(0.72);
  smoothField(H, grid);

  let insideAfter = 0;
  for (let id = 0; id < N; id++) if (H[id] < 0) insideAfter++;
  if (insideAfter === 0) return { empty: true, stats: { cells: [nx, ny, nz], h, volumeRatio: 0 } };

  const { verts, idx } = surfaceNets(H, grid);
  report(0.82);
  if (idx.length === 0) return null;
  if (signedVolume(verts, idx) < 0) {
    for (let f = 0; f < idx.length; f += 3) {
      const t = idx[f + 1];
      idx[f + 1] = idx[f + 2];
      idx[f + 2] = t;
    }
  }

  // normals from the field gradient (trilinear), outward = +gradient
  const nVert = verts.length / 3;
  const normals = new Float32Array(verts.length);
  const sample = (x, y, z) => {
    let fx = (x - grid.ox) / h, fy = (y - grid.oy) / h, fz = (z - grid.oz) / h;
    fx = Math.min(Math.max(fx, 0), nx - 1.001);
    fy = Math.min(Math.max(fy, 0), ny - 1.001);
    fz = Math.min(Math.max(fz, 0), nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const b = i + nx * (j + ny * k);
    const sy = nx, sz = nx * ny;
    const c00 = H[b] * (1 - tx) + H[b + 1] * tx;
    const c10 = H[b + sy] * (1 - tx) + H[b + sy + 1] * tx;
    const c01 = H[b + sz] * (1 - tx) + H[b + sz + 1] * tx;
    const c11 = H[b + sz + sy] * (1 - tx) + H[b + sz + sy + 1] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  const dlt = h * 0.6;
  for (let q = 0; q < nVert; q++) {
    const x = verts[q * 3], y = verts[q * 3 + 1], z = verts[q * 3 + 2];
    let gx = sample(x + dlt, y, z) - sample(x - dlt, y, z);
    let gy = sample(x, y + dlt, z) - sample(x, y - dlt, z);
    let gz = sample(x, y, z + dlt) - sample(x, y, z - dlt);
    const l = Math.hypot(gx, gy, gz) || 1;
    normals[q * 3] = gx / l;
    normals[q * 3 + 1] = gy / l;
    normals[q * 3 + 2] = gz / l;
  }

  // sander: Taubin smoothing (shrink-free) to remove the faint ripples that
  // the source mesh facets and the voxel grid leave on curved surfaces
  if (sand > 0 && idx.length) {
    taubin(verts, idx, Math.round(sand * 4));
    meshNormals(verts, idx, normals);
  }
  report(0.95);
  const uvs = boxUVs(verts, normals);

  // source material per vertex (nearest source triangle in the voxel neighbourhood)
  const vertMat = new Uint16Array(nVert);
  if (triMat) {
    for (let q = 0; q < nVert; q++) {
      const ci = Math.round((verts[q * 3] - grid.ox) / h);
      const cj = Math.round((verts[q * 3 + 1] - grid.oy) / h);
      const ck = Math.round((verts[q * 3 + 2] - grid.oz) / h);
      let tri = -1;
      for (let r = 0; r <= 2 && tri < 0; r++) {
        for (let dk = -r; dk <= r && tri < 0; dk++) {
          for (let dj = -r; dj <= r && tri < 0; dj++) {
            for (let di = -r; di <= r; di++) {
              const i = ci + di, j = cj + dj, k = ck + dk;
              if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
              const t = triOf[i + nx * (j + ny * k)];
              if (t >= 0) { tri = t; break; }
            }
          }
        }
      }
      vertMat[q] = tri >= 0 ? triMat[tri] : 0;
    }
  }

  // regroup triangles by material so the geometry can use contiguous groups
  const nOut = idx.length / 3;
  const triOut = new Uint16Array(nOut);
  let maxMat = 0;
  for (let t = 0; t < nOut; t++) {
    const m = vertMat[idx[t * 3]];
    triOut[t] = m;
    if (m > maxMat) maxMat = m;
  }
  const counts = new Uint32Array(maxMat + 2);
  for (let t = 0; t < nOut; t++) counts[triOut[t] + 1]++;
  for (let m = 0; m <= maxMat; m++) counts[m + 1] += counts[m];
  const fill = counts.slice();
  const sorted = new Uint32Array(idx.length);
  for (let t = 0; t < nOut; t++) {
    const dst = fill[triOut[t]]++ * 3;
    sorted[dst] = idx[t * 3];
    sorted[dst + 1] = idx[t * 3 + 1];
    sorted[dst + 2] = idx[t * 3 + 2];
  }
  const groups = [];
  for (let m = 0; m <= maxMat; m++) {
    const n = counts[m + 1] - counts[m];
    if (n > 0) groups.push({ start: counts[m] * 3, count: n * 3, materialIndex: m });
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    positions: verts,
    normals,
    uvs,
    index: sorted,
    groups,
    stats: {
      cells: [nx, ny, nz],
      h,
      tris: nOut,
      ms: t1 - t0,
      volumeRatio: insideAfter / insideBefore,
      warnSmall: grid.warnSmall,
    },
  };
}

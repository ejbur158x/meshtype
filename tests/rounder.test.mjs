// Rounds a unit cube and compares the volume with the analytic rounded-box volume.
// No dependencies: node tests/rounder.test.mjs
import { roundMesh } from '../src/rounder.js';

function cube() {
  const v = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
  const f = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]]; // outward winding
  const out = [];
  for (const q of f) for (const t of [[0,1,2],[0,2,3]]) for (const i of t) out.push(...v[q[i]]);
  return new Float32Array(out);
}
function volume(pos, idx) {
  let s = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    s += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return s / 6;
}
let fail = 0;
const check = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, extra); if (!cond) fail++; };

const r = 0.1, s = 1 - 2 * r;
const expect = s ** 3 + 6 * s * s * r + 3 * Math.PI * s * r * r + (4 / 3) * Math.PI * r ** 3;
const out = roundMesh({ positions: cube(), triMat: new Uint16Array(12), outer: r, inner: 0, resolution: 80 });
const vol = volume(out.positions, out.index);
check('outer round volume within 1.5% of analytic', Math.abs(vol - expect) / expect < 0.015, `${vol.toFixed(4)} vs ${expect.toFixed(4)}`);
let max = 0;
for (const x of out.positions) max = Math.max(max, Math.abs(x));
check('flat faces stay put', Math.abs(max - 0.5) < 0.01, `max ${max.toFixed(4)}`);
check('no NaN', ![...out.positions, ...out.normals].some(Number.isNaN));
check('too-large radius reports empty', roundMesh({ positions: cube(), triMat: null, outer: 0.9, inner: 0, resolution: 48 }).empty === true);
process.exit(fail ? 1 : 0);

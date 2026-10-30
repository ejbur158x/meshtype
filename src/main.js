// Meshtype v0.3.0
// A small browser mesh editor: squircle primitives, union / negate / split,
// edge rounding, SVG extrusion, GLB export.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { SHAPES, makeGeometry } from './shapes.js';
import { MATERIALS, applyMaterial, makeAeroEnvironment } from './materials.js';
import { inspectSvg, makeSvgGeometry } from './svg.js';
import { roundMesh, boxUVs } from './rounder.js';
import { FLOORS, floorMaterial } from './floor.js';

const VERSION = '0.3.0';
const STORE_KEY = 'meshtype.autosave';

const PRESETS = {
  block: { label: 'Block', type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 2 }, scl: [1, 1, 1] },
  panel: { label: 'Panel', type: 'squircle', params: { nPlan: 5, nProf: 10, detail: 2 }, scl: [2, 0.14, 1.4] },
  disc: { label: 'Disc', type: 'squircle', params: { nPlan: 2, nProf: 10, detail: 2 }, scl: [1, 0.2, 1] },
  orb: { label: 'Orb', type: 'squircle', params: { nPlan: 2, nProf: 2, detail: 2 }, scl: [1, 1, 1] },
  pill: { label: 'Pill', type: 'pill', params: { radius: 0.25, length: 0.5, detail: 2 }, scl: [1, 1, 1] },
};

const SHAPE_UI = {
  squircle: [
    ['nPlan', 'Outline n (top view)', 2, 20, 0.1],
    ['nProf', 'Edge n (side view)', 2, 20, 0.1],
    ['detail', 'Detail', 1, 4, 1],
  ],
  pill: [
    ['radius', 'Radius', 0.05, 0.5, 0.01],
    ['length', 'Body length', 0, 2, 0.01],
    ['detail', 'Detail', 1, 4, 1],
  ],
  svg: [
    ['depth', 'Extrude depth', 0.02, 2, 0.01],
    ['detail', 'Curve detail', 1, 4, 1],
  ],
};

const QUALITY = [
  ['40', 'Low (lightest mesh)'],
  ['64', 'Draft'],
  ['96', 'Normal'],
  ['140', 'Fine'],
  ['200', 'Max (slow)'],
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);
const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const fmt = (v, d = 2) => String(round(v, d));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) => (String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const el = {
  stage: $('#stage'),
  canvas: $('#view'),
  list: $('#list'),
  inspector: $('#inspector'),
  stats: $('#stats'),
  toast: $('#toast'),
  empty: $('#empty'),
  name: $('#project-name'),
  undo: $('#btn-undo'),
  redo: $('#btn-redo'),
  fileOpen: $('#file-open'),
  fileSvg: $('#file-svg'),
  fileSky: $('#file-sky'),
  fileTex: $('#file-tex'),
  col: $('#chk-col'),
  progress: $('#progress'),
  strip: $('#chk-strip'),
  ctx: $('#ctx'),
  union: $('#btn-union'),
  negate: $('#btn-negate'),
  split: $('#btn-split'),
  intersect: $('#btn-intersect'),
};

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* document state (plain JSON, snapshot-able)                          */
/* ------------------------------------------------------------------ */
/*
 * state.nodes is one ordered list holding two kinds of node:
 *   part  { kind:'part', id, name, type, params, pos, rot, scl, neg, parent, mat, color, visible, asset?, round? }
 *   group { kind:'group', id, name, neg, mode:'union'|'int', parent, visible, round? }
 * A part is a solid, or a cutter when neg is true. A cutter does nothing until
 * it is UNIONed with a solid. A group is the result of UNION: its solid children
 * are added together and its cutter children are subtracted. Groups can nest.
 */

const GRID_SIZES = [0.05, 0.25, 0.5, 1, 2];
const DEFAULT_FLOOR = { on: false, w: 10, d: 10, preset: 'tile', grid: 0.5 };
function sanitizeFloor(f) {
  const src = f && typeof f === 'object' ? f : {};
  return {
    on: src.on === true,
    w: clamp(Number(src.w) || DEFAULT_FLOOR.w, 1, 200),
    d: clamp(Number(src.d) || DEFAULT_FLOOR.d, 1, 200),
    preset: FLOORS[src.preset] ? src.preset : DEFAULT_FLOOR.preset,
    grid: GRID_SIZES.includes(Number(src.grid)) ? Number(src.grid) : DEFAULT_FLOOR.grid,
  };
}

let state = { name: 'untitled', nodes: [], assets: {}, sel: [], active: null, nextId: 1, floor: { ...DEFAULT_FLOOR } };
const view = {
  mode: 'translate',
  snap: true,
  result: true,
  cages: false,
  sky: true,
  align: { axis: null, edge: 'center', target: 'avg' },
  center: { x: true, y: true, z: true },
};

const node = (id) => state.nodes.find((n) => n.id === id);
const kidsOf = (id) => state.nodes.filter((n) => n.parent === id);
const isGroup = (n) => !!n && n.kind === 'group';

function leavesOf(id, out = []) {
  const n = node(id);
  if (!n) return out;
  if (n.kind === 'part') out.push(n);
  else for (const k of kidsOf(id)) leavesOf(k.id, out);
  return out;
}
function topOf(id) {
  let n = node(id);
  for (let guard = 0; n && n.parent != null && guard < 64; guard++) n = node(n.parent);
  return n;
}
function descendantIds(id, out = []) {
  out.push(id);
  for (const k of kidsOf(id)) descendantIds(k.id, out);
  return out;
}
const liveSel = () => state.sel.filter((id) => node(id));
function uniqueTops(ids = liveSel()) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const t = topOf(id);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}
function selLeaves() {
  const seen = new Set();
  const out = [];
  for (const id of liveSel()) {
    for (const o of leavesOf(id)) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        out.push(o);
      }
    }
  }
  return out;
}

function sanitizeRound(r) {
  if (!r || typeof r !== 'object') return undefined;
  const outer = clamp(Number(r.outer) || 0, 0, 1);
  const inner = clamp(Number(r.inner) || 0, 0, 1);
  if (!(outer > 0 || inner > 0)) return undefined;
  const sand = r.sand === undefined ? 3 : clamp(Number(r.sand) || 0, 0, 10);
  return { outer, inner, res: clamp(Math.round(Number(r.res) || 64), 32, 220), sand };
}

function sanitizePart(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = SHAPES[raw.type] ? raw.type : 'squircle';
  const defs = SHAPES[type].defaults;
  const lims = SHAPES[type].limits;
  const params = {};
  for (const k of Object.keys(defs)) {
    let v = Number(raw.params && raw.params[k]);
    if (!Number.isFinite(v)) v = defs[k];
    params[k] = clamp(v, lims[k][0], lims[k][1]);
  }
  params.detail = Math.round(params.detail);
  const vec = (a, fallback, min) =>
    Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v))
      ? a.map((v) => (min === undefined ? v : Math.max(min, v)))
      : fallback.slice();
  const mat = MATERIALS[raw.mat] ? raw.mat : 'glass';
  const o = {
    kind: 'part',
    id: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : 0,
    name: String(raw.name || 'Shape').slice(0, 60),
    type,
    params,
    pos: vec(raw.pos, [0, 0, 0]),
    rot: vec(raw.rot, [0, 0, 0]),
    scl: vec(raw.scl, [1, 1, 1], 0.01),
    neg: raw.neg === true,
    parent: Number.isInteger(raw.parent) ? raw.parent : null,
    mat,
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : MATERIALS[mat].color,
    visible: raw.visible !== false,
  };
  if (type === 'svg') o.asset = String(raw.asset || '');
  if (typeof raw.tex === 'string' && raw.tex) {
    o.tex = raw.tex;
    o.texSize = clamp(Number(raw.texSize) || 0.5, 0.02, 10);
  }
  const rd = sanitizeRound(raw.round);
  if (rd) o.round = rd;
  return o;
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const g = {
    kind: 'group',
    id: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : 0,
    name: String(raw.name || 'Union').slice(0, 60),
    neg: raw.neg === true,
    mode: raw.mode === 'int' ? 'int' : 'union',
    parent: Number.isInteger(raw.parent) ? raw.parent : null,
    visible: raw.visible !== false,
  };
  const rd = sanitizeRound(raw.round);
  if (rd) g.round = rd;
  return g;
}

/** Turn a loaded project (v0.2 nodes, or v0.1 layers) into a valid node list. */
function sanitizeProject(data) {
  let rawNodes;
  let migrated = false;
  if (Array.isArray(data.nodes)) {
    rawNodes = data.nodes;
  } else {
    // v0.1: layers evaluated in order (add / sub / int) -> one union group
    migrated = true;
    const layers = Array.isArray(data.objects) ? data.objects : [];
    rawNodes = layers.map((l) => ({ ...l, kind: 'part', neg: l && l.op === 'sub' }));
    if (rawNodes.length > 1) {
      const gid = Math.max(Number(data.nextId) || 1, ...layers.map((l) => Number(l && l.id) || 0)) + 1;
      rawNodes.forEach((n) => (n.parent = gid));
      rawNodes.unshift({ kind: 'group', id: gid, name: 'Imported union', mode: 'union', parent: null });
      data = { ...data, nextId: gid + 1 };
    }
  }
  const nodes = [];
  const used = new Set();
  for (const raw of rawNodes) {
    const n = raw && raw.kind === 'group' ? sanitizeGroup(raw) : sanitizePart(raw);
    if (!n) continue;
    if (!n.id || used.has(n.id)) n.id = 0;
    if (n.id) used.add(n.id);
    nodes.push(n);
  }
  let next = Math.max(Number(data.nextId) || 1, ...used, 0) + 1;
  const remap = new Map();
  for (const n of nodes) {
    if (!n.id) {
      n.id = next++;
    }
  }
  void remap;
  // valid parents only: must be a group, no cycles
  const byIdMap = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parent != null) {
      const p = byIdMap.get(n.parent);
      if (!p || p.kind !== 'group' || p === n) n.parent = null;
    }
  }
  for (const n of nodes) {
    let cur = n;
    for (let g = 0; g < 64 && cur && cur.parent != null; g++) cur = byIdMap.get(cur.parent);
    if (cur && cur.parent != null) n.parent = null;
  }
  // parents must come before children in the list
  const ordered = [];
  const done = new Set();
  const place = (n) => {
    if (done.has(n.id)) return;
    done.add(n.id);
    ordered.push(n);
    for (const k of nodes) if (k.parent === n.id) place(k);
  };
  for (const n of nodes) if (n.parent == null) place(n);
  for (const n of nodes) place(n);
  // groups keep no round when they are children, and parts inside groups neither
  for (const n of ordered) if (n.parent != null) delete n.round;
  const assets = {};
  if (data.assets && typeof data.assets === 'object') {
    for (const [k, v] of Object.entries(data.assets)) if (typeof v === 'string') assets[k] = v;
  }
  return { nodes: ordered, assets, nextId: Math.max(next, Number(data.nextId) || 1), migrated };
}

function sampleProject() {
  const part = (id, name, params, pos, scl, mat, color, extra = {}) => ({
    kind: 'part', id, name, type: 'squircle', params, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat, color, visible: true, ...extra,
  });
  return {
    name: 'aero-demo',
    nextId: 6,
    sel: [1],
    active: 1,
    nodes: [
      { kind: 'group', id: 1, name: 'Console', neg: false, mode: 'union', parent: null, visible: true },
      part(2, 'Body', { nPlan: 4, nProf: 4, detail: 3 }, [0, 0, 0], [1.8, 0.5, 1.2], 'glass', '#8fdcff', { parent: 1 }),
      part(3, 'Recess', { nPlan: 4, nProf: 6, detail: 2 }, [0, 0.2, 0], [1.5, 0.3, 0.95], 'gloss', '#0a5aa8', { parent: 1, neg: true }),
      part(4, 'Lamp', { nPlan: 2, nProf: 2, detail: 2 }, [0, 0.06, 0], [0.32, 0.32, 0.32], 'glow', '#7dffb0'),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* three.js scene                                                      */
/* ------------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const env = makeAeroEnvironment(renderer);
scene.environment = env.envMap;
scene.backgroundBlurriness = 0.12;
const plainBg = new THREE.Color(0xd6eaf6);
scene.background = env.sky;

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
camera.position.set(2.6, 1.7, 3.1);

const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(3, 5, 2);
scene.add(sun);

let grid = null;
let gridKey = '';
const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1), floorMaterial('tile'));
floorMesh.position.y = -0.03;
floorMesh.visible = false;
scene.add(floorMesh);

/** Baseplate + grid lines + move snapping, all from state.floor. */
function syncFloor() {
  const f = state.floor;
  floorMesh.visible = f.on;
  floorMesh.scale.set(f.w, 1, f.d);
  const mat = floorMaterial(f.preset);
  floorMesh.material = mat;
  const tile = FLOORS[f.preset].tile;
  mat.map.repeat.set(f.w / tile, f.d / tile);
  const size = f.on ? Math.max(f.w, f.d) : 20;
  let step = f.grid;
  while (size / step > 400) step *= 2; // keep the line count sane
  const key = `${size}|${step}|${f.on}`;
  if (key !== gridKey) {
    gridKey = key;
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
    }
    const div = Math.max(1, Math.round(size / step));
    grid = new THREE.GridHelper(div * step, div, f.on ? 0x1f6fb0 : 0x2f8fcf, f.on ? 0x5d8fb5 : 0x8fc4e4);
    grid.material.transparent = true;
    grid.material.opacity = f.on ? 0.35 : 0.45;
    grid.position.y = f.on ? 0.003 : 0;
    scene.add(grid);
  }
  if (typeof applySnap === 'function') applySnap();
  const gs = document.querySelector('#grid-size');
  if (gs) gs.value = String(f.grid);
}

const orbit = new OrbitControls(camera, el.canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.target.set(0, 0, 0);
// Mouse map: right-drag orbits, middle-drag pans, left-drag is box select (handled below).
orbit.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

const transform = new TransformControls(camera, el.canvas);
transform.size = 0.8;
scene.add(transform.getHelper());
const pivot = new THREE.Object3D(); // gizmo handle for multi-selections and groups
scene.add(pivot);

const partsGroup = new THREE.Group();
scene.add(partsGroup);
const resultGroup = new THREE.Group();
scene.add(resultGroup);

const emptyGeo = new THREE.BufferGeometry();
const evaluator = new Evaluator();
evaluator.useGroups = true;

const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const wire = (color) =>
  new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
const fill = (color) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide });
const ghost = {
  wireSel: wire(0x0aa5ff),
  wireNeg: wire(0xff4d5e),
  fillNeg: fill(0xff4d5e),
};

// align plane preview
const planeMat = new THREE.MeshBasicMaterial({ color: 0x2f9bff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
planeMesh.renderOrder = 5;
const planeEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
  new THREE.LineBasicMaterial({ color: 0x1b78d8, depthTest: false, transparent: true, opacity: 0.9 })
);
planeMesh.add(planeEdge);
planeMesh.visible = false;
scene.add(planeMesh);

/** part id -> { proxy, part, wire, fill, geo, key, material } */
const rt = new Map();

function geometryFor(o) {
  if (o.type === 'svg') return makeSvgGeometry(state.assets[o.asset], o.params);
  return makeGeometry(o.type, o.params);
}

function hiGeometryFor(o) {
  // denser source for the rounder, so facets don't show up as ripples
  const params = { ...o.params, detail: 6 };
  if (o.type === 'svg') return makeSvgGeometry(state.assets[o.asset], params);
  return makeGeometry(o.type, params);
}

function setBoxUVs(g) {
  const pos = g.attributes.position;
  if (!pos || !pos.count) return;
  if (!g.attributes.normal) g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(boxUVs(pos.array, g.attributes.normal.array), 2));
}

const texBase = new Map(); // asset id -> loaded texture (shared image)
function baseTexture(assetId) {
  let t = texBase.get(assetId);
  if (t) return t;
  const url = state.assets[assetId];
  if (!url) return null;
  t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texBase.set(assetId, t);
  return t;
}

/** Material preset + tint + optional image texture. Cheap when nothing changed. */
function applyLook(o, force = false) {
  const r = ensureRT(o);
  const want = o.tex && state.assets[o.tex] ? o.tex : null;
  const key = JSON.stringify([o.mat, o.color, want, o.texSize]);
  if (!force && r.lookKey === key) return;
  r.lookKey = key;
  applyMaterial(r.material, o.mat, o.color);
  if (want) {
    if (!r.tex || r.texAsset !== want) {
      if (r.tex) r.tex.dispose();
      const b = baseTexture(want);
      r.tex = b ? b.clone() : null;
      r.texAsset = want;
    }
    if (r.tex) {
      const k = 1 / (o.texSize || 0.5);
      r.tex.repeat.set(k, k);
      r.tex.needsUpdate = true;
    }
    r.material.map = r.tex;
  } else {
    if (r.tex) r.tex.dispose();
    r.tex = null;
    r.texAsset = null;
    r.material.map = null;
  }
  r.material.needsUpdate = true;
}

function ensureRT(o) {
  let r = rt.get(o.id);
  if (r) return r;
  const material = new THREE.MeshPhysicalMaterial();
  applyMaterial(material, o.mat, o.color);
  const proxy = new THREE.Mesh(emptyGeo, hitMat);
  proxy.userData.id = o.id;
  const part = new THREE.Mesh(emptyGeo, material);
  const w = new THREE.Mesh(emptyGeo, ghost.wireSel);
  const f = new THREE.Mesh(emptyGeo, ghost.fillNeg);
  w.renderOrder = 10;
  proxy.add(part, w, f);
  partsGroup.add(proxy);
  r = { proxy, part, wire: w, fill: f, geo: null, key: '', material, hiGeo: null, hiKey: '', tex: null, texAsset: null, lookKey: '' };
  rt.set(o.id, r);
  return r;
}

/** Push a part's data into its three.js objects. */
function syncRT(o) {
  const r = ensureRT(o);
  const key = o.type + (o.asset || '') + JSON.stringify(o.params);
  if (r.key !== key) {
    const old = r.geo;
    r.geo = geometryFor(o);
    setBoxUVs(r.geo);
    r.key = key;
    r.proxy.geometry = r.part.geometry = r.wire.geometry = r.fill.geometry = r.geo;
    if (old) old.dispose();
  }
  r.proxy.position.fromArray(o.pos);
  r.proxy.rotation.set(deg2rad(o.rot[0]), deg2rad(o.rot[1]), deg2rad(o.rot[2]), 'XYZ');
  r.proxy.scale.fromArray(o.scl);
  r.proxy.visible = o.visible;
  applyLook(o);
}

/** Leaves whose own cages should show. A selected top-level union shows as one baked shape instead. */
function directLeafSel() {
  const set = new Set();
  for (const id of liveSel()) {
    const n = node(id);
    const u = units.get(id);
    if (n && n.parent == null && u && u.mesh) continue;
    for (const d of descendantIds(id)) set.add(d);
  }
  return set;
}

/** Wireframe cages + fills: blue = selected, red = cutters. */
function syncCages() {
  const direct = directLeafSel();
  for (const o of state.nodes) {
    if (o.kind !== 'part') continue;
    const r = rt.get(o.id);
    if (!r) continue;
    const top = topOf(o.id);
    const sel = direct.has(o.id);
    let cutter = false;
    let showWire = false;
    let showFill = false;
    if (top && top.neg && top.kind === 'part') {
      // a loose cutter part
      cutter = true;
      showWire = true;
      showFill = true;
    } else if (top && top.neg) {
      // inside a negated union: the union's baked red ghost shows instead
      cutter = true;
      showWire = showFill = sel || view.cages;
    } else if (o.neg) {
      // a cutter baked into a union: hidden unless picked directly
      cutter = true;
      showWire = showFill = sel || view.cages;
    } else {
      showWire = sel || view.cages;
    }
    r.wire.material = cutter ? ghost.wireNeg : ghost.wireSel;
    r.wire.visible = showWire;
    r.fill.visible = showFill;
  }
  decorateUnits();
}

const unitSelMat = new THREE.MeshBasicMaterial({
  color: 0x3aa0ff, transparent: true, opacity: 0.16, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
const unitNegMat = new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
const edgeSel = new THREE.LineBasicMaterial({ color: 0x0a7fe0, transparent: true, opacity: 0.9, depthTest: false });
const edgeNeg = new THREE.LineBasicMaterial({ color: 0xe0364a, transparent: true, opacity: 0.9, depthTest: false });

/** Selection tint + crease outline on baked unions, and the red ghost of a negated union. */
function decorateUnits() {
  const sel = new Set(liveSel());
  for (const u of units.values()) {
    const n = node(u.id);
    const shown = !!(u.mesh && u.mesh.visible && n);
    const picked = shown && sel.has(u.id);
    const neg = shown && n.neg;
    if (shown && !u.overlay) {
      u.overlay = new THREE.Mesh(u.mesh.geometry, unitSelMat);
      u.overlay.frustumCulled = false;
      u.overlay.renderOrder = 3;
      resultGroup.add(u.overlay);
    }
    if (u.overlay) {
      if (shown) u.overlay.geometry = u.mesh.geometry;
      u.overlay.visible = picked && !neg;
    }
    if (picked || neg) {
      if (!u.edges) {
        u.edges = new THREE.LineSegments(new THREE.BufferGeometry(), edgeSel);
        u.edges.frustumCulled = false;
        u.edges.renderOrder = 11;
        resultGroup.add(u.edges);
      }
      if (u.edgesFor !== u.mesh.geometry) {
        u.edges.geometry.dispose();
        u.edges.geometry = new THREE.EdgesGeometry(u.mesh.geometry, 40);
        u.edgesFor = u.mesh.geometry;
      }
      u.edges.material = neg ? edgeNeg : edgeSel;
      u.edges.visible = true;
    } else if (u.edges) u.edges.visible = false;
  }
}

/** Which raw part meshes show: only parts whose unit has no combined mesh. */
function syncVisibility() {
  for (const o of state.nodes) {
    if (o.kind !== 'part') continue;
    const r = rt.get(o.id);
    if (!r) continue;
    const top = topOf(o.id);
    if (!view.result) {
      r.part.visible = !o.neg && !(top && top.neg);
    } else if (o.parent != null || o.neg) {
      r.part.visible = false;
    } else {
      const u = units.get(o.id);
      r.part.visible = !(u && u.mesh);
    }
  }
  for (const u of units.values()) {
    if (!u.mesh) continue;
    const n = node(u.id);
    u.mesh.visible = n && n.neg ? true : view.result;
  }
  decorateUnits();
}

function syncAll() {
  for (const o of state.nodes) if (o.kind === 'part') syncRT(o);
  syncCages();
  syncVisibility();
  planeDirty = true;
}

function clearRT() {
  transform.detach();
  for (const r of rt.values()) {
    partsGroup.remove(r.proxy);
    if (r.geo) r.geo.dispose();
    if (r.hiGeo) r.hiGeo.dispose();
    if (r.tex) r.tex.dispose();
    r.material.dispose();
  }
  rt.clear();
  for (const t of texBase.values()) t.dispose();
  texBase.clear();
  for (const u of [...units.values()]) disposeUnit(u);
  units.clear();
}

/* ------------------------------------------------------------------ */
/* gizmo                                                               */
/* ------------------------------------------------------------------ */

function worldMatrixOf(o) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(o.pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(deg2rad(o.rot[0]), deg2rad(o.rot[1]), deg2rad(o.rot[2]), 'XYZ')),
    new THREE.Vector3().fromArray(o.scl)
  );
}

function leafBox(o) {
  const r = rt.get(o.id);
  const box = new THREE.Box3();
  if (!r || !r.geo || !r.geo.attributes.position || !r.geo.attributes.position.count) return box;
  r.proxy.updateMatrixWorld(true);
  return box.setFromObject(r.part, true);
}
function boxOf(leaves) {
  const box = new THREE.Box3();
  for (const o of leaves) box.union(leafBox(o));
  return box;
}

function recenterPivot() {
  const lv = selLeaves().filter((o) => o.visible);
  if (!lv.length) return;
  const c = boxOf(lv).getCenter(new THREE.Vector3());
  pivot.position.copy(c);
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  pivot.updateMatrix();
}

function attachGizmo() {
  const lv = selLeaves().filter((o) => o.visible);
  if (!lv.length) {
    transform.detach();
    return;
  }
  const single = liveSel().length === 1 && lv.length === 1 && !isGroup(node(liveSel()[0]));
  if (single) {
    transform.attach(rt.get(lv[0].id).proxy);
    transform.setSpace(view.mode === 'scale' ? 'local' : 'world');
  } else {
    recenterPivot();
    transform.attach(pivot);
    transform.setSpace('world');
  }
}

let dragStart = null;
transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (e.value) {
    if (transform.object === pivot) {
      pivot.updateMatrix();
      dragStart = {
        inv: pivot.matrix.clone().invert(),
        leaves: selLeaves().map((o) => ({ o, m: worldMatrixOf(o) })),
      };
    }
  } else {
    dragStart = null;
    if (transform.object === pivot) recenterPivot();
    commit();
  }
});

transform.addEventListener('objectChange', () => {
  if (transform.object === pivot && dragStart) {
    pivot.updateMatrix();
    const delta = pivot.matrix.clone().multiply(dragStart.inv);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const eu = new THREE.Euler();
    for (const { o, m } of dragStart.leaves) {
      delta.clone().multiply(m).decompose(p, q, s);
      eu.setFromQuaternion(q, 'XYZ');
      o.pos = [round(p.x), round(p.y), round(p.z)];
      o.rot = [round(rad2deg(eu.x), 2), round(rad2deg(eu.y), 2), round(rad2deg(eu.z), 2)];
      o.scl = [round(Math.max(0.01, s.x)), round(Math.max(0.01, s.y)), round(Math.max(0.01, s.z))];
      syncRT(o);
    }
    requestSolve();
    planeDirty = true;
    return;
  }
  const o = liveSel().length === 1 ? node(liveSel()[0]) : null;
  const r = o && o.kind === 'part' && rt.get(o.id);
  if (!r) return;
  const p = r.proxy;
  p.scale.set(Math.max(0.01, p.scale.x), Math.max(0.01, p.scale.y), Math.max(0.01, p.scale.z));
  o.pos = [round(p.position.x), round(p.position.y), round(p.position.z)];
  o.rot = [round(rad2deg(p.rotation.x), 2), round(rad2deg(p.rotation.y), 2), round(rad2deg(p.rotation.z), 2)];
  o.scl = [round(p.scale.x), round(p.scale.y), round(p.scale.z)];
  updateXformFields(o);
  requestSolve();
  planeDirty = true;
});

/* ------------------------------------------------------------------ */
/* boolean solve + units                                               */
/* ------------------------------------------------------------------ */
/*
 * A "unit" is a top-level solid node: a free positive part, or a top-level
 * union. Free parts render as themselves. Unions are solved with CSG into one
 * mesh. If the node has Round set, the unit is rebuilt by the rounder.
 */

/** id -> { id, sig, brush, mesh, rounded:{srcSig, key, geo, mats}, timer, job } */
const units = new Map();

let dirty = true;
let lastSolve = 0;
let resultTris = 0;
let resultMs = 0;

function requestSolve() {
  dirty = true;
}

function disposeBrush(b) {
  if (!b) return;
  if (b.disposeCacheData) b.disposeCacheData();
  b.geometry.dispose();
}

function sigOf(id) {
  const n = node(id);
  if (!n) return '';
  if (n.kind === 'part') return JSON.stringify([n.type, n.asset || 0, n.params, n.pos, n.rot, n.scl, n.neg ? 1 : 0, n.visible ? 1 : 0]);
  return JSON.stringify([n.mode, n.neg ? 1 : 0, n.visible ? 1 : 0, kidsOf(id).map((k) => sigOf(k.id))]);
}

function partBrush(o, hi = false) {
  const r = rt.get(o.id);
  if (!r || !r.geo || !r.geo.attributes.position || r.geo.attributes.position.count === 0) return null;
  let src = r.geo;
  if (hi) {
    if (r.hiKey !== r.key || !r.hiGeo) {
      if (r.hiGeo) r.hiGeo.dispose();
      r.hiGeo = hiGeometryFor(o);
      setBoxUVs(r.hiGeo);
      r.hiKey = r.key;
    }
    src = r.hiGeo;
  }
  r.proxy.updateMatrix();
  const g = src.clone();
  g.applyMatrix4(r.proxy.matrix);
  return new Brush(g, r.material);
}

/** Evaluate a node into a world-space CSG brush. The caller owns the result. */
function evalNode(id, hi = false) {
  const n = node(id);
  if (!n || !n.visible) return null;
  if (n.kind === 'part') return partBrush(n, hi);
  const solids = [];
  const cutters = [];
  for (const k of kidsOf(id)) {
    const b = evalNode(k.id, hi);
    if (!b) continue;
    (k.neg && n.mode !== 'int' ? cutters : solids).push(b);
  }
  if (!solids.length) {
    cutters.forEach(disposeBrush);
    return null;
  }
  let acc = solids[0];
  const step = (b, op) => {
    const next = evaluator.evaluate(acc, b, op);
    disposeBrush(acc);
    disposeBrush(b);
    acc = next;
  };
  for (let i = 1; i < solids.length; i++) step(solids[i], n.mode === 'int' ? INTERSECTION : ADDITION);
  for (const c of cutters) step(c, SUBTRACTION);
  return acc;
}

function roundActive(n) {
  return !!(n && n.round && (n.round.outer > 0 || n.round.inner > 0));
}

function disposeUnit(u) {
  clearTimeout(u.timer);
  u.job = null;
  if (u.mesh) {
    resultGroup.remove(u.mesh);
    u.mesh = null;
  }
  if (u.overlay) resultGroup.remove(u.overlay);
  if (u.edges) {
    resultGroup.remove(u.edges);
    u.edges.geometry.dispose();
  }
  u.overlay = u.edges = u.edgesFor = null;
  disposeBrush(u.brush);
  u.brush = null;
  if (u.rounded) {
    u.rounded.geo.dispose();
    u.rounded = null;
  }
}

function setUnitMesh(u, geo, material) {
  if (!geo) {
    if (u.mesh) {
      resultGroup.remove(u.mesh);
      u.mesh = null;
    }
    return;
  }
  if (!u.mesh) {
    u.mesh = new THREE.Mesh(geo, material);
    u.mesh.frustumCulled = false;
    resultGroup.add(u.mesh);
  } else {
    u.mesh.geometry = geo;
    u.mesh.material = material;
  }
}

/** Decide what a unit shows right now: raw part, CSG mesh, or rounded mesh. */
function presentUnit(u) {
  const n = node(u.id);
  if (!n) return;
  const want = roundActive(n) && !n.neg;
  const fresh = u.rounded && u.rounded.srcSig === u.sig;
  if (n.neg) {
    setUnitMesh(u, u.brush ? u.brush.geometry : null, unitNegMat);
  } else if (want && fresh) {
    setUnitMesh(u, u.rounded.geo, u.rounded.mats);
  } else if (isGroup(n)) {
    setUnitMesh(u, u.brush ? u.brush.geometry : null, u.brush ? u.brush.material : null);
  } else {
    setUnitMesh(u, null);
  }
  if (u.mesh) u.mesh.visible = n.neg ? true : view.result;
}

function solve() {
  dirty = false;
  lastSolve = performance.now();
  const tops = state.nodes.filter((n) => n.parent == null);
  const alive = new Set();
  for (const n of tops) {
    if (!n.visible || (n.neg && !isGroup(n))) continue;
    alive.add(n.id);
    const sig = sigOf(n.id);
    let u = units.get(n.id);
    if (!u) {
      u = { id: n.id, sig: '', brush: null, mesh: null, rounded: null, timer: 0, job: null };
      units.set(n.id, u);
    }
    if (u.sig !== sig) {
      u.sig = sig;
      if (isGroup(n)) {
        disposeBrush(u.brush);
        u.brush = null;
        try {
          u.brush = evalNode(n.id);
        } catch (err) {
          console.error(err);
          toast('Boolean failed: ' + (err && err.message ? err.message : err));
        }
        if (u.brush && !(u.brush.geometry.attributes.position && u.brush.geometry.attributes.position.count > 0)) {
          disposeBrush(u.brush);
          u.brush = null;
        }
      }
    }
    if (roundActive(n) && !n.neg) scheduleRound(u, n);
    else if (u.rounded) {
      u.rounded.geo.dispose();
      u.rounded = null;
    }
    presentUnit(u);
  }
  for (const [id, u] of [...units]) {
    if (!alive.has(id)) {
      disposeUnit(u);
      units.delete(id);
    }
  }
  syncVisibility();
  syncCages();
  resultMs = performance.now() - lastSolve;
  tallyStats();
}

function triCount(g) {
  return Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
}

function tallyStats() {
  let t = 0;
  for (const n of state.nodes) {
    if (n.kind !== 'part' || n.parent != null || n.neg || !n.visible) continue;
    const u = units.get(n.id);
    const r = rt.get(n.id);
    if (u && u.mesh) continue;
    if (r && r.geo && r.geo.attributes.position) t += triCount(r.geo);
  }
  for (const u of units.values()) {
    const n = node(u.id);
    if (u.mesh && n && !n.neg) t += triCount(u.mesh.geometry);
  }
  resultTris = t;
  updateStats();
}

function updateStats() {
  const busy = roundBusy() ? ' · rounding…' : '';
  el.stats.textContent = `${resultTris.toLocaleString()} tris · ${resultMs.toFixed(0)} ms${busy}`;
}

/* ------------------------------------------------------------------ */
/* edge rounding (worker, with main-thread fallback)                   */
/* ------------------------------------------------------------------ */

let worker = null;
let workerBroken = typeof Worker === 'undefined';
let jobCounter = 0;
const jobs = new Map(); // job id -> { unitId, srcSig, opts, mats }

function roundBusy() {
  if (jobs.size) return true;
  for (const u of units.values()) if (u.timer) return true;
  return false;
}

function getWorker() {
  if (workerBroken) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./round-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (e.data.progress !== undefined) setProgress(e.data.job, e.data.progress);
        else finishJob(e.data.job, e.data.result, e.data.error);
      };
      worker.onerror = () => {
        workerBroken = true;
        worker = null;
        const pending = [...jobs.entries()];
        for (const [id, j] of pending) runJobHere(id, j);
      };
    } catch (err) {
      workerBroken = true;
      worker = null;
    }
  }
  return worker;
}

function runJobHere(id, j) {
  setTimeout(() => {
    try {
      finishJob(id, roundMesh(j.opts), null);
    } catch (err) {
      finishJob(id, null, String(err && err.message ? err.message : err));
    }
  }, 20);
}

/** World-space triangle soup + per-triangle material index for a unit. */
function unitSoup(u) {
  const n = node(u.id);
  let geo;
  let mats;
  let matrix = null;
  let tmp = null;
  if (isGroup(n)) {
    try {
      tmp = evalNode(n.id, true);
    } catch (err) {
      tmp = null;
    }
    const b = tmp || u.brush;
    if (!b) return null;
    geo = b.geometry;
    mats = Array.isArray(b.material) ? b.material : [b.material];
  } else {
    const r = rt.get(n.id);
    if (!r || !r.geo || !r.geo.attributes.position) return null;
    tmp = partBrush(n, true);
    geo = tmp ? tmp.geometry : r.geo;
    mats = [r.material];
    if (!tmp) {
      r.proxy.updateMatrix();
      matrix = r.proxy.matrix;
    }
  }
  const pos = geo.attributes.position;
  const index = geo.index;
  const triN = index ? index.count / 3 : pos.count / 3;
  const positions = new Float32Array(triN * 9);
  const triMat = new Uint16Array(triN);
  const v = new THREE.Vector3();
  const groups = geo.groups && geo.groups.length ? geo.groups : null;
  let gi = 0;
  for (let t = 0; t < triN; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = index ? index.getX(t * 3 + c) : t * 3 + c;
      v.fromBufferAttribute(pos, vi);
      if (matrix) v.applyMatrix4(matrix);
      positions[t * 9 + c * 3] = v.x;
      positions[t * 9 + c * 3 + 1] = v.y;
      positions[t * 9 + c * 3 + 2] = v.z;
    }
    if (groups) {
      const at = t * 3;
      while (gi < groups.length - 1 && at >= groups[gi].start + groups[gi].count) gi++;
      triMat[t] = Math.min(groups[gi].materialIndex || 0, mats.length - 1);
    }
  }
  disposeBrush(tmp);
  return { positions, triMat, mats };
}

function scheduleRound(u, n) {
  const key = JSON.stringify(n.round);
  const wanted = u.sig + '|' + key;
  if (u.rounded && u.rounded.key === wanted) return;
  if (u.job && u.job.wanted === wanted) return;
  clearTimeout(u.timer);
  u.timer = setTimeout(() => {
    u.timer = 0;
    startRound(u, wanted);
    updateStats();
  }, 280);
}

function startRound(u, wanted) {
  const n = node(u.id);
  if (!n || !roundActive(n) || u.sig + '|' + JSON.stringify(n.round) !== wanted) return;
  const soup = unitSoup(u);
  if (!soup) return;
  const jobId = ++jobCounter;
  const opts = {
    positions: soup.positions,
    triMat: soup.triMat,
    outer: n.round.outer,
    inner: n.round.inner,
    resolution: n.round.res,
    sand: n.round.sand,
  };
  u.job = { id: jobId, wanted };
  jobs.set(jobId, { unitId: u.id, srcSig: u.sig, wanted, opts, mats: soup.mats });
  const w = getWorker();
  setProgress(jobId, 0.02);
  if (w) w.postMessage({ job: jobId, opts }, [opts.positions.buffer, opts.triMat.buffer]);
  else runJobHere(jobId, jobs.get(jobId));
}

function finishJob(jobId, result, error) {
  const j = jobs.get(jobId);
  jobs.delete(jobId);
  if (!j) return;
  const u = units.get(j.unitId);
  if (u && u.job && u.job.id === jobId) u.job = null;
  if (error) {
    toast('Rounding failed: ' + error);
  } else if (u && u.sig === j.srcSig) {
    if (!result) {
      toast('Nothing to round on that shape.');
    } else if (result.empty) {
      toast('That radius is bigger than the shape. Lower it.');
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
      if (result.uvs) g.setAttribute('uv', new THREE.BufferAttribute(result.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(result.index, 1));
      for (const gr of result.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      g.computeBoundingSphere();
      if (u.rounded) u.rounded.geo.dispose();
      u.rounded = { srcSig: j.srcSig, key: j.wanted, geo: g, mats: j.mats.length === 1 ? j.mats[0] : j.mats };
      if (j.mats.length === 1) {
        // single material: drop groups so it renders as one mesh
        g.clearGroups();
      }
      if (result.stats && result.stats.warnSmall) toast('Radius is under 1.5 voxels. Raise Quality for a cleaner round.');
      presentUnit(u);
      syncVisibility();
      syncCages();
      tallyStats();
    }
  }
  if (!jobs.size) setProgress(null);
  updateStats();
  refreshRoundStatus();
}

/* Win7-style progress bar in the status bar */
let progressJob = 0;
function setProgress(job, p) {
  const bar = el.progress;
  if (!bar) return;
  if (job === null || p === null || p === undefined) {
    bar.hidden = true;
    progressJob = 0;
    return;
  }
  if (job < progressJob) return; // only follow the newest job
  progressJob = job;
  bar.hidden = false;
  bar.querySelector('.pfill').style.width = `${Math.round(clamp(p, 0.02, 1) * 100)}%`;
  bar.querySelector('.plabel').textContent = `Rounding ${Math.round(p * 100)}%`;
}

function refreshRoundStatus() {
  const s = $('#round-status');
  if (s) s.textContent = roundBusy() ? 'Rounding…' : '';
}

async function settleRounds() {
  for (let i = 0; i < 1200 && roundBusy(); i++) await sleep(50);
}

/* ------------------------------------------------------------------ */
/* history + autosave                                                  */
/* ------------------------------------------------------------------ */

const hist = { stack: [], i: -1 };

function projectData() {
  return { app: 'meshtype', version: VERSION, name: state.name, nextId: state.nextId, nodes: state.nodes, assets: state.assets, floor: state.floor };
}

function snapshot() {
  return JSON.stringify({ ...projectData(), sel: state.sel, active: state.active });
}

function gcAssets() {
  const used = new Set();
  for (const n of state.nodes) {
    if (n.asset) used.add(n.asset);
    if (n.tex) used.add(n.tex);
  }
  for (const k of Object.keys(state.assets)) if (!used.has(k)) delete state.assets[k];
}

function commit() {
  gcAssets();
  const s = snapshot();
  if (hist.stack[hist.i] === s) return;
  hist.stack = hist.stack.slice(0, hist.i + 1);
  hist.stack.push(s);
  if (hist.stack.length > 80) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  try {
    localStorage.setItem(STORE_KEY, s);
  } catch (e) {
    /* storage unavailable, autosave skipped */
  }
  updateHistoryButtons();
}

function updateHistoryButtons() {
  el.undo.disabled = hist.i <= 0;
  el.redo.disabled = hist.i >= hist.stack.length - 1;
}

function undo() {
  if (hist.i <= 0) return;
  hist.i--;
  restore(JSON.parse(hist.stack[hist.i]));
  persist();
}

function redo() {
  if (hist.i >= hist.stack.length - 1) return;
  hist.i++;
  restore(JSON.parse(hist.stack[hist.i]));
  persist();
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, hist.stack[hist.i]);
  } catch (e) {
    /* ignore */
  }
  updateHistoryButtons();
}

/** Replace the whole document from plain data. */
function restore(data) {
  clearRT();
  const p = sanitizeProject(data);
  const ids = new Set(p.nodes.map((n) => n.id));
  const sel = (Array.isArray(data.sel) ? data.sel : data.selected != null ? [data.selected] : []).filter((id) => ids.has(id));
  state = {
    name: String(data.name || 'untitled').slice(0, 60),
    nodes: p.nodes,
    assets: p.assets,
    sel,
    active: ids.has(data.active) && sel.includes(data.active) ? data.active : sel[sel.length - 1] ?? null,
    nextId: p.nextId,
    floor: sanitizeFloor(data.floor),
  };
  el.name.value = state.name;
  syncFloor();
  renderFloorPanel();
  syncAll();
  attachGizmo();
  requestSolve();
  refreshUI();
  if (p.migrated && p.nodes.length > 1) toast('Opened an older project. Its layers are now one union; cutters became red parts.');
}

/* ------------------------------------------------------------------ */
/* selection                                                           */
/* ------------------------------------------------------------------ */

function setSel(ids, active) {
  const seen = new Set();
  state.sel = ids.filter((id) => node(id) && !seen.has(id) && seen.add(id));
  state.active = state.sel.includes(active) ? active : state.sel[state.sel.length - 1] ?? null;
  syncCages();
  attachGizmo();
  refreshUI();
  planeDirty = true;
}
const selectOnly = (id) => setSel(id == null ? [] : [id], id);
function toggleSel(id) {
  if (state.sel.includes(id)) setSel(state.sel.filter((x) => x !== id), state.active);
  else setSel([...state.sel, id], id);
}

/* ------------------------------------------------------------------ */
/* editing actions                                                     */
/* ------------------------------------------------------------------ */

function afterEdit({ keepGizmo = false } = {}) {
  syncAll();
  if (!keepGizmo) attachGizmo();
  requestSolve();
  commit();
  refreshUI();
}

function newPart(spec) {
  const o = sanitizePart({ id: state.nextId++, ...spec });
  state.nodes.push(o);
  return o;
}

function addObject(presetId) {
  const p = PRESETS[presetId];
  if (!p) return;
  const id = state.nextId;
  const o = newPart({ name: `${p.label} ${id}`, type: p.type, params: p.params, scl: p.scl, mat: 'glass' });
  state.sel = [o.id];
  state.active = o.id;
  afterEdit();
}

function unselectedChildrenFix() {
  // drop empty groups left behind by deletes / splits
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of state.nodes.filter((n) => n.kind === 'group')) {
      if (!kidsOf(g.id).length) {
        state.nodes = state.nodes.filter((n) => n !== g);
        changed = true;
      }
    }
  }
  const ids = new Set(state.nodes.map((n) => n.id));
  state.sel = state.sel.filter((id) => ids.has(id));
  if (!state.sel.includes(state.active)) state.active = state.sel[state.sel.length - 1] ?? null;
}

function removeNodes(ids) {
  const all = new Set();
  for (const id of ids) for (const d of descendantIds(id)) all.add(d);
  for (const id of all) {
    const r = rt.get(id);
    if (r) {
      partsGroup.remove(r.proxy);
      if (r.geo) r.geo.dispose();
      r.material.dispose();
      rt.delete(id);
    }
  }
  state.nodes = state.nodes.filter((n) => !all.has(n.id));
  unselectedChildrenFix();
}

function deleteSelection() {
  const ids = liveSel();
  if (!ids.length) return;
  transform.detach();
  removeNodes(ids);
  afterEdit();
}

function duplicateSelection() {
  const tops = uniqueTops();
  if (!tops.length) return;
  const copies = [];
  const clone = (src, parent, offset) => {
    const raw = JSON.parse(JSON.stringify(src));
    raw.id = state.nextId++;
    raw.parent = parent;
    if (offset) raw.name = `${src.name} copy`;
    const c = src.kind === 'group' ? sanitizeGroup(raw) : sanitizePart(raw);
    if (c.kind === 'part' && offset) c.pos = [round(c.pos[0] + 0.15), c.pos[1], round(c.pos[2] + 0.15)];
    if (c.kind === 'part' && !offset) c.pos = [...src.pos].map((v, i) => (i === 0 || i === 2 ? round(v + 0.15) : v));
    state.nodes.push(c);
    if (src.kind === 'group') for (const k of kidsOf(src.id)) clone(k, c.id, false);
    return c;
  };
  for (const t of tops) copies.push(clone(t, null, true).id);
  state.sel = copies;
  state.active = copies[copies.length - 1];
  afterEdit();
}

function toggleVisible(id) {
  const n = node(id);
  if (!n) return;
  n.visible = !n.visible;
  afterEdit();
}

function hideSelection() {
  const ids = liveSel();
  if (!ids.length) return;
  const anyVisible = ids.some((id) => node(id).visible);
  for (const id of ids) node(id).visible = !anyVisible;
  afterEdit();
}

/* --- the three main buttons --- */

function doUnion(mode = 'union') {
  const tops = uniqueTops();
  if (tops.length < 2) {
    toast(`Pick two or more things first (Ctrl or Shift + click), then ${mode === 'int' ? 'INTERSECT' : 'UNION'}.`);
    return;
  }
  const id = state.nextId++;
  const allCutters = tops.every((t) => t.neg);
  const g = sanitizeGroup({ id, name: `${mode === 'int' ? 'Intersect' : 'Union'} ${id}`, mode });
  if (allCutters) {
    // a union of cutters is itself one cutter
    g.neg = true;
    for (const t of tops) t.neg = false;
  }
  let dropped = false;
  for (const t of tops) {
    if (t.round) {
      delete t.round;
      dropped = true;
    }
    t.parent = id;
  }
  const first = Math.min(...tops.map((t) => state.nodes.indexOf(t)));
  state.nodes.splice(first, 0, g);
  state.sel = [id];
  state.active = id;
  afterEdit();
  if (dropped) toast('Round settings on the parts were cleared. Round the finished union instead.');
}

function doNegate() {
  const ids = liveSel();
  if (!ids.length) {
    toast('Select something to negate.');
    return;
  }
  const nodes = ids.map(node);
  const makeNeg = nodes.some((n) => !n.neg);
  for (const n of nodes) {
    n.neg = makeNeg;
    if (makeNeg && n.round) delete n.round;
  }
  afterEdit({ keepGizmo: true });
}

function dissolve(id) {
  const g = node(id);
  if (!isGroup(g)) return;
  for (const k of kidsOf(id)) {
    if (g.neg) k.neg = true;
    k.parent = g.parent;
    if (isGroup(k)) dissolve(k.id);
  }
  state.nodes = state.nodes.filter((n) => n !== g);
}

function doSplit() {
  const groups = uniqueTops().filter(isGroup);
  const sel = liveSel();
  let targets = groups;
  if (!sel.length) targets = state.nodes.filter((n) => n.kind === 'group' && n.parent == null);
  // a child group picked straight from the list also counts
  for (const id of sel) {
    const n = node(id);
    if (isGroup(n) && !targets.includes(n) && n.parent != null) targets.push(n);
  }
  if (!targets.length) {
    toast(sel.length ? 'Nothing to split: that is not a union.' : 'There are no unions to split.');
    return;
  }
  const out = [];
  for (const g of targets) {
    for (const l of leavesOf(g.id)) out.push(l.id);
    dissolve(g.id);
  }
  state.sel = out;
  state.active = out[out.length - 1] ?? null;
  unselectedChildrenFix();
  afterEdit();
}

/* --- arrange --- */

function shiftLeaves(leaves, d) {
  for (const o of leaves) {
    o.pos = [round(o.pos[0] + d.x), round(o.pos[1] + d.y), round(o.pos[2] + d.z)];
  }
}

function doCenter() {
  const leaves = selLeaves().filter((o) => o.visible);
  if (!leaves.length) return toast('Select something to center.');
  const c = boxOf(leaves).getCenter(new THREE.Vector3());
  const d = new THREE.Vector3(view.center.x ? -c.x : 0, view.center.y ? -c.y : 0, view.center.z ? -c.z : 0);
  if (d.lengthSq() === 0) return toast('Already centered.');
  shiftLeaves(leaves, d);
  afterEdit();
}

function alignUnits() {
  return uniqueTops()
    .map((t) => {
      const leaves = leavesOf(t.id).filter((o) => o.visible);
      return { t, leaves, box: boxOf(leaves) };
    })
    .filter((u) => u.leaves.length);
}

function edgeValue(box, axis, edge) {
  if (edge === 'min') return box.min[axis];
  if (edge === 'max') return box.max[axis];
  return (box.min[axis] + box.max[axis]) / 2;
}

function alignTarget(us, a) {
  const vals = us.map((u) => edgeValue(u.box, a.axis, a.edge));
  if (a.target === 'world') return 0;
  if (a.target === 'min') return Math.min(...vals);
  if (a.target === 'max') return Math.max(...vals);
  if (a.target === 'active') {
    const top = topOf(state.active);
    const i = us.findIndex((u) => top && u.t.id === top.id);
    return vals[i >= 0 ? i : vals.length - 1];
  }
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function doAlign() {
  const a = view.align;
  if (!a.axis) return toast('Pick an axis first (X, Y or Z). The blue plane shows where things will land.');
  const us = alignUnits();
  if (!us.length) return toast('Select something to align.');
  if (us.length < 2 && a.target !== 'world') return toast('Select two or more things, or align to World 0.');
  const target = alignTarget(us, a);
  let moved = false;
  for (const u of us) {
    const dv = target - edgeValue(u.box, a.axis, a.edge);
    if (Math.abs(dv) < 1e-6) continue;
    const d = new THREE.Vector3();
    d[a.axis] = dv;
    shiftLeaves(u.leaves, d);
    moved = true;
  }
  if (!moved) return toast('Already aligned.');
  afterEdit();
}

let planeDirty = true;
function updateAlignPlane() {
  planeDirty = false;
  const a = view.align;
  const us = a.axis ? alignUnits() : [];
  if (!a.axis || !us.length) {
    planeMesh.visible = false;
    return;
  }
  const target = alignTarget(us, a);
  const all = new THREE.Box3();
  for (const u of us) all.union(u.box);
  const c = all.getCenter(new THREE.Vector3());
  const size = all.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.5) * 1.5 + 0.4;
  planeMesh.visible = true;
  planeMesh.scale.set(span, span, 1);
  planeMesh.rotation.set(0, 0, 0);
  if (a.axis === 'x') {
    planeMesh.rotation.y = Math.PI / 2;
    planeMesh.position.set(target, c.y, c.z);
  } else if (a.axis === 'y') {
    planeMesh.rotation.x = Math.PI / 2;
    planeMesh.position.set(c.x, target, c.z);
  } else {
    planeMesh.position.set(c.x, c.y, target);
  }
}

/* --- SVG import --- */

async function importSvgText(text, filename) {
  if (text.length > 2_000_000) return toast('That SVG is over 2 MB. Simplify it first.');
  const info = inspectSvg(text);
  if (!info.ok) return toast(info.message);
  const assetId = `svg${state.nextId}`;
  state.assets[assetId] = text;
  const base = String(filename || 'svg').replace(/\.svg$/i, '').slice(0, 40);
  const o = newPart({ name: base, type: 'svg', asset: assetId, params: { depth: 0.3, detail: 2 }, mat: 'gloss' });
  state.sel = [o.id];
  state.active = o.id;
  afterEdit();
  toast(`Imported ${base}: ${info.shapes} shape${info.shapes === 1 ? '' : 's'}. Use Round to soften the edges.`);
}

async function importSvgFile(file) {
  try {
    await importSvgText(await file.text(), file.name);
  } catch (err) {
    toast('Could not import that SVG: ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* UI rendering                                                        */
/* ------------------------------------------------------------------ */

function refreshUI() {
  renderList();
  renderInspector();
  renderBoolButtons();
  el.empty.hidden = state.nodes.length > 0;
  updateHistoryButtons();
}

function renderBoolButtons() {
  const tops = uniqueTops();
  const sel = liveSel();
  el.union.disabled = tops.length < 2;
  el.intersect.disabled = tops.length < 2;
  el.negate.disabled = sel.length < 1;
  const allNeg = sel.length > 0 && sel.every((id) => node(id).neg);
  el.negate.setAttribute('aria-pressed', String(allNeg));
  const anyGroup = sel.some((id) => uniqueTops([id]).some(isGroup) || isGroup(node(id)));
  const anyGroupInScene = state.nodes.some(isGroup);
  el.split.disabled = sel.length ? !anyGroup : !anyGroupInScene;
}

function iconFor(n) {
  if (n.kind === 'group') return n.neg ? 'i-group-neg' : 'i-group';
  return n.neg ? 'i-cutter' : 'i-solid';
}

function renderList() {
  const rows = [];
  const selSet = new Set(liveSel());
  const emit = (n, depth) => {
    const isSel = selSet.has(n.id);
    const chip = n.kind === 'group' ? (n.mode === 'int' ? 'INTERSECT' : n.neg ? 'CUTTER' : 'UNION') : n.neg ? 'CUTTER' : 'SOLID';
    const chipCls = n.neg ? 'neg' : n.kind === 'group' ? 'grp' : 'pos';
    rows.push(`<li class="row d${Math.min(depth, 3)} ${isSel ? 'sel' : ''} ${n.visible ? '' : 'off'}" data-id="${n.id}">
  <button type="button" class="eye" data-act="vis" title="${n.visible ? 'Hide' : 'Show'}" aria-label="${n.visible ? 'Hide' : 'Show'} ${esc(n.name)}">${n.visible ? '◉' : '○'}</button>
  <svg class="rico" aria-hidden="true"><use href="#${iconFor(n)}"/></svg>
  <span class="nm">${esc(n.name)}</span><span class="chip ${chipCls}">${chip}</span>
</li>`);
    for (const k of kidsOf(n.id)) emit(k, depth + 1);
  };
  for (const n of state.nodes) if (n.parent == null) emit(n, 0);
  el.list.innerHTML = rows.join('');
}

function sliderHTML(o, [key, label, min, max, step]) {
  const val = o.params[key];
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `<label class="sl"><span class="lb">${label}</span><output id="out-${key}">${val.toFixed(dec)}</output>
<input type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
}

function xformRow(o, label, key, step) {
  const cells = [0, 1, 2]
    .map((i) => `<input type="number" step="${step}" data-t="${key}" data-i="${i}" value="${fmt(o[key][i], 3)}" aria-label="${label} ${'XYZ'[i]}">`)
    .join('');
  return `<div class="xrow"><span>${label}</span>${cells}</div>`;
}

function arrangeHTML() {
  const a = view.align;
  const axisBtns = ['x', 'y', 'z']
    .map((ax) => `<button type="button" data-axis="${ax}" aria-pressed="${a.axis === ax}">${ax.toUpperCase()}</button>`)
    .join('');
  const cChk = ['x', 'y', 'z']
    .map((ax) => `<label class="chk"><input type="checkbox" data-caxis="${ax}" ${view.center[ax] ? 'checked' : ''}> ${ax.toUpperCase()}</label>`)
    .join('');
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  return `<h2>Arrange</h2>
<div class="field"><span class="lbl">Center in world</span>
  <div class="inline">${cChk}<button type="button" data-act="center">Center</button></div></div>
<div class="field"><span class="lbl">Align on axis <span class="sub">(shows the target plane)</span></span>
  <div class="seg axis">${axisBtns}</div>
  <div class="two">
    <select id="al-edge" aria-label="Which edge">${opt('min', a.edge, 'Min edge')}${opt('center', a.edge, 'Center')}${opt('max', a.edge, 'Max edge')}</select>
    <select id="al-target" aria-label="Align to">${opt('avg', a.target, 'to Average')}${opt('active', a.target, 'to Active')}${opt('min', a.target, 'to Lowest')}${opt('max', a.target, 'to Highest')}${opt('world', a.target, 'to World 0')}</select>
  </div>
  <button type="button" class="wide" data-act="align">Align</button></div>`;
}

function roundHTML(n) {
  const r = n.round || { outer: 0, inner: 0, res: 64, sand: 3 };
  const top = n.parent == null;
  if (!top) return '<h2>Round edges</h2><p class="tip">Rounding is applied to a finished top-level part or union. Select the union.</p>';
  if (n.neg) return '<h2>Round edges</h2><p class="tip">Cutters are not rounded. Round the union they are part of.</p>';
  const q = QUALITY.map(([v, l]) => `<option value="${v}" ${String(r.res) === v ? 'selected' : ''}>${l}</option>`).join('');
  return `<h2>Round edges <span id="round-status" class="sub"></span></h2>
<label class="sl"><span class="lb">Outer edges (convex)</span><output id="out-outer">${r.outer.toFixed(3)}</output>
<input type="range" data-round="outer" min="0" max="0.4" step="0.005" value="${r.outer}"></label>
<label class="sl"><span class="lb">Inner edges (concave)</span><output id="out-inner">${r.inner.toFixed(3)}</output>
<input type="range" data-round="inner" min="0" max="0.4" step="0.005" value="${r.inner}"></label>
<div class="field"><span class="lbl">Quality</span><select id="f-rq" aria-label="Rounding quality">${q}</select></div>
<label class="sl"><span class="lb">Sander (smooths ripples)</span><output id="out-sand">${(r.sand ?? 3).toFixed(0)}</output>
<input type="range" data-round="sand" min="0" max="10" step="1" value="${r.sand ?? 3}"></label>
<p class="tip">Rebuilds the shape as a smooth mesh. Inner edges are where shapes meet or a cut ends.</p>`;
}

/** Material, tint and texture. For a union this edits every part inside it. */
function lookHTML(leaves) {
  if (!leaves.length) return '';
  const first = leaves[0];
  const same = (k) => leaves.every((o) => o[k] === first[k]);
  const mixed = !same('mat');
  const matOptions =
    (mixed ? '<option value="" selected>Mixed</option>' : '') +
    Object.entries(MATERIALS)
      .map(([k, m]) => `<option value="${k}" ${!mixed && first.mat === k ? 'selected' : ''}>${m.label}</option>`)
      .join('');
  const anyTex = leaves.some((o) => o.tex);
  const size = (leaves.find((o) => o.tex) || first).texSize || 0.5;
  return `<h2>Material${leaves.length > 1 ? ` <span class="sub">(all ${leaves.length} parts)</span>` : ''}</h2>
<div class="matrow"><select id="f-mat" aria-label="Material">${matOptions}</select><input id="f-color" type="color" value="${first.color}" aria-label="Tint color"></div>
<div class="field texrow"><span class="lbl">Texture</span>
  <div class="inline"><button type="button" data-act="tex">${anyTex ? 'Change image…' : 'Image…'}</button>${anyTex ? '<button type="button" data-act="tex-clear">Remove</button>' : ''}</div></div>
${anyTex ? `<label class="sl"><span class="lb">Tile size</span><output id="out-texsize">${size.toFixed(2)}</output>
<input type="range" data-texsize="1" min="0.05" max="4" step="0.05" value="${size}"></label>` : ''}`;
}

function renderInspector() {
  const sel = liveSel();
  if (!sel.length) {
    el.inspector.innerHTML = '<h2>Inspector</h2><p class="hint">Click a shape in the list or the viewport. Ctrl or Shift + click to pick several.</p>';
    return;
  }
  if (sel.length > 1) {
    const leaves = selLeaves().length;
    el.inspector.innerHTML = `<h2>${sel.length} selected</h2>
<p class="hint">${leaves} part${leaves === 1 ? '' : 's'}. Drag the gizmo to move them together.</p>
${arrangeHTML()}
<div class="acts"><button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del" class="danger">Delete</button></div>`;
    return;
  }
  const n = node(sel[0]);
  const kind = n.neg ? 'Cutter' : 'Solid';
  const head = `<h2>${isGroup(n) ? (n.mode === 'int' ? 'Intersection' : 'Union') : 'Part'}</h2>
<div class="field"><input id="f-name" type="text" maxlength="60" value="${esc(n.name)}" aria-label="Name" spellcheck="false"></div>
<div class="field"><span class="lbl">State</span><div class="seg wide2">
  <button type="button" data-set-neg="0" aria-pressed="${!n.neg}">Solid</button>
  <button type="button" data-set-neg="1" aria-pressed="${n.neg}" class="negbtn">Cutter</button></div></div>`;
  void kind;
  if (isGroup(n)) {
    const ks = kidsOf(n.id);
    const cut = ks.filter((k) => k.neg).length;
    el.inspector.innerHTML = `${head}
<p class="hint">${n.mode === 'int' ? 'Keeps only where its parts overlap.' : `${ks.length - cut} solid${ks.length - cut === 1 ? '' : 's'} blended${cut ? `, ${cut} cutter${cut === 1 ? '' : 's'} subtracted` : ''}.`}
Click a part in the list to edit it, or SPLIT to take it apart.</p>
${lookHTML(leavesOf(n.id))}
${n.parent == null ? roundHTML(n) : ''}
${arrangeHTML()}
<div class="acts"><button type="button" data-act="split">Split</button><button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del" class="danger">Delete</button></div>`;
    return;
  }
  const sliders = SHAPE_UI[n.type].map((s) => sliderHTML(n, s)).join('');
  const tip = n.type === 'squircle' ? '<p class="tip">n = 2 is round, n = 4 is a classic squircle, higher gets boxier.</p>' : '';
  el.inspector.innerHTML = `${head}
<h2>Shape</h2>
${sliders}${tip}
<h2>Transform</h2>
${xformRow(n, 'Move', 'pos', 0.05)}${xformRow(n, 'Rotate°', 'rot', 5)}${xformRow(n, 'Scale', 'scl', 0.05)}
${lookHTML([n])}
${roundHTML(n)}
${arrangeHTML()}
<div class="acts"><button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del" class="danger">Delete</button></div>`;
}

function updateXformFields(o) {
  for (const input of el.inspector.querySelectorAll('input[data-t]')) {
    if (document.activeElement === input) continue;
    input.value = fmt(o[input.dataset.t][Number(input.dataset.i)], 3);
  }
}

/* ------------------------------------------------------------------ */
/* UI events                                                           */
/* ------------------------------------------------------------------ */

document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addObject(b.dataset.add)));
el.union.addEventListener('click', () => doUnion('union'));
el.intersect.addEventListener('click', () => doUnion('int'));
el.negate.addEventListener('click', doNegate);
el.split.addEventListener('click', doSplit);

function clickRow(e, id) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSel(id);
  else selectOnly(id);
}

el.list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  if (e.target.closest('[data-act="vis"]')) {
    toggleVisible(id);
    return;
  }
  clickRow(e, id);
});

el.list.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const li = e.target.closest('li[data-id]');
  if (li) {
    const id = Number(li.dataset.id);
    if (!state.sel.includes(id)) selectOnly(id);
  }
  openMenu(e.clientX, e.clientY);
});

el.inspector.addEventListener('input', (e) => {
  const t = e.target;
  const n = state.sel.length === 1 ? node(state.sel[0]) : null;
  if (t.dataset.round && n) {
    const out = $(`#out-${t.dataset.round}`);
    if (out) out.textContent = parseFloat(t.value).toFixed(t.dataset.round === 'sand' ? 0 : 3);
    return;
  }
  if (n && (t.id === 'f-color' || t.dataset.texsize)) {
    for (const o of leavesOf(n.id)) {
      if (t.id === 'f-color') o.color = t.value;
      else o.texSize = parseFloat(t.value);
      applyLook(o);
    }
    if (t.dataset.texsize) {
      const out = $('#out-texsize');
      if (out) out.textContent = parseFloat(t.value).toFixed(2);
    }
    return;
  }
  if (!n || n.kind !== 'part') {
    if (t.id === 'f-name' && n) {
      n.name = t.value.slice(0, 60);
      renderList();
    }
    return;
  }
  if (t.dataset.param) {
    const key = t.dataset.param;
    const val = parseFloat(t.value);
    n.params[key] = val;
    const step = Number(t.step);
    const out = $(`#out-${key}`);
    if (out) out.textContent = val.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
    syncRT(n);
    requestSolve();
    planeDirty = true;
  } else if (t.id === 'f-name') {
    n.name = t.value.slice(0, 60);
    renderList();
  } else if (t.id === 'f-color') {
    n.color = t.value;
    applyLook(n);
  }
});

el.inspector.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.caxis) {
    view.center[t.dataset.caxis] = t.checked;
    return;
  }
  if (t.id === 'al-edge') {
    view.align.edge = t.value;
    planeDirty = true;
    return;
  }
  if (t.id === 'al-target') {
    view.align.target = t.value;
    planeDirty = true;
    return;
  }
  const n = state.sel.length === 1 ? node(state.sel[0]) : null;
  if (!n) return;
  if (t.dataset.round || t.id === 'f-rq') {
    const cur = n.round || { outer: 0, inner: 0, res: 64, sand: 3 };
    const next = { ...cur };
    if (t.dataset.round) next[t.dataset.round] = parseFloat(t.value);
    else next.res = parseInt(t.value, 10);
    const rd = sanitizeRound(next);
    if (rd) n.round = rd;
    else delete n.round;
    afterEdit({ keepGizmo: true });
    return;
  }
  if (t.dataset.param || t.id === 'f-name' || t.id === 'f-color' || t.dataset.texsize) {
    commit();
  } else if (t.dataset.t && n.kind === 'part') {
    const key = t.dataset.t;
    const i = Number(t.dataset.i);
    let v = parseFloat(t.value);
    if (!Number.isFinite(v)) v = n[key][i];
    if (key === 'scl') v = Math.max(0.01, v);
    n[key][i] = v;
    t.value = fmt(v, 3);
    syncRT(n);
    requestSolve();
    planeDirty = true;
    commit();
  } else if (t.id === 'f-mat' && MATERIALS[t.value]) {
    for (const o of leavesOf(n.id)) {
      o.mat = t.value;
      o.color = MATERIALS[o.mat].color;
      applyLook(o);
    }
    const colorInput = $('#f-color');
    if (colorInput) colorInput.value = MATERIALS[t.value].color;
    commit();
  }
});

el.inspector.addEventListener('click', (e) => {
  const axisBtn = e.target.closest('[data-axis]');
  if (axisBtn) {
    const ax = axisBtn.dataset.axis;
    view.align.axis = view.align.axis === ax ? null : ax;
    el.inspector.querySelectorAll('[data-axis]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.axis === view.align.axis)));
    planeDirty = true;
    return;
  }
  const setNeg = e.target.closest('[data-set-neg]');
  if (setNeg) {
    const n = node(state.sel[0]);
    if (n) {
      n.neg = setNeg.dataset.setNeg === '1';
      if (n.neg && n.round) delete n.round;
      afterEdit({ keepGizmo: true });
    }
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  runAction(act.dataset.act);
});

function runAction(a) {
  if (a === 'dup') duplicateSelection();
  else if (a === 'del') deleteSelection();
  else if (a === 'center') doCenter();
  else if (a === 'align') doAlign();
  else if (a === 'split') doSplit();
  else if (a === 'union') doUnion('union');
  else if (a === 'int') doUnion('int');
  else if (a === 'negate') doNegate();
  else if (a === 'hide') hideSelection();
  else if (a === 'all') setSel(state.nodes.filter((n) => n.parent == null).map((n) => n.id), state.active);
  else if (a === 'none') selectOnly(null);
  else if (a === 'frame') frameSelected();
  else if (a === 'rename') {
    const f = $('#f-name');
    if (f) {
      f.focus();
      f.select();
    }
  } else if (a === 'svg') el.fileSvg.click();
  else if (a === 'tex') el.fileTex.click();
  else if (a === 'tex-clear') {
    const n = state.sel.length === 1 ? node(state.sel[0]) : null;
    if (n) {
      for (const o of leavesOf(n.id)) {
        delete o.tex;
        applyLook(o);
      }
      commit();
      renderInspector();
    }
  }
  else if (a.startsWith('add:')) addObject(a.slice(4));
  else if (a.startsWith('axis:')) {
    view.align.axis = a.slice(5);
    planeDirty = true;
    renderInspector();
  }
}

el.name.addEventListener('input', () => {
  state.name = el.name.value.slice(0, 60) || 'untitled';
});
el.name.addEventListener('change', commit);

/* viewport toolbar */

function setMode(mode) {
  view.mode = mode;
  transform.setMode(mode);
  transform.setSpace(mode === 'scale' && transform.object !== pivot ? 'local' : 'world');
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function applySnap() {
  transform.setTranslationSnap(view.snap ? state.floor.grid : null);
  transform.setRotationSnap(view.snap ? deg2rad(15) : null);
  transform.setScaleSnap(view.snap ? 0.05 : null);
}
$('#chk-snap').addEventListener('change', (e) => {
  view.snap = e.target.checked;
  applySnap();
});
$('#chk-result').addEventListener('change', (e) => {
  view.result = e.target.checked;
  syncVisibility();
});
$('#chk-cages').addEventListener('change', (e) => {
  view.cages = e.target.checked;
  syncCages();
});
/* sky: Aero (procedural), a solid color, or an uploaded panorama */

const SKY_KEY = 'meshtype.sky';
const sky = { mode: 'aero', color: '#bfe9ff', image: null, reflect: true };
let skyTex = null;
let skyEnv = null;

function applySky() {
  if (sky.mode === 'color') {
    scene.background = new THREE.Color(sky.color);
    scene.backgroundBlurriness = 0;
    scene.environment = env.envMap;
  } else if (sky.mode === 'image' && skyTex) {
    scene.background = skyTex;
    scene.backgroundBlurriness = 0;
    scene.environment = sky.reflect && skyEnv ? skyEnv : env.envMap;
  } else {
    scene.background = env.sky;
    scene.backgroundBlurriness = 0.12;
    scene.environment = env.envMap;
  }
  document.querySelectorAll('[data-sky]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sky === sky.mode)));
  const c = $('#sky-color');
  if (c) c.value = sky.color;
  const r = $('#sky-reflect');
  if (r) r.checked = sky.reflect;
}

function saveSky() {
  try {
    localStorage.setItem(SKY_KEY, JSON.stringify(sky));
  } catch (e) {
    /* image too large for storage: it stays for this session only */
  }
}

function loadSkyTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (skyTex) skyTex.dispose();
        if (skyEnv) skyEnv.dispose();
        skyTex = tex;
        const pm = new THREE.PMREMGenerator(renderer);
        skyEnv = pm.fromEquirectangular(tex).texture;
        pm.dispose();
        resolve();
      },
      undefined,
      reject
    );
  });
}

/** Downscale big panoramas so they fit in storage and VRAM. */
function shrinkImage(file, maxW = 2048) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not read that image'));
    };
    img.src = url;
  });
}

const skyPanel = $('#sky-panel');
const skyBtn = $('#btn-sky');
function toggleSkyPanel(open) {
  const show = open ?? skyPanel.hidden;
  skyPanel.hidden = !show;
  skyBtn.setAttribute('aria-expanded', String(show));
}
skyBtn.addEventListener('click', () => toggleSkyPanel());
window.addEventListener('pointerdown', (e) => {
  if (!skyPanel.hidden && !skyPanel.contains(e.target) && e.target !== skyBtn) toggleSkyPanel(false);
});
document.querySelectorAll('[data-sky]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.sky === 'image' && !skyTex) {
      el.fileSky.click();
      return;
    }
    sky.mode = b.dataset.sky;
    applySky();
    saveSky();
  })
);
document.querySelectorAll('[data-swatch]').forEach((b) =>
  b.addEventListener('click', () => {
    sky.mode = 'color';
    sky.color = b.dataset.swatch;
    applySky();
    saveSky();
  })
);
$('#sky-color').addEventListener('input', (e) => {
  sky.mode = 'color';
  sky.color = e.target.value;
  applySky();
});
$('#sky-color').addEventListener('change', saveSky);
$('#sky-reflect').addEventListener('change', (e) => {
  sky.reflect = e.target.checked;
  applySky();
  saveSky();
});
$('#btn-sky-upload').addEventListener('click', () => el.fileSky.click());
el.fileSky.addEventListener('change', async () => {
  const file = el.fileSky.files && el.fileSky.files[0];
  el.fileSky.value = '';
  if (!file) return;
  try {
    sky.image = await shrinkImage(file);
    await loadSkyTexture(sky.image);
    sky.mode = 'image';
    applySky();
    saveSky();
    toast('Skybox loaded. Use a 2:1 equirectangular panorama for best results.');
  } catch (err) {
    toast('Could not load that skybox: ' + err.message);
  }
});

async function bootSky() {
  try {
    const raw = localStorage.getItem(SKY_KEY);
    if (raw) Object.assign(sky, JSON.parse(raw));
  } catch (e) {
    /* defaults */
  }
  if (sky.mode === 'image') {
    try {
      if (sky.image) await loadSkyTexture(sky.image);
    } catch (e) {
      /* fall through */
    }
    if (!skyTex) sky.mode = 'aero';
  }
  applySky();
}

/* picking */

const raycaster = new THREE.Raycaster();
let downInfo = null;
const marquee = $('#marquee');

el.canvas.addEventListener('pointerdown', (e) => {
  closeMenu();
  if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
  const onGizmo = transform.axis !== null && transform.axis !== undefined;
  downInfo = { x: e.clientX, y: e.clientY, button: e.button, onGizmo, box: false, ground: null };
  if (e.button === 0 && !onGizmo) {
    // grabbing a shape drags it (and the rest of the selection) along the floor
    const leafId = pickAt(e.clientX, e.clientY);
    if (leafId != null && lastPickPoint) {
      const target = e.altKey ? leafId : topOf(leafId).id;
      const multi = e.ctrlKey || e.metaKey || e.shiftKey;
      const inSel = state.sel.includes(target) || uniqueTops().some((t) => t.id === target);
      if (!inSel && !multi) selectOnly(target);
      if (inSel || !multi) {
        const start = groundPoint(e.clientX, e.clientY, lastPickPoint.y);
        if (start) {
          downInfo.ground = {
            y: lastPickPoint.y,
            start,
            active: false,
            leaves: selLeaves().map((o) => ({ o, pos: o.pos.slice() })),
          };
        }
      }
    }
    try {
      el.canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }
});

el.canvas.addEventListener('pointermove', (e) => {
  const d = downInfo;
  if (!d || d.button !== 0 || d.onGizmo) return;
  if (d.ground) {
    if (!d.ground.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.ground.active = true;
    if (!d.ground.active) return;
    const p = groundPoint(e.clientX, e.clientY, d.ground.y);
    if (!p) return;
    let dx = p.x - d.ground.start.x;
    let dz = p.z - d.ground.start.z;
    if (view.snap) {
      const g = state.floor.grid;
      dx = Math.round(dx / g) * g;
      dz = Math.round(dz / g) * g;
    }
    for (const { o, pos } of d.ground.leaves) {
      o.pos = [round(pos[0] + dx), pos[1], round(pos[2] + dz)];
      syncRT(o);
    }
    if (transform.object === pivot) recenterPivot();
    requestSolve();
    planeDirty = true;
    return;
  }
  if (!d.box && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.box = true;
  if (!d.box) return;
  const r = el.stage.getBoundingClientRect();
  const x0 = Math.min(d.x, e.clientX) - r.left;
  const y0 = Math.min(d.y, e.clientY) - r.top;
  marquee.hidden = false;
  marquee.style.left = `${x0}px`;
  marquee.style.top = `${y0}px`;
  marquee.style.width = `${Math.abs(e.clientX - d.x)}px`;
  marquee.style.height = `${Math.abs(e.clientY - d.y)}px`;
});

const _corner = new THREE.Vector3();
/** Select every top-level thing with at least 80% of its on-screen box inside the rectangle. */
function boxSelect(x0, y0, x1, y1, additive) {
  const rect = el.canvas.getBoundingClientRect();
  const mx0 = Math.min(x0, x1);
  const mx1 = Math.max(x0, x1);
  const my0 = Math.min(y0, y1);
  const my1 = Math.max(y0, y1);
  camera.updateMatrixWorld();
  const hits = [];
  for (const n of state.nodes) {
    if (n.parent != null || !n.visible) continue;
    const leaves = leavesOf(n.id).filter((o) => o.visible);
    if (!leaves.length) continue;
    const b = boxOf(leaves);
    if (b.isEmpty()) continue;
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    let behind = false;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      if (_corner.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) behind = true;
      _corner.project(camera);
      const sx = rect.left + ((_corner.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - _corner.y) / 2) * rect.height;
      sx0 = Math.min(sx0, sx);
      sx1 = Math.max(sx1, sx);
      sy0 = Math.min(sy0, sy);
      sy1 = Math.max(sy1, sy);
    }
    if (behind) continue;
    const area = (sx1 - sx0) * (sy1 - sy0);
    const iw = Math.min(sx1, mx1) - Math.max(sx0, mx0);
    const ih = Math.min(sy1, my1) - Math.max(sy0, my0);
    if (area > 0 && iw > 0 && ih > 0 && (iw * ih) / area >= 0.8) hits.push(n.id);
  }
  if (additive) setSel([...state.sel, ...hits.filter((id) => !state.sel.includes(id))], hits[hits.length - 1] ?? state.active);
  else setSel(hits, hits[hits.length - 1]);
  if (!hits.length && !additive) toast('Box select needs 80% of an object inside the box.');
}

function pickAt(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const proxies = state.nodes.filter((o) => o.kind === 'part' && o.visible && rt.has(o.id)).map((o) => rt.get(o.id).proxy);
  const hit = raycaster.intersectObjects(proxies, false)[0];
  lastPickPoint = hit ? hit.point.clone() : null;
  return hit ? hit.object.userData.id : null;
}
let lastPickPoint = null;

/* drag along the ground: a horizontal plane through the grab point */
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
function groundPoint(clientX, clientY, y) {
  const rect = el.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  _plane.set(new THREE.Vector3(0, 1, 0), -y);
  return raycaster.ray.intersectPlane(_plane, _hit) ? _hit.clone() : null;
}

el.canvas.addEventListener('pointerup', (e) => {
  if (!downInfo) return;
  const info = downInfo;
  downInfo = null;
  const moved = Math.hypot(e.clientX - info.x, e.clientY - info.y);
  if (info.ground && info.ground.active) {
    try {
      el.canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    attachGizmo();
    commit();
    renderInspector();
    return;
  }
  if (info.box) {
    marquee.hidden = true;
    try {
      el.canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    boxSelect(info.x, info.y, e.clientX, e.clientY, e.ctrlKey || e.metaKey || e.shiftKey);
    return;
  }
  if (moved > 4 || info.onGizmo) return;
  const leafId = pickAt(e.clientX, e.clientY);
  const multi = e.ctrlKey || e.metaKey || e.shiftKey;
  const target = leafId == null ? null : e.altKey ? leafId : topOf(leafId).id;
  if (info.button === 2) {
    if (target != null && !state.sel.includes(target) && !uniqueTops().some((t) => t.id === target)) selectOnly(target);
    else if (target == null) selectOnly(null);
    openMenu(e.clientX, e.clientY);
    return;
  }
  if (info.button !== 0) return;
  if (target == null) {
    if (!multi) selectOnly(null);
  } else if (multi) toggleSel(target);
  else if (!(state.sel.length === 1 && state.sel[0] === target)) selectOnly(target);
});
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* drag and drop SVG */
el.stage.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
el.stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') importSvgFile(f);
  else toast('Drop an .svg file to extrude it.');
});

/* ------------------------------------------------------------------ */
/* context menu                                                        */
/* ------------------------------------------------------------------ */

function menuItems() {
  const sel = liveSel();
  const tops = uniqueTops();
  const n = sel.length === 1 ? node(sel[0]) : null;
  if (!sel.length) {
    return [
      { label: 'Add Block', act: 'add:block' },
      { label: 'Add Panel', act: 'add:panel' },
      { label: 'Add Disc', act: 'add:disc' },
      { label: 'Add Orb', act: 'add:orb' },
      { label: 'Add Pill', act: 'add:pill' },
      { sep: true },
      { label: 'Import SVG…', act: 'svg' },
      { label: 'Select all', act: 'all', disabled: !state.nodes.length },
    ];
  }
  const allNeg = sel.every((id) => node(id).neg);
  return [
    { label: 'Union', icon: 'i-union', key: 'U', act: 'union', disabled: tops.length < 2 },
    { label: allNeg ? 'Make solid' : 'Negate (make cutter)', icon: 'i-negate', key: 'N', act: 'negate' },
    { label: 'Split', icon: 'i-split', key: 'X', act: 'split', disabled: !sel.some((id) => isGroup(node(id)) || isGroup(topOf(id))) },
    { label: 'Intersect', act: 'int', disabled: tops.length < 2 },
    { sep: true },
    { label: 'Center in world', act: 'center' },
    { label: 'Align X…', act: 'axis:x', disabled: tops.length < 1 },
    { label: 'Align Y…', act: 'axis:y', disabled: tops.length < 1 },
    { label: 'Align Z…', act: 'axis:z', disabled: tops.length < 1 },
    { sep: true },
    { label: 'Duplicate', key: 'C', act: 'dup' },
    { label: n && n.visible ? 'Hide' : 'Hide / show', act: 'hide' },
    { label: 'Rename', act: 'rename', disabled: !n },
    { label: 'Frame', key: 'F', act: 'frame' },
    { sep: true },
    { label: 'Select all', act: 'all' },
    { label: 'Delete', key: 'Del', act: 'del', danger: true },
  ];
}

function openMenu(x, y) {
  const items = menuItems();
  el.ctx.innerHTML = items
    .map((it) =>
      it.sep
        ? '<div class="sep" role="separator"></div>'
        : `<button type="button" role="menuitem" data-ctx="${it.act}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">
  <span class="mi">${it.icon ? `<svg class="mico" aria-hidden="true"><use href="#${it.icon}"/></svg>` : ''}</span>
  <span class="ml">${esc(it.label)}</span><span class="mk">${it.key || ''}</span></button>`
    )
    .join('');
  el.ctx.hidden = false;
  const w = el.ctx.offsetWidth || 220;
  const h = el.ctx.offsetHeight || 300;
  el.ctx.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  el.ctx.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
}
function closeMenu() {
  el.ctx.hidden = true;
}
el.ctx.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctx]');
  if (!b || b.disabled) return;
  closeMenu();
  runAction(b.dataset.ctx);
});
el.ctx.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerdown', (e) => {
  if (!el.ctx.hidden && !el.ctx.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);

/* ------------------------------------------------------------------ */
/* keyboard + fly camera                                               */
/* ------------------------------------------------------------------ */

const fly = { keys: new Set(), shift: false, ctrl: false, lastAt: 0 };
const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

function isTyping(t) {
  const tag = t && t.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && ['text', 'number'].includes(t.type));
}

window.addEventListener('keydown', (e) => {
  fly.shift = e.shiftKey;
  fly.ctrl = e.ctrlKey;
  const typing = isTyping(e.target);
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && !typing && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && !typing && k === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (FLY_KEYS.has(k) && !e.altKey && !e.metaKey) {
    fly.keys.add(k);
    fly.lastAt = performance.now();
    e.preventDefault();
    return;
  }
  if (mod || e.altKey) return;
  if (k === '1') setMode('translate');
  else if (k === '2') setMode('rotate');
  else if (k === '3') setMode('scale');
  else if (k === 'f') frameSelected();
  else if (k === 'u') doUnion('union');
  else if (k === 'n') doNegate();
  else if (k === 'x') doSplit();
  else if (k === 'c') duplicateSelection();
  else if (k === 'escape') {
    closeMenu();
    selectOnly(null);
  } else if (k === 'delete' || k === 'backspace') {
    if (liveSel().length) {
      e.preventDefault();
      deleteSelection();
    }
  }
});
window.addEventListener('keyup', (e) => {
  fly.shift = e.shiftKey;
  fly.ctrl = e.ctrlKey;
  fly.keys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => {
  fly.keys.clear();
  fly.shift = fly.ctrl = false;
});
// Ctrl+W is "close tab". Browsers do not let a page cancel it, but they will ask
// before leaving if the page registers a beforeunload prompt, so only while the
// user is flying with Ctrl held.
window.addEventListener('beforeunload', (e) => {
  if (fly.ctrl && (fly.keys.size || performance.now() - fly.lastAt < 900)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _m = new THREE.Vector3();
let lastFrame = performance.now();
function flyStep(dt) {
  if (!fly.keys.size) return;
  const k = fly.keys;
  camera.getWorldDirection(_f);
  _r.crossVectors(_f, camera.up).normalize();
  _m.set(0, 0, 0);
  if (k.has('w')) _m.addScaledVector(_f, 1);
  if (k.has('s')) _m.addScaledVector(_f, -1);
  if (k.has('d')) _m.addScaledVector(_r, 1);
  if (k.has('a')) _m.addScaledVector(_r, -1);
  if (k.has('e')) _m.y += 1;
  if (k.has('q')) _m.y -= 1;
  if (_m.lengthSq() === 0) return;
  const dist = camera.position.distanceTo(orbit.target);
  let speed = 2.2 * Math.max(0.5, dist / 4);
  if (fly.shift) speed *= 0.2;
  if (fly.ctrl) speed *= 3.5;
  _m.normalize().multiplyScalar(speed * dt);
  camera.position.add(_m);
  orbit.target.add(_m);
}

function frameSelected() {
  let lv = selLeaves().filter((o) => o.visible);
  if (!lv.length) lv = state.nodes.filter((n) => n.kind === 'part' && n.visible && !n.neg);
  if (!lv.length) return;
  const box = boxOf(lv);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const dir = camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, Math.max(2, size * 1.8));
}

/* ------------------------------------------------------------------ */
/* project files + export                                              */
/* ------------------------------------------------------------------ */

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

$('#btn-save').addEventListener('click', () => {
  download(`${slug(state.name)}.meshtype.json`, JSON.stringify(projectData(), null, 2), 'application/json');
  toast('Project saved');
});
$('#btn-open').addEventListener('click', () => el.fileOpen.click());
el.fileOpen.addEventListener('change', async () => {
  const file = el.fileOpen.files && el.fileOpen.files[0];
  el.fileOpen.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !(Array.isArray(data.nodes) || Array.isArray(data.objects))) throw new Error('not a Meshtype project');
    restore({ ...data, sel: [], selected: null });
    commit();
    toast(`Opened ${file.name}`);
  } catch (err) {
    toast('Could not open that file: ' + err.message);
  }
});
$('#btn-svg').addEventListener('click', () => el.fileSvg.click());
el.fileTex.addEventListener('change', async () => {
  const file = el.fileTex.files && el.fileTex.files[0];
  el.fileTex.value = '';
  const n = state.sel.length === 1 ? node(state.sel[0]) : null;
  if (!file || !n) return;
  try {
    const url = await shrinkImage(file, 1024);
    const id = `img${state.nextId++}`;
    state.assets[id] = url;
    for (const o of leavesOf(n.id)) {
      o.tex = id;
      if (!o.texSize) o.texSize = 0.5;
      applyLook(o);
    }
    commit();
    renderInspector();
    toast('Texture applied. Set the tint to white to see the image colors as-is.');
  } catch (err) {
    toast('Could not load that image: ' + err.message);
  }
});
el.fileSvg.addEventListener('change', async () => {
  const file = el.fileSvg.files && el.fileSvg.files[0];
  el.fileSvg.value = '';
  if (file) await importSvgFile(file);
});

/** Everything that exports: every visible solid top-level unit, in world space. */
async function exportGroup() {
  if (dirty) solve();
  await settleRounds();
  if (dirty) solve();
  const grp = new THREE.Group();
  const strip = el.strip.checked;
  const plain = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  for (const n of state.nodes) {
    if (n.parent != null || n.neg || !n.visible) continue;
    const u = units.get(n.id);
    let mesh = null;
    if (u && u.mesh) {
      const g = u.mesh.geometry;
      if (g.attributes.position.count) {
        if (strip) {
          const clean = g.clone();
          clean.clearGroups();
          mesh = new THREE.Mesh(clean, plain());
        } else mesh = new THREE.Mesh(g, u.mesh.material);
      }
    } else if (n.kind === 'part') {
      const r = rt.get(n.id);
      if (r && r.geo && r.geo.attributes.position && r.geo.attributes.position.count) {
        mesh = new THREE.Mesh(r.geo, strip ? plain() : r.material);
        mesh.position.copy(r.proxy.position);
        mesh.quaternion.copy(r.proxy.quaternion);
        mesh.scale.copy(r.proxy.scale);
      }
    }
    if (mesh) {
      mesh.name = slug(n.name) + (el.col && el.col.checked ? '-col' : '');
      grp.add(mesh);
    }
  }
  const f = state.floor;
  if (f.on) {
    const g = new THREE.BoxGeometry(f.w, 0.06, f.d);
    g.translate(0, -0.03, 0);
    // UVs in meters so the texture tiles the same as in the editor
    g.setAttribute('uv', new THREE.BufferAttribute(boxUVs(g.attributes.position.array, g.attributes.normal.array), 2));
    let m;
    if (strip) m = plain();
    else {
      m = floorMaterial(f.preset).clone();
      m.map = m.map.clone();
      const tile = FLOORS[f.preset].tile;
      m.map.repeat.set(1 / tile, 1 / tile);
      m.map.needsUpdate = true;
      if (m.emissiveMap) m.emissiveMap = m.map;
    }
    const floor = new THREE.Mesh(g, m);
    floor.name = 'floor' + (el.col && el.col.checked ? '-col' : '');
    grp.add(floor);
  }
  // room info for whoever assembles rooms in Godot (shows up as glTF extras)
  grp.userData = { meshtype: { version: VERSION, grid: f.grid, floor: f.on ? { w: f.w, d: f.d, preset: f.preset } : null } };
  return grp.children.length ? grp : null;
}

$('#btn-glb').addEventListener('click', async () => {
  const grp = await exportGroup();
  if (!grp) return toast('Nothing to export yet. Cutters alone export nothing.');
  grp.name = slug(state.name);
  try {
    const buf = await new GLTFExporter().parseAsync(grp, { binary: true });
    download(`${slug(state.name)}.glb`, new Blob([buf], { type: 'model/gltf-binary' }));
    toast(`Exported ${slug(state.name)}.glb`);
  } catch (err) {
    console.error(err);
    toast('GLB export failed: ' + err.message);
  }
});

$('#btn-obj').addEventListener('click', async () => {
  const grp = await exportGroup();
  if (!grp) return toast('Nothing to export yet. Cutters alone export nothing.');
  grp.name = slug(state.name);
  try {
    download(`${slug(state.name)}.obj`, new OBJExporter().parse(grp), 'text/plain');
    toast(`Exported ${slug(state.name)}.obj`);
  } catch (err) {
    console.error(err);
    toast('OBJ export failed: ' + err.message);
  }
});

/* ------------------------------------------------------------------ */
/* main loop                                                           */
/* ------------------------------------------------------------------ */

function resize() {
  const rect = el.stage.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(el.stage);

/* window chrome: caption buttons + desktop wallpaper */

const WALL_KEY = 'meshtype.wallpaper';
function applyWallpaper(url) {
  if (url) {
    document.body.style.setProperty('--wallpaper', `url("${url}")`);
    document.body.classList.add('has-wallpaper');
  } else {
    document.body.style.removeProperty('--wallpaper');
    document.body.classList.remove('has-wallpaper');
  }
}
try {
  applyWallpaper(localStorage.getItem(WALL_KEY));
} catch (e) {
  /* no storage */
}
const fileWall = $('#file-wall');
$('#btn-wall').addEventListener('click', () => fileWall.click());
$('#btn-wall-reset').addEventListener('click', () => {
  applyWallpaper(null);
  try {
    localStorage.removeItem(WALL_KEY);
  } catch (e) {
    /* ignore */
  }
});
fileWall.addEventListener('change', async () => {
  const file = fileWall.files && fileWall.files[0];
  fileWall.value = '';
  if (!file) return;
  try {
    const url = await shrinkImage(file, 2560);
    applyWallpaper(url);
    try {
      localStorage.setItem(WALL_KEY, url);
    } catch (e) {
      toast('Wallpaper set for this session (too big to remember).');
    }
  } catch (err) {
    toast('Could not load that wallpaper: ' + err.message);
  }
});
$('#cap-min').addEventListener('click', () => {
  document.querySelector('.app').classList.toggle('focus-view');
});
$('#cap-max').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => toast('Fullscreen is not available here.'));
});
$('#cap-close').addEventListener('click', () => {
  window.close();
  setTimeout(() => toast('Browsers only let you close this tab yourself. (In the installed app it closes.)'), 150);
});

/* floor panel */

const floorPanel = $('#floor-panel');
const floorBtn = $('#btn-floor');
function renderFloorPanel() {
  const f = state.floor;
  $('#floor-on').checked = f.on;
  $('#floor-w').value = f.w;
  $('#floor-d').value = f.d;
  $('#floor-preset').value = f.preset;
  floorBtn.setAttribute('aria-pressed', String(f.on));
}
function toggleFloorPanel(open) {
  const show = open ?? floorPanel.hidden;
  floorPanel.hidden = !show;
  floorBtn.setAttribute('aria-expanded', String(show));
}
floorBtn.addEventListener('click', () => toggleFloorPanel());
window.addEventListener('pointerdown', (e) => {
  if (!floorPanel.hidden && !floorPanel.contains(e.target) && e.target !== floorBtn) toggleFloorPanel(false);
});
$('#floor-preset').innerHTML = Object.entries(FLOORS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
floorPanel.addEventListener('change', (e) => {
  const f = state.floor;
  const t = e.target;
  if (t.id === 'floor-on') f.on = t.checked;
  else if (t.id === 'floor-w') f.w = clamp(parseFloat(t.value) || f.w, 1, 200);
  else if (t.id === 'floor-d') f.d = clamp(parseFloat(t.value) || f.d, 1, 200);
  else if (t.id === 'floor-preset') f.preset = t.value;
  else return;
  syncFloor();
  renderFloorPanel();
  commit();
});
$('#grid-size').addEventListener('change', (e) => {
  state.floor.grid = Number(e.target.value);
  syncFloor();
  commit();
});

/* view cube: shows the camera orientation, click a face for that view, drag to orbit */

const vcEl = $('#vcube');
const vcCube = $('#vc-cube');
const viewTween = { on: false, t0: 0, from: new THREE.Vector3(), q: new THREE.Quaternion(), dist: 1 };
const VIEW_DIRS = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001] };

function setView(name) {
  const to = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
  const from = camera.position.clone().sub(orbit.target);
  viewTween.dist = from.length() || 4;
  from.normalize();
  viewTween.from.copy(from);
  viewTween.q.setFromUnitVectors(from, to);
  viewTween.t0 = performance.now();
  viewTween.on = true;
}

function updateViewCube() {
  const q = camera.quaternion.clone().invert();
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const a = (r, c) => e[c * 4 + r] * ((r === 1) !== (c === 1) ? -1 : 1); // flip Y for CSS
  vcCube.style.transform = `matrix3d(${a(0, 0)},${a(1, 0)},${a(2, 0)},0,${a(0, 1)},${a(1, 1)},${a(2, 1)},0,${a(0, 2)},${a(1, 2)},${a(2, 2)},0,0,0,0,1)`;
}

let vcDrag = null;
vcEl.addEventListener('pointerdown', (e) => {
  vcDrag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, face: e.target.closest('[data-view]'), moved: false };
  viewTween.on = false;
  vcEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});
vcEl.addEventListener('pointermove', (e) => {
  if (!vcDrag) return;
  if (Math.hypot(e.clientX - vcDrag.x, e.clientY - vcDrag.y) > 4) vcDrag.moved = true;
  if (!vcDrag.moved) return;
  const dx = e.clientX - vcDrag.lx;
  const dy = e.clientY - vcDrag.ly;
  vcDrag.lx = e.clientX;
  vcDrag.ly = e.clientY;
  const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
  sph.theta -= dx * 0.012;
  sph.phi = clamp(sph.phi - dy * 0.012, 0.02, Math.PI - 0.02);
  camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(sph));
});
vcEl.addEventListener('pointerup', () => {
  const d = vcDrag;
  vcDrag = null;
  if (d && !d.moved && d.face) setView(d.face.dataset.view);
});

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  flyStep(dt);
  if (viewTween.on) {
    const p = Math.min(1, (now - viewTween.t0) / 240);
    const k = p * p * (3 - 2 * p);
    const qi = new THREE.Quaternion().slerp(viewTween.q, k);
    camera.position.copy(orbit.target).addScaledVector(viewTween.from.clone().applyQuaternion(qi), viewTween.dist);
    if (p >= 1) viewTween.on = false;
  }
  updateViewCube();
  if (dirty && now - lastSolve > 70) solve();
  if (planeDirty) updateAlignPlane();
  orbit.update();
  renderer.render(scene, camera);
}

/* PWA */

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  const b = $('#btn-install');
  if (b) b.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  const b = $('#btn-install');
  if (b) b.hidden = true;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $('#btn-install').hidden = true;
});
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function boot() {
  let data = null;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) data = JSON.parse(stored);
  } catch (e) {
    data = null;
  }
  if (!data || !(Array.isArray(data.nodes) || Array.isArray(data.objects))) data = sampleProject();
  setMode('translate');
  applySnap();
  bootSky();
  restore(data);
  commit();
  resize();
  solve();
  requestAnimationFrame(loop);
}

boot();

// Meshtype v0.1.0
// A small browser mesh editor: squircle primitives, boolean layers, GLB export.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { SHAPES, makeGeometry } from './shapes.js';
import { MATERIALS, applyMaterial, makeAeroEnvironment } from './materials.js';

const VERSION = '0.1.0';
const STORE_KEY = 'meshtype.autosave';
const OPS = ['add', 'sub', 'int'];
const OP_LABEL = { add: 'Add', sub: 'Subtract', int: 'Intersect' };
const OP_CHIP = { add: 'ADD', sub: 'SUB', int: 'INT' };

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
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);
const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const fmt = (v, d = 2) => String(round(v, d));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (s) => (String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled');

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
  strip: $('#chk-strip'),
};

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
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

let state = { name: 'untitled', objects: [], selected: null, nextId: 1 };
const byId = (id) => state.objects.find((o) => o.id === id);
const view = { mode: 'translate', snap: true, result: true, cages: false, sky: true };

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = SHAPES[raw.type] ? raw.type : 'squircle';
  const defs = SHAPES[type].defaults;
  const lims = SHAPES[type].limits;
  const params = {};
  for (const k of Object.keys(defs)) {
    let v = Number(raw.params && raw.params[k]);
    if (!Number.isFinite(v)) v = defs[k];
    params[k] = Math.min(lims[k][1], Math.max(lims[k][0], v));
  }
  params.detail = Math.round(params.detail);
  const vec = (a, fallback, min) =>
    Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v))
      ? a.map((v) => (min === undefined ? v : Math.max(min, v)))
      : fallback.slice();
  const mat = MATERIALS[raw.mat] ? raw.mat : 'glass';
  return {
    id: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : 0,
    name: String(raw.name || 'Shape').slice(0, 60),
    type,
    params,
    pos: vec(raw.pos, [0, 0, 0]),
    rot: vec(raw.rot, [0, 0, 0]),
    scl: vec(raw.scl, [1, 1, 1], 0.01),
    op: OPS.includes(raw.op) ? raw.op : 'add',
    mat,
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : MATERIALS[mat].color,
    visible: raw.visible !== false,
  };
}

function sampleProject() {
  return {
    name: 'aero-demo',
    nextId: 4,
    selected: 1,
    objects: [
      { id: 1, name: 'Body', type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 3 }, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1.8, 0.5, 1.2], op: 'add', mat: 'glass', color: '#8fdcff', visible: true },
      { id: 2, name: 'Recess', type: 'squircle', params: { nPlan: 4, nProf: 6, detail: 2 }, pos: [0, 0.2, 0], rot: [0, 0, 0], scl: [1.5, 0.3, 0.95], op: 'sub', mat: 'gloss', color: '#0a5aa8', visible: true },
      { id: 3, name: 'Lamp', type: 'squircle', params: { nPlan: 2, nProf: 2, detail: 2 }, pos: [0, 0.06, 0], rot: [0, 0, 0], scl: [0.32, 0.32, 0.32], op: 'add', mat: 'glow', color: '#7dffb0', visible: true },
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

const grid = new THREE.GridHelper(8, 32, 0x2f8fcf, 0x8fc4e4);
grid.material.transparent = true;
grid.material.opacity = 0.45;
scene.add(grid);

const orbit = new OrbitControls(camera, el.canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.target.set(0, 0, 0);

const transform = new TransformControls(camera, el.canvas);
transform.size = 0.8;
scene.add(transform.getHelper());

const partsGroup = new THREE.Group();
scene.add(partsGroup);

const emptyGeo = new THREE.BufferGeometry();
const resultMesh = new THREE.Mesh(emptyGeo, new THREE.MeshStandardMaterial());
resultMesh.frustumCulled = false;
resultMesh.visible = false;
scene.add(resultMesh);

const evaluator = new Evaluator();
evaluator.useGroups = true;

const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const wire = (color) =>
  new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
const fill = (color) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide });
const ghost = {
  wireSel: wire(0x0aa5ff),
  wireSub: wire(0xff4d5e),
  wireInt: wire(0x2fd27a),
  fillSub: fill(0xff4d5e),
  fillInt: fill(0x2fd27a),
};

/** id -> { proxy, part, wire, fill, geo, key, material } */
const rt = new Map();

function ensureRT(o) {
  let r = rt.get(o.id);
  if (r) return r;
  const material = new THREE.MeshPhysicalMaterial();
  applyMaterial(material, o.mat, o.color);
  const proxy = new THREE.Mesh(emptyGeo, hitMat);
  proxy.userData.id = o.id;
  const part = new THREE.Mesh(emptyGeo, material);
  const w = new THREE.Mesh(emptyGeo, ghost.wireSel);
  const f = new THREE.Mesh(emptyGeo, ghost.fillSub);
  w.renderOrder = 10;
  proxy.add(part, w, f);
  partsGroup.add(proxy);
  r = { proxy, part, wire: w, fill: f, geo: null, key: '', material };
  rt.set(o.id, r);
  return r;
}

/** Push a document object's data into its three.js runtime objects. */
function syncRT(o) {
  const r = ensureRT(o);
  const key = o.type + JSON.stringify(o.params);
  if (r.key !== key) {
    const old = r.geo;
    r.geo = makeGeometry(o.type, o.params);
    r.key = key;
    r.proxy.geometry = r.part.geometry = r.wire.geometry = r.fill.geometry = r.geo;
    if (old) old.dispose();
  }
  r.proxy.position.fromArray(o.pos);
  r.proxy.rotation.set(deg2rad(o.rot[0]), deg2rad(o.rot[1]), deg2rad(o.rot[2]), 'XYZ');
  r.proxy.scale.fromArray(o.scl);
  r.proxy.visible = o.visible;

  const index = state.objects.indexOf(o);
  const operand = index > 0 && o.op !== 'add';
  const selected = o.id === state.selected;
  r.wire.material = operand ? (o.op === 'sub' ? ghost.wireSub : ghost.wireInt) : ghost.wireSel;
  r.wire.visible = operand || selected || view.cages;
  r.fill.visible = operand;
  r.fill.material = o.op === 'sub' ? ghost.fillSub : ghost.fillInt;
  r.part.visible = !view.result;
}

function syncAll() {
  for (const o of state.objects) syncRT(o);
}

function clearRT() {
  transform.detach();
  for (const r of rt.values()) {
    partsGroup.remove(r.proxy);
    if (r.geo) r.geo.dispose();
    r.material.dispose();
  }
  rt.clear();
}

function attachGizmo() {
  const o = byId(state.selected);
  const r = o && rt.get(o.id);
  if (r && o.visible) transform.attach(r.proxy);
  else transform.detach();
}

/* ------------------------------------------------------------------ */
/* boolean solve                                                       */
/* ------------------------------------------------------------------ */

let dirty = true;
let lastSolve = 0;
let resultTris = 0;
let resultMs = 0;

function requestSolve() {
  dirty = true;
}

function disposeBrush(b) {
  if (b.disposeCacheData) b.disposeCacheData();
  b.geometry.dispose();
}

function solve() {
  dirty = false;
  lastSolve = performance.now();
  let acc = null;
  try {
    for (const o of state.objects) {
      if (!o.visible) continue;
      const r = rt.get(o.id);
      if (!r || !r.geo) continue;
      r.proxy.updateMatrix();
      const g = r.geo.clone();
      g.applyMatrix4(r.proxy.matrix);
      const brush = new Brush(g, r.material);
      if (!acc) {
        acc = brush;
        continue;
      }
      const op = o.op === 'sub' ? SUBTRACTION : o.op === 'int' ? INTERSECTION : ADDITION;
      const next = evaluator.evaluate(acc, brush, op);
      disposeBrush(acc);
      disposeBrush(brush);
      acc = next;
    }
  } catch (err) {
    console.error(err);
    toast('Boolean failed: ' + (err && err.message ? err.message : err));
  }
  setResult(acc);
  resultMs = performance.now() - lastSolve;
  updateStats();
}

function setResult(brush) {
  const old = resultMesh.geometry;
  const posAttr = brush && brush.geometry.attributes.position;
  if (posAttr && posAttr.count > 0) {
    resultMesh.geometry = brush.geometry;
    resultMesh.material = brush.material;
    resultMesh.visible = view.result;
    const g = brush.geometry;
    resultTris = Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
  } else {
    resultMesh.geometry = emptyGeo;
    resultMesh.visible = false;
    resultTris = 0;
    if (brush) disposeBrush(brush);
  }
  if (old !== emptyGeo && old !== resultMesh.geometry) old.dispose();
}

function updateStats() {
  el.stats.textContent = `${resultTris.toLocaleString()} tris · ${resultMs.toFixed(0)} ms`;
}

/* ------------------------------------------------------------------ */
/* history + autosave                                                  */
/* ------------------------------------------------------------------ */

const hist = { stack: [], i: -1 };

function projectData() {
  return { app: 'meshtype', version: VERSION, name: state.name, nextId: state.nextId, objects: state.objects };
}

function snapshot() {
  return JSON.stringify({ ...projectData(), selected: state.selected });
}

function commit() {
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
  const used = new Set();
  const objects = [];
  for (const raw of Array.isArray(data.objects) ? data.objects : []) {
    const o = sanitize(raw);
    if (!o) continue;
    if (!o.id || used.has(o.id)) o.id = 0;
    if (o.id) used.add(o.id);
    objects.push(o);
  }
  let next = Math.max(Number(data.nextId) || 1, ...used, 0) + 1;
  for (const o of objects) if (!o.id) o.id = next++;
  state = {
    name: String(data.name || 'untitled').slice(0, 60),
    objects,
    selected: objects.some((o) => o.id === data.selected) ? data.selected : null,
    nextId: Math.max(next, Number(data.nextId) || 1),
  };
  el.name.value = state.name;
  syncAll();
  attachGizmo();
  requestSolve();
  refreshUI();
}

/* ------------------------------------------------------------------ */
/* editing actions                                                     */
/* ------------------------------------------------------------------ */

function select(id) {
  state.selected = id;
  syncAll();
  attachGizmo();
  refreshUI();
}

function addObject(presetId) {
  const p = PRESETS[presetId];
  if (!p) return;
  const o = sanitize({
    id: state.nextId++,
    name: `${p.label} ${state.nextId - 1}`,
    type: p.type,
    params: p.params,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scl: p.scl,
    op: 'add',
    mat: 'glass',
    color: MATERIALS.glass.color,
  });
  state.objects.push(o);
  state.selected = o.id;
  syncAll();
  attachGizmo();
  requestSolve();
  commit();
  refreshUI();
}

function removeObject(id) {
  const i = state.objects.findIndex((o) => o.id === id);
  if (i < 0) return;
  const r = rt.get(id);
  if (r) {
    if (state.selected === id) transform.detach();
    partsGroup.remove(r.proxy);
    if (r.geo) r.geo.dispose();
    r.material.dispose();
    rt.delete(id);
  }
  state.objects.splice(i, 1);
  state.selected = state.objects.length ? state.objects[Math.min(i, state.objects.length - 1)].id : null;
  syncAll();
  attachGizmo();
  requestSolve();
  commit();
  refreshUI();
}

function duplicateObject(id) {
  const src = byId(id);
  if (!src) return;
  const copy = sanitize({ ...JSON.parse(JSON.stringify(src)), id: state.nextId++, name: `${src.name} copy` });
  copy.pos = [round(src.pos[0] + 0.15), src.pos[1], round(src.pos[2] + 0.15)];
  state.objects.push(copy);
  state.selected = copy.id;
  syncAll();
  attachGizmo();
  requestSolve();
  commit();
  refreshUI();
}

function moveObject(id, dir) {
  const i = state.objects.findIndex((o) => o.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.objects.length) return;
  [state.objects[i], state.objects[j]] = [state.objects[j], state.objects[i]];
  syncAll();
  requestSolve();
  commit();
  refreshUI();
}

/* ------------------------------------------------------------------ */
/* UI rendering                                                        */
/* ------------------------------------------------------------------ */

function refreshUI() {
  renderList();
  renderInspector();
  el.empty.hidden = state.objects.length > 0;
  updateHistoryButtons();
}

function chipFor(o, index) {
  if (index === 0) return '<span class="chip base">BASE</span>';
  return `<span class="chip ${o.op}">${OP_CHIP[o.op]}</span>`;
}

function renderList() {
  el.list.innerHTML = state.objects
    .map(
      (o, i) => `<li class="row ${o.id === state.selected ? 'sel' : ''} ${o.visible ? '' : 'off'}" data-id="${o.id}">
  <button type="button" class="eye" data-act="vis" title="${o.visible ? 'Hide' : 'Show'}" aria-label="${o.visible ? 'Hide' : 'Show'} ${esc(o.name)}">${o.visible ? '◉' : '○'}</button>
  <span class="nm">${esc(o.name)}</span>${chipFor(o, i)}
</li>`
    )
    .join('');
}

function sliderHTML(o, [key, label, min, max, step]) {
  const val = o.params[key];
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `<label class="sl"><span class="lb">${label}</span><output id="out-${key}">${val.toFixed(dec)}</output>
<input type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
}

function xformRow(o, label, key, step) {
  const cells = [0, 1, 2]
    .map(
      (i) =>
        `<input type="number" step="${step}" data-t="${key}" data-i="${i}" value="${fmt(o[key][i], 3)}" aria-label="${label} ${'XYZ'[i]}">`
    )
    .join('');
  return `<div class="xrow"><span>${label}</span>${cells}</div>`;
}

function renderInspector() {
  const o = byId(state.selected);
  if (!o) {
    el.inspector.innerHTML = '<h2>Inspector</h2><p class="hint">Pick a layer from the list or click a shape in the viewport.</p>';
    return;
  }
  const index = state.objects.indexOf(o);
  const opButtons =
    index === 0
      ? '<button type="button" class="base-only" disabled>Base shape</button>'
      : OPS.map((k) => `<button type="button" data-op="${k}" aria-pressed="${o.op === k}">${OP_LABEL[k]}</button>`).join('');
  const sliders = SHAPE_UI[o.type].map((s) => sliderHTML(o, s)).join('');
  const tip =
    o.type === 'squircle'
      ? '<p class="tip">n = 2 is round, n = 4 is a classic squircle, higher gets boxier.</p>'
      : '';
  const matOptions = Object.entries(MATERIALS)
    .map(([k, m]) => `<option value="${k}" ${o.mat === k ? 'selected' : ''}>${m.label}</option>`)
    .join('');
  el.inspector.innerHTML = `
<h2>Layer</h2>
<div class="field"><input id="f-name" type="text" maxlength="60" value="${esc(o.name)}" aria-label="Layer name" spellcheck="false"></div>
<div class="field"><span class="lbl">Operation</span><div class="ops">${opButtons}</div></div>
<h2>Shape</h2>
${sliders}${tip}
<h2>Transform</h2>
${xformRow(o, 'Move', 'pos', 0.05)}${xformRow(o, 'Rotate°', 'rot', 5)}${xformRow(o, 'Scale', 'scl', 0.05)}
<h2>Material</h2>
<div class="matrow"><select id="f-mat" aria-label="Material">${matOptions}</select><input id="f-color" type="color" value="${o.color}" aria-label="Tint color"></div>
<div class="acts">
  <button type="button" data-act="up" ${index === 0 ? 'disabled' : ''}>Move up</button>
  <button type="button" data-act="down" ${index === state.objects.length - 1 ? 'disabled' : ''}>Move down</button>
  <button type="button" data-act="dup">Duplicate</button>
  <button type="button" data-act="del" class="danger">Delete</button>
</div>`;
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

el.list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  if (e.target.closest('[data-act="vis"]')) {
    const o = byId(id);
    o.visible = !o.visible;
    syncAll();
    attachGizmo();
    requestSolve();
    commit();
    refreshUI();
    return;
  }
  select(id);
});

el.inspector.addEventListener('input', (e) => {
  const t = e.target;
  const o = byId(state.selected);
  if (!o) return;
  if (t.dataset.param) {
    const key = t.dataset.param;
    const val = parseFloat(t.value);
    o.params[key] = val;
    const step = Number(t.step);
    const out = $(`#out-${key}`);
    if (out) out.textContent = val.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
    syncRT(o);
    requestSolve();
  } else if (t.id === 'f-name') {
    o.name = t.value.slice(0, 60);
    renderList();
  } else if (t.id === 'f-color') {
    o.color = t.value;
    applyMaterial(rt.get(o.id).material, o.mat, o.color);
  }
});

el.inspector.addEventListener('change', (e) => {
  const t = e.target;
  const o = byId(state.selected);
  if (!o) return;
  if (t.dataset.param || t.id === 'f-name' || t.id === 'f-color') {
    commit();
  } else if (t.dataset.t) {
    const key = t.dataset.t;
    const i = Number(t.dataset.i);
    let v = parseFloat(t.value);
    if (!Number.isFinite(v)) v = o[key][i];
    if (key === 'scl') v = Math.max(0.01, v);
    o[key][i] = v;
    t.value = fmt(v, 3);
    syncRT(o);
    requestSolve();
    commit();
  } else if (t.id === 'f-mat') {
    o.mat = t.value;
    o.color = MATERIALS[o.mat].color;
    applyMaterial(rt.get(o.id).material, o.mat, o.color);
    const colorInput = $('#f-color');
    if (colorInput) colorInput.value = o.color;
    commit();
  }
});

el.inspector.addEventListener('click', (e) => {
  const o = byId(state.selected);
  if (!o) return;
  const opBtn = e.target.closest('[data-op]');
  if (opBtn) {
    o.op = opBtn.dataset.op;
    syncAll();
    requestSolve();
    commit();
    refreshUI();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'up') moveObject(o.id, -1);
  else if (a === 'down') moveObject(o.id, 1);
  else if (a === 'dup') duplicateObject(o.id);
  else if (a === 'del') removeObject(o.id);
});

el.name.addEventListener('input', () => {
  state.name = el.name.value.slice(0, 60) || 'untitled';
});
el.name.addEventListener('change', commit);

/* viewport toolbar */

function setMode(mode) {
  view.mode = mode;
  transform.setMode(mode);
  transform.setSpace(mode === 'scale' ? 'local' : 'world');
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function applySnap() {
  transform.setTranslationSnap(view.snap ? 0.05 : null);
  transform.setRotationSnap(view.snap ? deg2rad(15) : null);
  transform.setScaleSnap(view.snap ? 0.05 : null);
}
$('#chk-snap').addEventListener('change', (e) => {
  view.snap = e.target.checked;
  applySnap();
});
$('#chk-result').addEventListener('change', (e) => {
  view.result = e.target.checked;
  resultMesh.visible = view.result && resultTris > 0;
  syncAll();
});
$('#chk-cages').addEventListener('change', (e) => {
  view.cages = e.target.checked;
  syncAll();
});
$('#chk-sky').addEventListener('change', (e) => {
  view.sky = e.target.checked;
  scene.background = view.sky ? env.sky : plainBg;
});

/* gizmo + picking */

transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (!e.value) commit();
});
transform.addEventListener('objectChange', () => {
  const o = byId(state.selected);
  const r = o && rt.get(o.id);
  if (!r) return;
  const p = r.proxy;
  p.scale.set(Math.max(0.01, p.scale.x), Math.max(0.01, p.scale.y), Math.max(0.01, p.scale.z));
  o.pos = [round(p.position.x), round(p.position.y), round(p.position.z)];
  o.rot = [round(rad2deg(p.rotation.x), 2), round(rad2deg(p.rotation.y), 2), round(rad2deg(p.rotation.z), 2)];
  o.scl = [round(p.scale.x), round(p.scale.y), round(p.scale.z)];
  updateXformFields(o);
  requestSolve();
});

const raycaster = new THREE.Raycaster();
let downInfo = null;
el.canvas.addEventListener('pointerdown', (e) => {
  downInfo = { x: e.clientX, y: e.clientY, onGizmo: transform.axis !== null && transform.axis !== undefined };
});
el.canvas.addEventListener('pointerup', (e) => {
  if (!downInfo) return;
  const moved = Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y);
  const onGizmo = downInfo.onGizmo;
  downInfo = null;
  if (moved > 4 || onGizmo || e.button !== 0) return;
  const rect = el.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const proxies = state.objects.filter((o) => o.visible && rt.has(o.id)).map((o) => rt.get(o.id).proxy);
  const hit = raycaster.intersectObjects(proxies, false)[0];
  const id = hit ? hit.object.userData.id : null;
  if (id !== state.selected) select(id);
});

/* keyboard */

window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  const typing =
    tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && ['text', 'number'].includes(e.target.type));
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (state.selected) duplicateObject(state.selected);
    return;
  }
  if (mod) return;
  const k = e.key.toLowerCase();
  if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if (k === 'f') frameSelected();
  else if (k === 'escape') select(null);
  else if ((k === 'delete' || k === 'backspace') && state.selected) {
    e.preventDefault();
    removeObject(state.selected);
  }
});

function frameSelected() {
  const o = byId(state.selected);
  if (o) orbit.target.fromArray(o.pos);
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
    if (!data || !Array.isArray(data.objects)) throw new Error('not a Meshtype project');
    restore({ ...data, selected: null });
    commit();
    toast(`Opened ${file.name}`);
  } catch (err) {
    toast('Could not open that file: ' + err.message);
  }
});

/** The mesh to export: the boolean result, optionally with a plain material. */
function exportMesh() {
  const g = resultMesh.geometry;
  if (!g.attributes.position || g.attributes.position.count === 0) return null;
  if (el.strip.checked) {
    const clean = g.clone();
    clean.clearGroups();
    return new THREE.Mesh(clean, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
  }
  return new THREE.Mesh(g, resultMesh.material);
}

$('#btn-glb').addEventListener('click', async () => {
  if (dirty) solve();
  const mesh = exportMesh();
  if (!mesh) return toast('Nothing to export yet');
  mesh.name = slug(state.name);
  try {
    const buf = await new GLTFExporter().parseAsync(mesh, { binary: true });
    download(`${slug(state.name)}.glb`, new Blob([buf], { type: 'model/gltf-binary' }));
    toast(`Exported ${slug(state.name)}.glb`);
  } catch (err) {
    console.error(err);
    toast('GLB export failed: ' + err.message);
  }
});

$('#btn-obj').addEventListener('click', () => {
  if (dirty) solve();
  const mesh = exportMesh();
  if (!mesh) return toast('Nothing to export yet');
  mesh.name = slug(state.name);
  try {
    download(`${slug(state.name)}.obj`, new OBJExporter().parse(mesh), 'text/plain');
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

function loop() {
  requestAnimationFrame(loop);
  if (dirty && performance.now() - lastSolve > 70) solve();
  orbit.update();
  renderer.render(scene, camera);
}

function boot() {
  let data = null;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) data = JSON.parse(stored);
  } catch (e) {
    data = null;
  }
  if (!data || !Array.isArray(data.objects)) data = sampleProject();
  setMode('translate');
  applySnap();
  restore(data);
  commit();
  resize();
  solve();
  requestAnimationFrame(loop);
}

boot();

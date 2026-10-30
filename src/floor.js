// Baseplate floor presets. Textures are drawn procedurally on a canvas, so they
// work offline, cost nothing to ship, and export inside the GLB.

import * as THREE from 'three';

/** tile = size of one texture repeat in meters */
export const FLOORS = {
  carpet: { label: 'Aero carpet', tile: 1, props: { roughness: 1, metalness: 0 } },
  tile: { label: 'Office tile', tile: 0.6, props: { roughness: 0.5, metalness: 0 } },
  lab: { label: 'Glossy lab', tile: 1, props: { roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 } },
  grid: { label: 'Dark grid', tile: 1, props: { roughness: 0.35, metalness: 0.1 }, glow: true },
  concrete: { label: 'Concrete', tile: 2, props: { roughness: 0.92, metalness: 0 } },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(x, size, rand, count, colors, rMin, rMax) {
  for (let i = 0; i < count; i++) {
    x.fillStyle = colors[(rand() * colors.length) | 0];
    const r = rMin + rand() * (rMax - rMin);
    x.fillRect(rand() * size, rand() * size, r, r);
  }
}

function draw(id) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const rand = rng(1234);
  if (id === 'carpet') {
    x.fillStyle = '#3f8fb3';
    x.fillRect(0, 0, size, size);
    speckle(x, size, rand, 26000, ['#3684a6', '#4a9bbf', '#2f7799', '#56a7c9'], 1, 3);
  } else if (id === 'tile') {
    x.fillStyle = '#d9dde2';
    x.fillRect(0, 0, size, size);
    speckle(x, size, rand, 5000, ['#cfd4da', '#e2e5e9', '#c6ccd3'], 1, 3);
    x.strokeStyle = '#a9b0b8';
    x.lineWidth = 6;
    x.strokeRect(0, 0, size, size);
  } else if (id === 'lab') {
    x.fillStyle = '#f4f7fa';
    x.fillRect(0, 0, size, size);
    x.strokeStyle = '#cfd8e0';
    x.lineWidth = 3;
    for (let k = 0; k <= 2; k++) {
      x.beginPath();
      x.moveTo((k * size) / 2, 0);
      x.lineTo((k * size) / 2, size);
      x.moveTo(0, (k * size) / 2);
      x.lineTo(size, (k * size) / 2);
      x.stroke();
    }
  } else if (id === 'grid') {
    x.fillStyle = '#0d1b2a';
    x.fillRect(0, 0, size, size);
    x.strokeStyle = 'rgba(57,198,255,0.35)';
    x.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      x.beginPath();
      x.moveTo((k * size) / 4, 0);
      x.lineTo((k * size) / 4, size);
      x.moveTo(0, (k * size) / 4);
      x.lineTo(size, (k * size) / 4);
      x.stroke();
    }
    x.strokeStyle = '#39c6ff';
    x.lineWidth = 4;
    x.strokeRect(0, 0, size, size);
  } else {
    x.fillStyle = '#8d9196';
    x.fillRect(0, 0, size, size);
    for (let i = 0; i < 90; i++) {
      x.fillStyle = `rgba(${rand() < 0.5 ? '60,64,70' : '200,204,208'},${0.02 + rand() * 0.035})`;
      x.beginPath();
      x.arc(rand() * size, rand() * size, 20 + rand() * 70, 0, Math.PI * 2);
      x.fill();
    }
    speckle(x, size, rand, 14000, ['#7f8388', '#9a9ea3', '#6f7378', '#a7abaf'], 1, 2);
  }
  return c;
}

const cache = new Map();

/** A material for the preset. One shared instance per preset; the caller sets repeat. */
export function floorMaterial(id) {
  const key = FLOORS[id] ? id : 'tile';
  if (cache.has(key)) return cache.get(key);
  const f = FLOORS[key];
  const tex = new THREE.CanvasTexture(draw(key));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  const mat = new THREE.MeshPhysicalMaterial({ map: tex, ...f.props });
  if (f.glow) {
    mat.emissiveMap = tex;
    mat.emissive.set('#ffffff');
    mat.emissiveIntensity = 0.45;
  }
  mat.name = `floor-${key}`;
  cache.set(key, mat);
  return mat;
}

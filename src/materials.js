// Frutiger Aero material presets + a procedural sky for reflections.

import * as THREE from 'three';

export const MATERIALS = {
  glass: {
    label: 'Aero glass',
    color: '#8fdcff',
    props: {
      roughness: 0.04, transmission: 0.92, thickness: 0.5, ior: 1.45,
      clearcoat: 1, clearcoatRoughness: 0.02,
      attenuationDistance: 1.5, envMapIntensity: 1.3,
    },
  },
  gloss: {
    label: 'Gloss plastic',
    color: '#2aa8ff',
    props: { roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.2 },
  },
  bubble: {
    label: 'Bubble',
    color: '#ffffff',
    props: {
      roughness: 0, transmission: 1, thickness: 0.06, ior: 1.15,
      iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [200, 520],
      envMapIntensity: 1.6,
    },
  },
  frosted: {
    label: 'Frosted glass',
    color: '#eef8ff',
    // rough transmission blurs whatever is behind it; the thin clearcoat keeps a glossy skin on top
    props: {
      roughness: 0.62, transmission: 1, thickness: 0.8, ior: 1.45, attenuationDistance: 4,
      clearcoat: 0.6, clearcoatRoughness: 0.1, envMapIntensity: 1.1,
    },
  },
  chrome: {
    label: 'Chrome',
    color: '#e8f0f6',
    props: { metalness: 1, roughness: 0.08, envMapIntensity: 1.3 },
  },
  matte: {
    label: 'Matte',
    color: '#d9e6ee',
    props: { roughness: 0.9 },
  },
  glow: {
    label: 'Glow',
    color: '#7dffb0',
    emissive: true,
    godot: true,
    props: { roughness: 0.3, emissiveIntensity: 2.2 },
  },
  // Plain metal/roughness/emission/alpha materials: these import into Godot as-is.
  satin: { label: 'Satin plastic', color: '#e8eef4', godot: true, props: { roughness: 0.45 } },
  rubber: { label: 'Rubber', color: '#2b2f35', godot: true, props: { roughness: 0.95 } },
  painted: { label: 'Painted metal', color: '#3d8fd1', godot: true, props: { metalness: 0.55, roughness: 0.35 } },
  steel: { label: 'Brushed steel', color: '#c9d1d9', godot: true, props: { metalness: 1, roughness: 0.38 } },
  mirror: { label: 'Mirror', color: '#ffffff', godot: true, props: { metalness: 1, roughness: 0.02 } },
  ceramic: { label: 'Ceramic', color: '#f4f7fa', godot: true, props: { roughness: 0.12 } },
  concrete: { label: 'Concrete', color: '#9a9ea3', godot: true, props: { roughness: 0.92 } },
  wood: { label: 'Wood (color)', color: '#9a6b43', godot: true, props: { roughness: 0.65 } },
  acrylic: { label: 'Clear acrylic', color: '#d8f2ff', godot: true, props: { roughness: 0.05, transparent: true, opacity: 0.3, depthWrite: false } },
  tinted: { label: 'Tinted glass (Godot)', color: '#5ab8e8', godot: true, props: { roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.45, depthWrite: false } },
  frost: { label: 'Frosted glass (Godot)', color: '#e8f4fb', godot: true, props: { roughness: 0.75, transparent: true, opacity: 0.62, depthWrite: false } },
  // Neon glows, lights the room (its object light turns on by itself) and backlights an image texture
  neon: { label: 'Neon', color: '#39c6ff', emissive: true, autoLight: true, godot: true, props: { roughness: 0.2, emissiveIntensity: 4 } },
};

for (const k of ['matte', 'chrome']) if (MATERIALS[k]) MATERIALS[k].godot = true;

const BASE = {
  metalness: 0, roughness: 0.5, transmission: 0, thickness: 0, ior: 1.5,
  clearcoat: 0, clearcoatRoughness: 0, iridescence: 0, iridescenceIOR: 1.3,
  iridescenceThicknessRange: [100, 400], attenuationDistance: Infinity,
  specularIntensity: 1, envMapIntensity: 1, emissiveIntensity: 0,
  transparent: false, opacity: 1, depthWrite: true,
};

/** Reset a MeshPhysicalMaterial to a preset, tinted with `color`. Edits in place. */
export function applyMaterial(mat, presetId, color) {
  const preset = MATERIALS[presetId] || MATERIALS.glass;
  const tint = color || preset.color;
  const props = { ...BASE, ...preset.props };
  for (const [k, v] of Object.entries(props)) {
    mat[k] = Array.isArray(v) ? v.slice() : v;
  }
  mat.color.set(tint);
  mat.attenuationColor.set(tint);
  mat.emissive.set(preset.emissive ? tint : '#000000');
  mat.needsUpdate = true;
}

/** Bright Aero sky: gradient, soft clouds, a sun. Returns the sky texture and a PMREM env map. */
export function makeAeroEnvironment(renderer) {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#1f7fd8');
  grad.addColorStop(0.3, '#58b9f5');
  grad.addColorStop(0.46, '#d4f3ff');
  grad.addColorStop(0.5, '#ffffff');
  grad.addColorStop(0.54, '#c9efc4');
  grad.addColorStop(0.76, '#7cc66f');
  grad.addColorStop(1.0, '#3f8f4f');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  const blob = (x, y, r, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(255,255,255,${a})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const cloud = (x, y, s) => {
    blob(x, y, 60 * s, 0.9);
    blob(x - 55 * s, y + 12 * s, 45 * s, 0.85);
    blob(x + 58 * s, y + 10 * s, 48 * s, 0.85);
    blob(x + 12 * s, y - 18 * s, 40 * s, 0.8);
  };
  cloud(140, 120, 1.1);
  cloud(420, 90, 0.8);
  cloud(860, 150, 1.0);
  cloud(300, 190, 0.7);
  blob(720, 110, 240, 0.35);
  blob(720, 110, 70, 1);

  const sky = new THREE.CanvasTexture(canvas);
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(sky).texture;
  pmrem.dispose();
  return { sky, envMap };
}

/**
 * "Clear sky": deep blue overhead, wispy cirrus, a bright hazy horizon and a calm dark ocean
 * mirroring it below. Cooler and less green than the Aero sky, so reflections read neutral.
 */
export function makeClearSkyEnvironment(renderer) {
  const w = 2048;
  const h = 1024;
  const half = h / 2;
  const sky = document.createElement('canvas');
  sky.width = w;
  sky.height = half;
  const g = sky.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, half);
  grad.addColorStop(0, '#1b4596');
  grad.addColorStop(0.35, '#2f6cc4');
  grad.addColorStop(0.7, '#6fa3dc');
  grad.addColorStop(0.9, '#c9dcef');
  grad.addColorStop(1, '#eef2f5');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, half);
  // seeded so the sky is the same every load
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.filter = 'blur(5px)';
  for (let i = 0; i < 520; i++) {
    const y = half * (0.25 + 0.72 * Math.pow(rand(), 0.6)); // thicker toward the horizon
    const x = rand() * w;
    const near = y / half;
    const len = (90 + rand() * 420) * (0.6 + near);
    const th = (3 + rand() * 14) * (1.2 - near * 0.6);
    g.save();
    g.translate(x, y);
    g.rotate((rand() - 0.5) * 0.35);
    g.fillStyle = `rgba(255,255,255,${0.05 + rand() * 0.16})`;
    g.beginPath();
    g.ellipse(0, 0, len, th, 0, 0, Math.PI * 2);
    g.fill();
    if (x + len > w) {
      g.translate(-w, 0);
      g.fill();
    }
    g.restore();
  }
  g.filter = 'none';
  // horizon haze
  const haze = g.createLinearGradient(0, half * 0.78, 0, half);
  haze.addColorStop(0, 'rgba(240,244,247,0)');
  haze.addColorStop(1, 'rgba(240,244,247,0.9)');
  g.fillStyle = haze;
  g.fillRect(0, half * 0.78, w, half * 0.22);
  // sun
  const sx = w * 0.62;
  const sy = half * 0.42;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 260);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.08, 'rgba(255,255,250,0.95)');
  glow.addColorStop(0.3, 'rgba(255,255,245,0.25)');
  glow.addColorStop(1, 'rgba(255,255,245,0)');
  g.fillStyle = glow;
  g.fillRect(sx - 260, sy - 260, 520, 520);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.drawImage(sky, 0, 0);
  // the ocean: a darker, slightly blurred mirror of the sky, fading to navy below
  c.save();
  c.translate(0, h);
  c.scale(1, -1);
  c.filter = 'blur(3px)';
  c.globalAlpha = 0.85;
  c.drawImage(sky, 0, 0);
  c.restore();
  const sea = c.createLinearGradient(0, half, 0, h);
  sea.addColorStop(0, 'rgba(200,214,228,0.15)');
  sea.addColorStop(0.12, 'rgba(30,60,110,0.45)');
  sea.addColorStop(0.5, 'rgba(12,28,60,0.82)');
  sea.addColorStop(1, 'rgba(6,14,32,0.95)');
  c.fillStyle = sea;
  c.fillRect(0, half, w, half);
  // sun glint on the water
  const gy = h - sy;
  const glint = c.createRadialGradient(sx, gy, 0, sx, gy, 160);
  glint.addColorStop(0, 'rgba(255,255,255,0.75)');
  glint.addColorStop(1, 'rgba(255,255,255,0)');
  c.save();
  c.translate(sx, gy);
  c.scale(0.45, 1.6);
  c.translate(-sx, -gy);
  c.fillStyle = glint;
  c.fillRect(sx - 160, gy - 160, 320, 320);
  c.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  return { sky: tex, envMap };
}

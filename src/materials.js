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
    color: '#e6f6ff',
    props: { roughness: 0.5, transmission: 0.85, thickness: 0.6, ior: 1.4, attenuationDistance: 3 },
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
    props: { roughness: 0.3, emissiveIntensity: 2.2 },
  },
};

const BASE = {
  metalness: 0, roughness: 0.5, transmission: 0, thickness: 0, ior: 1.5,
  clearcoat: 0, clearcoatRoughness: 0, iridescence: 0, iridescenceIOR: 1.3,
  iridescenceThicknessRange: [100, 400], attenuationDistance: Infinity,
  specularIntensity: 1, envMapIntensity: 1, emissiveIntensity: 0,
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

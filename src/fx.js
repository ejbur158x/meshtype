// Viewport looks: ambient occlusion, sun shadows, glow bloom, edge outlines, clay mode.
// Editor only. Godot does its own lighting on import, so none of this changes the export.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Meshes on this layer are "the model": AO and outlines look only at them (not gizmos, grids, handles). */
export const MODEL_LAYER = 2;

export const FX_DEFAULTS = {
  ao: { on: true, radius: 0.5, strength: 1, falloff: 1 },
  shadows: { on: true, quality: 2048, softness: 3, darkness: 0.8, lamps: false },
  bloom: { on: true, strength: 0.35, radius: 0.3, threshold: 1.3 },
  outline: { on: false, width: 1, darkness: 0.75, color: '#0b2a44' },
  clay: { on: false, color: '#d8d3cb', glow: true },
  xray: { on: false, ghost: true, wire: true, opacity: 0.5 },
};

const LIMITS = {
  'ao.radius': [0.05, 3], 'ao.strength': [0, 1.5], 'ao.falloff': [0.5, 3],
  'shadows.softness': [0, 10], 'shadows.darkness': [0, 1],
  'bloom.strength': [0, 3], 'bloom.radius': [0, 1], 'bloom.threshold': [0.2, 3],
  'outline.width': [0.5, 4], 'outline.darkness': [0, 1], 'xray.opacity': [0.05, 0.95],
};
const HEX = /^#[0-9a-f]{6}$/i;

export function sanitizeFx(raw) {
  const out = JSON.parse(JSON.stringify(FX_DEFAULTS));
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [grp, defs] of Object.entries(out)) {
    const g = src[grp] && typeof src[grp] === 'object' ? src[grp] : {};
    for (const [k, d] of Object.entries(defs)) {
      const v = g[k];
      if (typeof d === 'boolean') defs[k] = typeof v === 'boolean' ? v : d;
      else if (typeof d === 'string') defs[k] = typeof v === 'string' && HEX.test(v) ? v : d;
      else if (k === 'quality') defs[k] = [1024, 2048, 4096].includes(Number(v)) ? Number(v) : d;
      else {
        const lim = LIMITS[`${grp}.${k}`] || [-Infinity, Infinity];
        const n = Number(v);
        defs[k] = Number.isFinite(n) ? Math.min(lim[1], Math.max(lim[0], n)) : d;
      }
    }
  }
  return out;
}

/** Screen-space edges from a normal + depth prepass, darkened over the image. */
const EdgeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    width: { value: 1 },
    darkness: { value: 0.75 },
    color: { value: new THREE.Color('#0b2a44') },
    cameraNear: { value: 0.05 },
    cameraFar: { value: 200 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tNormal, tDepth;
    uniform vec2 resolution;
    uniform float width, darkness, cameraNear, cameraFar;
    uniform vec3 color;
    varying vec2 vUv;
    float lin(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
    }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      vec2 px = width / resolution;
      float d = lin(vUv);
      vec3 n = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
      float dd = 0.0, nd = 0.0;
      vec2 offs[4];
      offs[0] = vec2(px.x, 0.0); offs[1] = vec2(-px.x, 0.0); offs[2] = vec2(0.0, px.y); offs[3] = vec2(0.0, -px.y);
      for (int i = 0; i < 4; i++) {
        float di = lin(vUv + offs[i]);
        dd = max(dd, abs(di - d) / max(min(d, di), 1e-3));
        vec3 ni = texture2D(tNormal, vUv + offs[i]).xyz * 2.0 - 1.0;
        nd = max(nd, 1.0 - dot(n, ni));
      }
      float edge = max(smoothstep(0.03, 0.09, dd), smoothstep(0.2, 0.5, nd));
      gl_FragColor = vec4(mix(col.rgb, color, edge * darkness), col.a);
    }`,
};

export function createFx({ renderer, scene, camera }) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  // multisampled, or edges go jaggy the moment any effect is on
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x || 1, size.y || 1, { type: THREE.HalfFloatType, samples: 4 }));
  const renderPass = new RenderPass(scene, camera);
  // AO looks through a twin camera that only sees the model layer
  const aoCam = new THREE.PerspectiveCamera();
  const gtao = new GTAOPass(scene, aoCam, size.x || 1, size.y || 1);
  const edges = new ShaderPass(EdgeShader);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x || 1, size.y || 1), 0.35, 0.3, 1.3);
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(gtao);
  composer.addPass(edges);
  composer.addPass(bloom);
  composer.addPass(output);

  const nd = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  nd.depthTexture = new THREE.DepthTexture(1, 1);
  const normalMat = new THREE.MeshNormalMaterial();
  const clayMat = new THREE.MeshStandardMaterial({ color: '#d8d3cb', roughness: 0.85, metalness: 0 });
  const clayGlow = new Map(); // emissive color hex -> clay that still glows
  // X-ray: see-through copies of each look, and wire lines drawn over everything
  const ghosts = new Map();
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x0a6fd8, wireframe: true, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  let s = sanitizeFx(null);

  function setSize(w, h) {
    composer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    nd.setSize(Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)));
    edges.uniforms.resolution.value.set(Math.max(1, w * pr), Math.max(1, h * pr));
  }

  function set(next) {
    s = sanitizeFx(next);
    gtao.updateGtaoMaterial({ radius: s.ao.radius, distanceExponent: s.ao.falloff, thickness: 1, scale: 1 });
    gtao.blendIntensity = s.ao.strength;
    bloom.strength = s.bloom.strength;
    bloom.radius = s.bloom.radius;
    bloom.threshold = s.bloom.threshold;
    edges.uniforms.width.value = s.outline.width;
    edges.uniforms.darkness.value = s.outline.darkness;
    edges.uniforms.color.value.set(s.outline.color);
    clayMat.color.set(s.clay.color);
    for (const m of clayGlow.values()) m.color.set(s.clay.color);
    const wantShadows = s.shadows.on;
    if (renderer.shadowMap.enabled !== wantShadows) {
      renderer.shadowMap.enabled = wantShadows;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      // materials pick the shadow chunk at compile time
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
    return s;
  }

  function prepassNormals() {
    const mask = camera.layers.mask;
    const bg = scene.background;
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    camera.layers.set(MODEL_LAYER);
    scene.background = null;
    scene.overrideMaterial = normalMat;
    renderer.setRenderTarget(nd);
    renderer.setClearColor(0x8080ff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    scene.background = bg;
    camera.layers.mask = mask;
    renderer.setClearColor(clear, alpha);
    edges.uniforms.tNormal.value = nd.texture;
    edges.uniforms.tDepth.value = nd.depthTexture;
    edges.uniforms.cameraNear.value = camera.near;
    edges.uniforms.cameraFar.value = camera.far;
  }

  function ghostFor(m) {
    const src = Array.isArray(m) ? m[0] : m;
    const hex = src && src.color ? src.color.getHexString() : 'cccccc';
    const key = hex + '|' + s.xray.opacity;
    let g = ghosts.get(key);
    if (!g) {
      g = new THREE.MeshStandardMaterial({ color: '#' + hex, roughness: 0.6, transparent: true, opacity: s.xray.opacity, depthWrite: false, side: THREE.DoubleSide });
      ghosts.set(key, g);
    }
    return g;
  }

  function clayFor(m) {
    if (!s.clay.glow || !m || Array.isArray(m) || !(m.emissiveIntensity > 0) || !m.emissive) return clayMat;
    const key = m.emissive.getHexString() + '|' + m.emissiveIntensity;
    let c = clayGlow.get(key);
    if (!c) {
      c = clayMat.clone();
      c.emissive.copy(m.emissive);
      c.emissiveIntensity = m.emissiveIntensity;
      clayGlow.set(key, c);
    }
    return c;
  }

  /** Draw a frame. `models` are the meshes clay mode repaints. */
  function render(models) {
    const swapped = [];
    const xr = s.xray.on && s.xray.ghost;
    if (s.clay.on || xr) {
      for (const m of models) {
        if (!m || !m.visible) continue;
        swapped.push([m, m.material]);
        m.material = xr ? ghostFor(s.clay.on ? clayMat : m.material) : clayFor(m.material);
      }
    }
    const post = s.ao.on || s.bloom.on || s.outline.on;
    if (!post) renderer.render(scene, camera);
    else {
      camera.updateMatrixWorld();
      if (s.ao.on) {
        aoCam.copy(camera);
        aoCam.layers.set(MODEL_LAYER);
      }
      if (s.outline.on) prepassNormals();
      gtao.enabled = s.ao.on;
      edges.enabled = s.outline.on;
      bloom.enabled = s.bloom.on;
      composer.render();
    }
    if (s.xray.on && s.xray.wire) {
      // every model edge on top, so you can see how things line up behind each other
      const mask = camera.layers.mask;
      const bg = scene.background;
      const auto = renderer.autoClear;
      camera.layers.set(MODEL_LAYER);
      scene.background = null;
      scene.overrideMaterial = wireMat;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = auto;
      scene.overrideMaterial = null;
      scene.background = bg;
      camera.layers.mask = mask;
    }
    for (const [m, mat] of swapped) m.material = mat;
  }

  return { set, setSize, render, get: () => s };
}

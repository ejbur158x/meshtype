// v0.8: object lights, Light (Invis), neon lightbox, decals, Look panel, axis tripod. Serve on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(90000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
// 2x1 PNG: red | transparent
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4GBgQEADPwB//0td20AAAAASUVORK5CYII=';
const seed = {
  app: 'meshtype', name: 'looks', nextId: 30, sel: [], assets: { img1: IMG }, floor: { grid: 0.5, show: true }, floors: [],
  nodes: [
    { kind: 'part', id: 1, name: 'Wall', type: 'box', params: { bend: 0 }, pos: [0, 1.5, 0], rot: [0, 0, 0], scl: [4, 3, 0.2], mat: 'matte', color: '#dde6ee', visible: true,
      decals: [{ tex: 'img1', face: 'pz', x: 0, y: 0, w: 1 }] },
    { kind: 'part', id: 2, name: 'Lamp', type: 'squircle', params: { nPlan: 2, nProf: 10, detail: 2 }, pos: [0, 2.8, 1.5], rot: [0, 0, 0], scl: [0.6, 0.1, 0.6], mat: 'glow', color: '#ffffff', visible: true,
      light: { on: true } },
    { kind: 'part', id: 3, name: 'Sign', type: 'box', params: { bend: 0 }, pos: [2.5, 1, 1], rot: [0, 0, 0], scl: [1, 0.5, 0.05], mat: 'matte', color: '#ffffff', visible: true, tex: 'img1', texSize: 1 },
    { kind: 'part', id: 4, name: 'Curve', type: 'box', params: { bend: 90 }, pos: [-3, 1, 0], rot: [0, 0, 0], scl: [4, 2, 0.2], mat: 'matte', color: '#ffffff', visible: true, tex: 'img1', texSize: 1 },
  ],
};
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
// effects off while testing editing: software GL is slow (turned on again in the Look panel test)
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); localStorage.setItem('meshtype.fx', JSON.stringify({ ao: { on: false }, shadows: { on: false }, bloom: { on: false } })); }, seed);
await page.reload();
await page.waitForTimeout(2500);

// one "Light (Invis)" button, spot by default
ok('single Light (Invis) add button', (await page.locator('[data-add-light]').count()) === 1 && (await page.textContent('[data-add-light]')).includes('Light (Invis)'));
await page.click('[data-add-light]');
await page.waitForTimeout(200);
let s = await st();
const inv = s.nodes.find((n) => n.kind === 'light');
ok('invisible light is a spot', inv && inv.lightType === 'spot');
ok('inspector says Light (Invis)', (await page.textContent('#inspector')).includes('Light (Invis)'));

// object light: spot pointing down, sits below the lamp
const pose = await page.evaluate(() => { const l = __mt.plt.get(2); return l && { type: l.light.type, y: l.light.position.y, ty: l.light.target.position.y }; });
ok('lamp part has a spot light under it', pose && pose.type === 'SpotLight' && pose.y < 2.76 && pose.ty < pose.y, JSON.stringify(pose));

// inspector: Lamp -> light section, aim up, switch to point
await page.locator('#list li', { hasText: 'Lamp' }).first().click();
ok('part inspector has Emit light', await page.isChecked('#pl-on'));
await page.click('[data-plaim="up"]');
await page.waitForTimeout(100);
const up = await page.evaluate(() => { const l = __mt.plt.get(2); return [l.light.position.y, l.light.target.position.y]; });
ok('aim up moves the spot above the lamp', up[0] > 2.84 && up[1] > up[0], JSON.stringify(up));
await page.click('[data-pltype="point"]');
await page.waitForTimeout(100);
ok('switch to point light', await page.evaluate(() => __mt.plt.get(2).light.type === 'PointLight'));
await page.uncheck('#pl-on');
await page.waitForTimeout(100);
ok('turning it off removes the light', await page.evaluate(() => !__mt.plt.has(2)));

// neon: switching on adds its light, textured neon glows with the image
await page.locator('#list li', { hasText: 'Sign' }).first().click();
await page.selectOption('#f-mat', 'neon');
await page.waitForTimeout(300);
s = await st();
const sign = s.nodes.find((n) => n.id === 3);
ok('neon turns its light on', sign.light && sign.light.on && sign.light.auto === true, JSON.stringify(sign.light));
ok('neon + image = lightbox (emissive map)', await page.evaluate(() => !!__mt.rt.get(3).material.emissiveMap));
ok('neon light color follows image (red)', await page.evaluate(() => { const c = __mt.plt.get(3).light.color; return c.r > 0.5 && c.g < 0.2; }));
ok('glow strength slider shows', await page.isVisible('[data-glow]'));
await page.selectOption('#f-mat', 'matte');
await page.waitForTimeout(200);
s = await st();
ok('leaving neon removes the automatic light', !s.nodes.find((n) => n.id === 3).light);

// decal on the wall
const dec = await page.evaluate(() => { const r = __mt.rt.get(1); return r.decalMeshes.length && r.decalMeshes[0].mesh.geometry.attributes.position.count; });
ok('wall decal mesh built', dec > 0, String(dec));
await page.locator('#list li', { hasText: 'Wall' }).first().click();
ok('decal controls in inspector', await page.isVisible('[data-dc="0"][data-dk="w"]'));
await page.selectOption('[data-dc="0"][data-dk="face"]', 'nz');
await page.waitForTimeout(200);
s = await st();
ok('decal moved to back face', s.nodes.find((n) => n.id === 1).decals[0].face === 'nz');

// curved wall UVs follow the arc (uv range ~ arc length 4 m on the front face)
const span = await page.evaluate(() => { const uv = __mt.rt.get(4).geo.attributes.uv; let a = Infinity, b = -Infinity; for (let i = 0; i < uv.count; i++) { a = Math.min(a, uv.getX(i)); b = Math.max(b, uv.getX(i)); } return b - a; });
ok('curved wall UVs span its arc length', Math.abs(span - 4) < 0.05, span.toFixed(3));
// stretched box: UVs in meters, image keeps its proportions
const wspan = await page.evaluate(() => { const uv = __mt.rt.get(1).geo.attributes.uv; let a = Infinity, b = -Infinity; for (let i = 0; i < uv.count; i++) { a = Math.min(a, uv.getX(i)); b = Math.max(b, uv.getX(i)); } return b - a; });
ok('stretched box UVs in meters', Math.abs(wspan - 4) < 0.01, wspan.toFixed(3));

// export: decal mesh + object light in the GLB scene graph and manifest
await page.locator('#list li', { hasText: 'Lamp' }).first().click();
await page.check('#pl-on');
await page.waitForTimeout(100);
const ex = await page.evaluate(async () => { const o = await __mt.exportRoom(); const names = []; o.grp.traverse((c) => names.push(c.name)); return { names, lights: o.manifest.lights.map((l) => [l.node, l.attachedTo || null]) }; });
ok('export has decal mesh', ex.names.some((n) => /wall-decal1/.test(n)), ex.names.join(','));
ok('export has lamp light attached', ex.lights.some(([n, a]) => /lamp-light/.test(n) && a === 'lamp'), JSON.stringify(ex.lights));

// Look panel
await page.click('#btn-fx');
ok('look panel opens with 5 sections', (await page.locator('#fx-panel .fxsec').count()) === 5);
await page.check('[data-fx="outline.on"]');
await page.check('[data-fx="clay.on"]');
await page.waitForTimeout(200);
ok('outline settings appear when on', await page.isVisible('[data-fx="outline.width"]'));
const fxs = await page.evaluate(() => __mt.fx.get());
ok('fx state updated', fxs.outline.on && fxs.clay.on && !fxs.ao.on);
await page.check('[data-fx="ao.on"]');
await page.check('[data-fx="shadows.on"]');
ok('ao + shadows on with their settings', await page.isVisible('[data-fx="ao.radius"]') && await page.isVisible('[data-fx="shadows.softness"]') && await page.evaluate(() => __mt.fx.get().shadows.on));
ok('fx saved', await page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.fx')).clay.on === true));
await page.waitForTimeout(500);
await page.screenshot({ path: '/home/claude/scratch/looks-clay.png' });
await page.uncheck('[data-fx="clay.on"]');
await page.uncheck('[data-fx="outline.on"]');
await page.click('#btn-fx');
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/claude/scratch/looks.png' });

// axis tripod
ok('axis tripod drawn', (await page.locator('#vc-axes text').count()) === 3);

ok('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
await browser.close();
process.exit(failures ? 1 : 0);

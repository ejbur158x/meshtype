// v0.8.1: Box/Cylinder/Arch shapes, editor FOV, spawn figure + walk mode (collide, gravity). Serve on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(90000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const B = (id, name, pos, scl, extra = {}) => ({ kind: 'part', id, name, type: 'box', params: { bend: 0 }, pos, rot: [0, 0, 0], scl, mat: 'matte', color: '#dde6ee', visible: true, ...extra });
const seed = {
  app: 'meshtype', name: 'walk', nextId: 40, sel: [], assets: {}, floor: { grid: 0.5, show: true },
  floors: [{ id: 30, name: 'Floor', pos: [0, 0, 0], rotY: 0, w: 10, d: 10, preset: 'tile' }],
  nodes: [
    B(1, 'Wall N', [0, 1.5, -3], [8, 3, 0.2]),
    B(2, 'Step', [0, 0.15, 1.5], [2, 0.3, 1]),
    B(3, 'Ghost', [2, 1, 0], [1, 2, 1], { tags: ['no-collide'] }),
  ],
};
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload();
await page.waitForTimeout(2500);

// shapes
ok('no Wall button, Box/Cylinder/Arch present', (await page.locator('[data-add="wall"]').count()) === 0 && (await page.locator('[data-add="cylinder"]').count()) === 1 && (await page.locator('[data-add="arch"]').count()) === 1);
await page.click('[data-add="box"]');
let s = await st();
ok('new Box is a 1 m cube', s.nodes.at(-1).scl.join() === '1,1,1');
await page.click('[data-add="cylinder"]');
s = await st();
const cyl = s.nodes.at(-1);
ok('cylinder part', cyl.type === 'cylinder' && cyl.pos[1] === 0.5);
await page.click('[data-add="arch"]');
s = await st();
const arch = s.nodes.at(-1);
ok('arch part 1.2 x 2.4', arch.type === 'arch' && arch.scl.join() === '1.2,2.4,0.4');
const bb = await page.evaluate((id) => { const g = __mt.rt.get(id).geo; g.computeBoundingBox(); const b = g.boundingBox; return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, __mt.rt.get(id).proxy.scale.x]; }, arch.id);
ok('arch built at real size, unscaled mesh', Math.abs(bb[0] - 1.2) < 1e-3 && Math.abs(bb[1] - 2.4) < 1e-3 && Math.abs(bb[2] - 0.4) < 1e-3 && bb[3] === 1, JSON.stringify(bb));
// the top is a half circle: at x = 0 the top is at +1.2, at the springline (x=±0.6) it's 0.6
const top = await page.evaluate((id) => { const p = __mt.rt.get(id).geo.attributes.position; let yAtEdge = -9; for (let i = 0; i < p.count; i++) if (Math.abs(Math.abs(p.getX(i)) - 0.6) < 1e-4) yAtEdge = Math.max(yAtEdge, p.getY(i)); return yAtEdge; }, arch.id);
ok('arch springs at half the width below the top', Math.abs(top - 0.6) < 1e-3, String(top));
ok('arch roundness slider', await page.isVisible('[data-param="round"]'));
await page.$eval('[data-param="round"]', (e) => { e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
const flat = await page.evaluate((id) => { const p = __mt.rt.get(id).geo.attributes.position; let y = -9; for (let i = 0; i < p.count; i++) if (Math.abs(Math.abs(p.getX(i)) - 0.6) < 1e-4) y = Math.max(y, p.getY(i)); return y; }, arch.id);
ok('roundness 0 = flat top', Math.abs(flat - 1.2) < 1e-3, String(flat));
// back to the seed scene so the test shapes at the origin don't block the walk
await page.evaluate((s) => { localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload();
await page.waitForTimeout(2500);

// X-ray toggle
await page.keyboard.press('z');
ok('Z toggles X-ray', await page.evaluate(() => __mt.fx.get().xray.on) && (await page.getAttribute('#btn-xray', 'aria-pressed')) === 'true');
await page.click('#btn-xray');
ok('X-ray button turns it off', await page.evaluate(() => !__mt.fx.get().xray.on));
// Clear sky
await page.click('#btn-sky');
await page.click('[data-sky="clear"]');
ok('Clear sky drives reflections', await page.evaluate(() => __mt.sceneEnv() !== null && __mt.sceneEnv() !== __mt.aeroEnv()));
await page.click('#btn-sky');

// editor FOV
await page.click('#btn-fx');
await page.$eval('#fx-fov', (e) => { e.value = '70'; e.dispatchEvent(new Event('input', { bubbles: true })); });
ok('editor FOV changes the camera', await page.evaluate(() => __mt.camera.fov === 70));
await page.click('#btn-fx');

// spawn: click the figure, hover, click the floor
await page.click('#btn-spawn');
ok('placing mode', (await page.getAttribute('#btn-spawn', 'aria-pressed')) === 'true');
// look straight down at the floor center so the click lands near (0,0,0)
await page.evaluate(() => { const c = __mt.camera; c.position.set(0, 12, 0.001); c.lookAt(0, 0, 0); });
await page.waitForTimeout(300);
const box = await page.locator('#view').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(500);
s = await st();
ok('spawn saved on the floor', s.spawn && Math.abs(s.spawn.pos[1]) < 0.01 && Math.hypot(s.spawn.pos[0], s.spawn.pos[2]) < 0.5, JSON.stringify(s.spawn));
ok('walk mode started after placing', await page.evaluate(() => document.body.classList.contains('walking')));
ok('walk FOV in use', await page.evaluate(() => __mt.camera.fov === 75));
ok('camera at eye height', await page.evaluate(() => Math.abs(__mt.camera.position.y - 1.6) < 0.05));

// face the wall (-Z) and walk into it: collision stops us before z = -3
// (physics stepped directly at 60 Hz: software GL renders too slowly to walk in real time)
await page.evaluate(() => { const w = __mt.walkState(); w.yaw = 0; });
const z = await page.evaluate(() => __mt.walkSim(['w'], 4)[2]);
ok('wall stops the player', z > -2.95 && z < -2.3, z.toFixed(3));
// walk onto the 30 cm step (+Z)
await page.evaluate(() => { const w = __mt.walkState(); w.feet.set(0, 0, 0); w.yaw = Math.PI; });
const fy = await page.evaluate(() => __mt.walkSim(['w'], 1.2));
ok('stepped up onto the step', Math.abs(fy[1] - 0.3) < 0.03, JSON.stringify(fy));
// no-collide part: walk through it
await page.evaluate(() => { const w = __mt.walkState(); w.feet.set(0.8, 0, 0); w.yaw = -Math.PI / 2; });
const gx = await page.evaluate(() => __mt.walkSim(['w'], 2)[0]);
ok('walks through no-collide parts', gx > 2.6, gx.toFixed(2));
// gravity off: stays at height
await page.$eval('[data-walk="gravity"]', (e) => { e.checked = false; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.evaluate(() => { const w = __mt.walkState(); w.feet.set(0, 1, 0); });
ok('gravity off: no fall', await page.evaluate(() => Math.abs(__mt.walkSim([], 1)[1] - 1) < 0.01));
await page.$eval('[data-walk="gravity"]', (e) => { e.checked = true; e.dispatchEvent(new Event('input', { bubbles: true })); });
ok('gravity on: falls to the floor', await page.evaluate(() => __mt.walkSim([], 1.5)[1] < 0.05));
// Esc leaves walk mode and restores the editor camera FOV
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok('Esc stops walking', await page.evaluate(() => !document.body.classList.contains('walking') && __mt.camera.fov === 70));

// export has the spawn node
const ex = await page.evaluate(async () => { const o = await __mt.exportRoom(); return o.manifest.spawn; });
ok('spawn exported', ex && ex.node === 'spawn' && ex.forward.length === 3, JSON.stringify(ex));

ok('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
await browser.close();
process.exit(failures ? 1 : 0);

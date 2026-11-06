// v0.8.3: sharp big textures (pixel budget, SVG at size), light undo history, walk drawer, head bob, look smoothing.
// Serve on :8123 first.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(90000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const B = (id, name, pos, scl) => ({ kind: 'part', id, name, type: 'box', params: { bend: 0 }, pos, rot: [0, 0, 0], scl, mat: 'matte', color: '#dde6ee', visible: true });
const seed = {
  app: 'meshtype', name: 'feel', nextId: 40, sel: [], assets: {}, floor: { grid: 0.5, show: true },
  floors: [{ id: 30, name: 'Floor', pos: [0, 0, 0], rotY: 0, w: 10, d: 10, preset: 'tile' }],
  spawn: { pos: [0, 0, 0], yaw: 0 },
  nodes: [B(1, 'Wall N', [0, 1.5, -6], [8, 3, 0.2]), B(2, 'Wall S', [0, 1.5, 6], [8, 3, 0.2])],
};
const dir = '/tmp/mt-feel';
mkdirSync(dir, { recursive: true });
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload();
await page.waitForTimeout(2500);

// ---- images: made in the page, uploaded through the real file input
async function makePng(w, h, file) {
  const url = await page.evaluate(([w, h]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#4ab540'; g.beginPath(); g.ellipse(w / 2, h / 2, w / 4, h / 3, 0, 0, Math.PI * 2); g.fill();
    return c.toDataURL('image/png');
  }, [w, h]);
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}
const dims = (id) => page.evaluate(async (id) => {
  const url = __mt.getState().assets[id];
  const im = new Image();
  im.src = url;
  await im.decode();
  return [im.naturalWidth, im.naturalHeight, url.length];
}, id);
const pick = (id) => page.evaluate((id) => { const s = __mt.getState(); s.sel = [id]; s.active = id; }, id);

await makePng(6000, 1000, `${dir}/wide.png`);
await pick(1);
await page.setInputFiles('#file-tex', `${dir}/wide.png`);
await page.waitForTimeout(1500);
let s = await st();
const t1 = s.nodes.find((n) => n.id === 1).tex;
let d = await dims(t1);
ok('6000x1000 PNG keeps its resolution (was crushed to 1024)', d[0] === 6000 && d[1] === 1000, JSON.stringify(d));

await makePng(12000, 2000, `${dir}/huge.png`);
await pick(2);
await page.setInputFiles('#file-tex', `${dir}/huge.png`);
await page.waitForTimeout(2500);
s = await st();
const t2 = s.nodes.find((n) => n.id === 2).tex;
d = await dims(t2);
ok('12000x2000 PNG fits the budget (8192 wide, same shape)', d[0] === 8192 && Math.abs(d[1] - 1365) <= 1, JSON.stringify(d));

writeFileSync(`${dir}/blob.svg`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><ellipse cx="50" cy="25" rx="40" ry="18" fill="#0a6fd8"/></svg>');
await pick(1);
await page.setInputFiles('#file-tex', `${dir}/blob.svg`);
await page.waitForTimeout(2500);
s = await st();
const t3 = s.nodes.find((n) => n.id === 1).tex;
d = await dims(t3);
ok('SVG is drawn big (was 1024), within the pixel budget', d[0] > 4000 && d[0] * d[1] <= 16.1e6, JSON.stringify(d));

// ---- history stays light, undo/redo still bring the image back
const h = await page.evaluate(() => __mt.hist());
ok('undo snapshots hold no image data', h.bytes < 300000, JSON.stringify(h));
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
s = await st();
ok('undo removes the SVG texture', !s.assets[t3] && s.nodes.find((n) => n.id === 1).tex === t1);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(800);
s = await st();
d = await dims(t3);
ok('redo brings the SVG texture back at full size', s.nodes.find((n) => n.id === 1).tex === t3 && d[0] > 4000, JSON.stringify(d));

// ---- autosave survives a reload with the images (waits out the debounce)
await page.waitForTimeout(1200);
await page.reload();
await page.waitForTimeout(2500);
s = await st();
ok('autosave kept the images across a reload', !!s.assets[t3] && !!s.assets[t2], Object.keys(s.assets).join());

// ---- walk drawer
await page.click('#btn-walk');
await page.waitForTimeout(500);
ok('walk mode on', await page.evaluate(() => document.body.classList.contains('walking')));
ok('walk settings start folded away', await page.evaluate(() => document.querySelector('#walk-hud').classList.contains('collapsed')));
// while the mouse is captured for looking the panel ignores clicks; Esc (here: exitPointerLock) gives the cursor back
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(300);
const hudBox = await page.locator('#walk-hud').boundingBox();
const stageBox = await page.locator('#view').boundingBox();
ok('drawer sits on the left edge, not top-center', hudBox.x <= stageBox.x + 1 + 1 && hudBox.x + hudBox.width <= stageBox.x + 20);
await page.click('.wh-tab');
ok('tab opens the drawer', await page.evaluate(() => !document.querySelector('#walk-hud').classList.contains('collapsed')));
ok('drawer shows controls on screen', (await page.locator('#walk-hud [data-walk="fov"]').boundingBox()).x >= stageBox.x - 1);
ok('open state is remembered', await page.evaluate(() => localStorage.getItem('meshtype.walkhud') === 'open'));
await page.click('.wh-tab');
ok('tab folds it away again', await page.evaluate(() => document.querySelector('#walk-hud').classList.contains('collapsed')));

// ---- head bob (physics stepped directly, 60 Hz)
const bobRange = () => page.evaluate(() => {
  const ys = [];
  for (let i = 0; i < 90; i++) { __mt.walkSim(['w'], 1 / 60); ys.push(__mt.camera.position.y); }
  return [Math.max(...ys) - Math.min(...ys), __mt.walkState().feet.y];
});
let [range, fy] = await bobRange();
ok('walking bobs the camera a little (1 to 4 cm)', range > 0.008 && range < 0.04, range.toFixed(4));
ok('the body itself does not bob', Math.abs(fy) < 0.02, fy.toFixed(3));
const still = await page.evaluate(() => { __mt.walkSim([], 1.5); return __mt.camera.position.y; });
ok('standing still settles back to eye height', Math.abs(still - 1.6) < 0.002, still.toFixed(4));
await page.$eval('[data-walk="bob"]', (e) => { e.checked = false; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.evaluate(() => { const w = __mt.walkState(); w.feet.set(0, 0, 0); w.yaw = Math.PI; });
[range] = await bobRange();
ok('bob toggle off: camera stays level', range < 0.0005, range.toFixed(5));
await page.$eval('[data-walk="bob"]', (e) => { e.checked = true; e.dispatchEvent(new Event('input', { bubbles: true })); });

// ---- look smoothing
// set the turn and step it in one call: the live render loop would otherwise eat part of it in between
const y1 = await page.evaluate(() => { const w = __mt.walkState(); w.yaw = 0; w.pitch = 0; w.inYaw = 0.5; w.inPitch = 0; __mt.walkSim([], 1 / 60); return w.yaw; });
ok('a turn glides in: one frame is only part of it', y1 > 0.05 && y1 < 0.3, y1.toFixed(3));
const y2 = await page.evaluate(() => { __mt.walkSim([], 1); return __mt.walkState().yaw; });
ok('and it lands on the full turn, no overshoot', Math.abs(y2 - 0.5) < 0.005, y2.toFixed(4));
await page.$eval('[data-walk="smooth"]', (e) => { e.checked = false; e.dispatchEvent(new Event('input', { bubbles: true })); });
const y3 = await page.evaluate(() => { const w = __mt.walkState(); w.yaw = 0; w.inYaw = 0.5; __mt.walkSim([], 1 / 60); return w.yaw; });
ok('smooth look off: the turn lands at once', Math.abs(y3 - 0.5) < 1e-6, y3.toFixed(4));

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const real = errs.filter((e) => !/GPU stall|swiftshader|WebGL/i.test(e));
ok('no page errors', real.length === 0, real.join(' | '));
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);

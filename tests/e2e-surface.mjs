// Surface drag, curved-wall scaling, Godot-friendly materials. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const B = (id, name, pos, scl, params = { bend: 0 }) => ({ kind: 'part', id, name, type: 'box', params, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat: 'matte', color: '#ccddee', visible: true });
const seed = { app: 'meshtype', name: 's', nextId: 20, sel: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [B(1, 'Table', [0, 0.5, 0], [2, 1, 2]), B(2, 'Crate', [3, 0.25, 0], [0.5, 0.5, 0.5])] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
const nd = async (name) => (await st()).nodes.find((n) => n.name === name);
const toScreen = (p) => page.evaluate((p) => {
  const v = new __mt.camera.position.constructor(...p).project(__mt.camera);
  const r = document.querySelector('#view').getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}, p);
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);
await page.evaluate(() => __mt.camera.position.set(3, 5, 9)); await page.waitForTimeout(300);
// drag the crate onto the table top
const from = await toScreen([3, 0.25, 0.25]);
const to = await toScreen([0.2, 1, 0.2]);
await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
await page.waitForTimeout(300);
let c = await nd('Crate');
ok('crate lands on the table top', Math.abs(c.pos[1] - 1.25) < 1e-6 && Math.abs(c.pos[0]) < 1.01, JSON.stringify(c.pos));
// drag it off into empty ground: back to y = 0.25
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
const from2 = await toScreen(c.pos);
const to2 = await toScreen([-3, 0, 2.5]);
await page.mouse.move(from2.x, from2.y); await page.mouse.down(); await page.mouse.move(to2.x, to2.y, { steps: 12 }); await page.mouse.up();
await page.waitForTimeout(300);
c = await nd('Crate');
ok('crate drops back to the ground', Math.abs(c.pos[1] - 0.25) < 1e-6, JSON.stringify(c.pos));

// curved wall: scale-box thickness handle must not explode the wall
await page.evaluate(() => { const s = __mt.getState(); });
await page.click('[data-add="wall"]'); await page.waitForTimeout(300);
await page.$eval('[data-param="bend"]', (e) => { e.value = '120'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForTimeout(300);
const wall0 = (await st()).nodes.find((n) => n.name.startsWith('Wall'));
await page.keyboard.press('3'); await page.waitForTimeout(300);
const handle = (p) => page.evaluate((p) => { const h = __mt.sbox.handles.find((m) => m.userData.handle.p.join() === p.join()); const v = h.getWorldPosition(new h.position.constructor()).project(__mt.camera); const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; }, p);
const h1 = await handle([0, -1, 1]), h0 = await handle([0, -1, -1]);
const L = Math.hypot(h1.x - h0.x, h1.y - h0.y) || 1;
await page.mouse.move(h1.x, h1.y); await page.mouse.down(); await page.mouse.move(h1.x + ((h1.x - h0.x) / L) * 60, h1.y + ((h1.y - h0.y) / L) * 60, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(400);
const wall1 = (await st()).nodes.find((n) => n.id === wall0.id);
const radius = wall1.scl[0] / (120 * Math.PI / 180);
ok('curved wall thickness grows by a sane amount', wall1.scl[2] > wall0.scl[2] && wall1.scl[2] <= 1.8 * radius + 1e-6 && wall1.scl[0] === wall0.scl[0], JSON.stringify([wall0.scl, wall1.scl]));
// even a silly thickness never folds the mesh
await page.keyboard.press('1');
await page.fill('[data-t="scl"][data-i="2"]', '50'); await page.dispatchEvent('[data-t="scl"][data-i="2"]', 'change'); await page.waitForTimeout(300);
const folded = await page.evaluate((id) => { const g = __mt.rt.get(id).geo; g.computeBoundingBox(); return g.boundingBox.max.toArray().concat(g.boundingBox.min.toArray()).some((v) => !Number.isFinite(v)); }, wall0.id);
ok('huge thickness: geometry stays finite', !folded);
// undo brings back the previous wall
await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
const wall2 = (await st()).nodes.find((n) => n.id === wall0.id);
const geoX = await page.evaluate((id) => { const g = __mt.rt.get(id).geo; g.computeBoundingBox(); return g.boundingBox.max.x - g.boundingBox.min.x; }, wall0.id);
ok('undo restores the wall and its geometry', wall2.scl[2] === wall1.scl[2] && geoX > 1, JSON.stringify([wall2.scl, geoX]));

// materials
const groups = await page.$$eval('#f-mat optgroup', (g) => g.map((x) => [x.label, x.children.length]));
ok('material list has a Godot-friendly group', groups.length === 2 && groups[0][1] >= 10, JSON.stringify(groups));
await page.selectOption('#f-mat', 'tinted'); await page.waitForTimeout(200);
const m = await page.evaluate((id) => { const mt = __mt.rt.get(id).material; return [mt.transparent, mt.opacity, mt.transmission]; }, wall0.id);
ok('tinted glass uses alpha, not transmission', m[0] === true && m[1] < 1 && m[2] === 0, JSON.stringify(m));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

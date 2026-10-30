// Baseplate, flooring, grid, drag-on-ground, room export. Serve the repo on :8123 first.
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 760 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const part = (id, name, pos, scl) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 6, nProf: 6, detail: 1 }, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat: 'gloss', color: '#e8eef4', visible: true });
const seed = { app: 'meshtype', version: '0.3.0', name: 'room-a', nextId: 10, sel: [], assets: {}, nodes: [part(1, 'Desk', [0, 0.4, 0], [1.2, 0.8, 0.6]), part(2, 'Cabinet', [2, 0.5, -1], [0.6, 1, 0.6])] };
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')));
await page.goto('http://localhost:8123/');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);

await page.click('#btn-floor');
await page.check('#floor-on'); await page.waitForTimeout(300);
await page.fill('#floor-w', '8'); await page.dispatchEvent('#floor-w', 'change');
await page.selectOption('#floor-preset', 'carpet'); await page.waitForTimeout(300);
let st = await saved();
ok('floor saved in project', st.floor.on && st.floor.w === 8 && st.floor.preset === 'carpet', JSON.stringify(st.floor));
await page.click('#stage', { position: { x: 600, y: 80 } }).catch(() => {});
await page.selectOption('#grid-size', '1'); await page.waitForTimeout(300);
ok('grid size saved', (await saved()).floor.grid === 1);
for (const p of ['tile', 'lab', 'grid', 'concrete', 'carpet']) {
  if (!(await page.isVisible('#floor-panel'))) await page.click('#btn-floor');
  await page.selectOption('#floor-preset', p); await page.waitForTimeout(250);
  await page.screenshot({ path: `/tmp/meshtype-floor-${p}.png`, clip: { x: 262, y: 70, width: 730, height: 650 } });
}

await page.click('#btn-floor'); // close the panel
await page.keyboard.press('Escape');
// drag the desk along the ground: find it on screen by projecting its position
const box = await page.locator('#view').boundingBox();
const screen = await page.evaluate(() => null);
void screen;
// click near the canvas center where the desk sits, then drag
const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 160, sy + 40, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(400);
st = await saved();
const desk = st.nodes.find((n) => n.name === 'Desk');
ok('desk dragged on the ground', desk.pos[0] !== 0 || desk.pos[2] !== 0, JSON.stringify(desk.pos));
ok('height kept', Math.abs(desk.pos[1] - 0.4) < 1e-6);
ok('snapped to 1 m grid', Number.isInteger(desk.pos[0]) && Number.isInteger(desk.pos[2]), JSON.stringify(desk.pos));
await page.screenshot({ path: '/tmp/meshtype-room.png', clip: { x: 262, y: 70, width: 730, height: 650 } });

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-glb')]);
const buf = fs.readFileSync(await dl.path());
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const names = gltf.nodes.map((n) => n.name);
ok('GLB has floor and parts with -col', names.includes('floor-col') && names.includes('desk-col'), JSON.stringify(names));
ok('GLB carries room extras', JSON.stringify(gltf).includes('"meshtype"'));
ok('floor has a texture', (gltf.images || []).length >= 1);
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

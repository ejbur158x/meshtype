// Floors (Floor mode), grid, drag-on-ground, room export. Serve the repo on :8123 first.
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
const part = (id, name, pos, scl) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 6, nProf: 6, detail: 1 }, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat: 'matte', color: '#e8eef4', visible: true });
// v0.3-style project: one baseplate in "floor" -> must migrate to floors[]
const seed = { app: 'meshtype', version: '0.3.0', name: 'room-a', nextId: 10, sel: [], assets: {}, nodes: [part(1, 'Desk', [0, 0.4, 0], [1.2, 0.8, 0.6])], floor: { on: true, w: 8, d: 8, preset: 'carpet', grid: 1 } };
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);
let st = await saved();
ok('old baseplate migrated', st.floors.length === 1 && st.floors[0].w === 8 && st.floors[0].preset === 'carpet' && st.floor.grid === 1, JSON.stringify([st.floor, st.floors]));

const box = await page.locator('#view').boundingBox();
// normal mode: clicking bare floor does not select it; box select on the floor area does not grab it
await page.mouse.click(box.x + 120, box.y + box.height - 60);
ok('normal click ignores floor', (await page.$$('#list li.sel')).length === 0 && !(await page.isVisible('[data-fl="w"]')));
await page.mouse.move(box.x + 100, box.y + box.height - 160); await page.mouse.down(); await page.mouse.move(box.x + 220, box.y + box.height - 40, { steps: 5 }); await page.mouse.up();
ok('box select ignores floor', !(await page.isVisible('[data-fl="w"]')));

// drag the desk on the ground (normal mode)
const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 160, sy + 40, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
st = await saved();
const desk = st.nodes.find((n) => n.name === 'Desk');
ok('desk dragged and snapped to 1 m', (desk.pos[0] !== 0 || desk.pos[2] !== 0) && Number.isInteger(desk.pos[0]) && desk.pos[1] === 0.4, JSON.stringify(desk.pos));

// Floor mode
await page.keyboard.press('Escape');
await page.keyboard.press('b');
ok('floor mode on', await page.evaluate(() => document.body.classList.contains('floor-mode')));
await page.mouse.click(box.x + 120, box.y + box.height - 60); await page.waitForTimeout(300);
ok('floor click selects floor', await page.isVisible('[data-fl="w"]'));
// parts locked: clicking the desk in floor mode does not select it
await page.mouse.click(sx + 160, sy + 40); await page.waitForTimeout(200);
ok('parts locked in floor mode', (await page.evaluate(() => __mt.getState().sel)).length === 0);
// add a second floor: parked against the first, no overlap
await page.click('[data-fact="add"]'); await page.waitForTimeout(300);
st = await saved();
ok('second floor added beside the first', st.floors.length === 2 && st.floors[1].pos[0] === 9 && !(await page.isVisible('.warn')), JSON.stringify(st.floors.map((f) => f.pos)));
// move it into the first -> overlap warning
await page.fill('[data-fl="x"]', '5'); await page.dispatchEvent('[data-fl="x"]', 'change'); await page.waitForTimeout(300);
ok('overlap is flagged', await page.isVisible('.warn'));
await page.fill('[data-fl="x"]', '9'); await page.dispatchEvent('[data-fl="x"]', 'change'); await page.waitForTimeout(300);
ok('overlap cleared', !(await page.isVisible('.warn')));
// ctrl directional scale on the floor: grow east, west edge stays at x = 4
await page.keyboard.press('3');
await page.keyboard.down('Control');
await page.evaluate(() => {
  const t = __mt.transform;
  t.axis = 'X';
  t.pointStart.set(1, 0, 0);
  t.dispatchEvent({ type: 'dragging-changed', value: true });
  t.object.scale.x = 14;
  t.dispatchEvent({ type: 'objectChange' });
  t.dispatchEvent({ type: 'dragging-changed', value: false });
});
await page.keyboard.up('Control');
await page.keyboard.press('1');
st = await saved();
const f2 = st.floors[1];
ok('floor scaled east, west edge pinned', f2.w === 14 && Math.abs(f2.pos[0] - f2.w / 2 - 4) < 1e-6, JSON.stringify(f2));
await page.screenshot({ path: '/tmp/meshtype-floors.png', clip: { x: 262, y: 70, width: 730, height: 650 } });
await page.keyboard.press('b');
ok('floor mode off', !(await page.evaluate(() => document.body.classList.contains('floor-mode'))));

const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.click('#btn-glb');
for (let i = 0; i < 100 && downloads.length < 2; i++) await page.waitForTimeout(200);
const glbDl = downloads.find((d) => d.suggestedFilename().endsWith('.glb'));
const jsonDl = downloads.find((d) => d.suggestedFilename().endsWith('.room.json'));
const buf = fs.readFileSync(await glbDl.path());
const gltf = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString());
const names = gltf.nodes.map((n) => n.name);
ok('GLB has both floors + desk', names.includes('desk-col') && names.includes('floor-1-col') && names.includes('floor-2-col'), JSON.stringify(names));
const man = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
ok('room JSON lists floors', man.floors.length === 2 && man.floors[1].size[0] === 14, JSON.stringify(man.floors));
ok('floor has a texture', (gltf.images || []).length >= 1);
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

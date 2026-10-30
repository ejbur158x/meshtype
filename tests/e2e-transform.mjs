// Tinkercad-style scale box, R/T quarter turns, World/Local. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const part = (id, name, pos, rot) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 20, nProf: 20, detail: 1 }, pos, rot, scl: [1, 1, 1], neg: false, parent: null, mat: 'matte', color: '#9fd0f0', visible: true });
const seed = { app: 'meshtype', version: '0.5.0', name: 't', nextId: 10, sel: [1], active: 1, assets: {}, nodes: [part(1, 'Box', [0, 0.5, 0], [0, 0, 0])], floor: { grid: 0.5, show: true }, floors: [] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
const box1 = async () => (await st()).nodes.find((n) => n.id === 1);
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);

/** screen position of a scale-box handle, by its p vector */
const handleXY = (p) => page.evaluate((p) => {
  const h = __mt.sbox.handles.find((m) => m.userData.handle.p.join() === p.join());
  const v = h.getWorldPosition(new h.position.constructor()).project(__mt.camera);
  const r = document.querySelector('#view').getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}, p);
const dragFrom = async (p, dx, dy, opts = {}) => {
  const a = await handleXY(p);
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + dx, a.y + dy, { steps: 8 }); await page.mouse.up();
  if (opts.alt) await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
};

await page.keyboard.press('3'); await page.waitForTimeout(400);
ok('scale box replaces arrows', await page.evaluate(() => __mt.sbox.group.visible && !__mt.transform.object));
// grab the +X edge handle (bottom, middle of the +X side) and pull it outward
const pPlus = await handleXY([1, -1, 0]);
const pMinus = await handleXY([-1, -1, 0]);
const dir = { x: pPlus.x - pMinus.x, y: pPlus.y - pMinus.y };
const L = Math.hypot(dir.x, dir.y);
await dragFrom([1, -1, 0], (dir.x / L) * 120, (dir.y / L) * 120);
let b = await box1();
ok('edge drag grew X', b.scl[0] > 1.2 && b.scl[1] === 1 && b.scl[2] === 1, JSON.stringify(b.scl));
ok('opposite side stayed planted', Math.abs(b.pos[0] - b.scl[0] / 2 - -0.5) < 1e-6, `pos ${b.pos[0]} scl ${b.scl[0]}`);
ok('size snapped to 0.5 m grid', Math.abs((b.scl[0] * 2) % 1) < 1e-6, String(b.scl[0]));
// from center
await page.click('[data-sfrom="center"]');
const before = await box1();
const q1 = await handleXY([0, -1, 1]);
const q0 = await handleXY([0, -1, -1]);
const dz = { x: q1.x - q0.x, y: q1.y - q0.y };
const Lz = Math.hypot(dz.x, dz.y);
await dragFrom([0, -1, 1], (dz.x / Lz) * 80, (dz.y / Lz) * 80);
b = await box1();
ok('center mode keeps the center', b.scl[2] > 1 && Math.abs(b.pos[2] - before.pos[2]) < 1e-6, JSON.stringify(b));
await page.click('[data-sfrom="edge"]');
// top handle: height grows, bottom stays on the floor
const t0 = await handleXY([0, 1, 0]);
await dragFrom([0, 1, 0], 0, -90);
b = await box1();
ok('top handle grows height, bottom planted', b.scl[1] > 1 && Math.abs(b.pos[1] - b.scl[1] / 2) < 1e-6, JSON.stringify(b));
void t0;

// R / T quarter turns
await page.keyboard.press('1');
await page.keyboard.press('r'); await page.waitForTimeout(200);
b = await box1();
ok('R turns 90° around Y', Math.abs(Math.abs(b.rot[1]) - 90) < 1e-3 && b.rot[0] === 0 && b.rot[2] === 0, JSON.stringify(b.rot));
await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r'); await page.waitForTimeout(200);
b = await box1();
ok('4× R is a full turn', b.rot.every((v) => Math.abs(v) < 1e-3 || Math.abs(Math.abs(v) - 180) < 1e-3), JSON.stringify(b.rot));
await page.keyboard.press('t'); await page.waitForTimeout(200);
b = await box1();
ok('T turns around Z', Math.abs(Math.abs(b.rot[2]) - 90) < 1e-3 || Math.abs(Math.abs(b.rot[0]) - 90) < 1e-3, JSON.stringify(b.rot));

// a rotated part keeps a clean scale in its own frame
await page.keyboard.press('3'); await page.waitForTimeout(300);
const rotBefore = (await box1()).rot.join();
const e1 = await handleXY([1, -1, 0]);
const e0 = await handleXY([-1, -1, 0]);
const dd = { x: e1.x - e0.x, y: e1.y - e0.y };
const Ld = Math.hypot(dd.x, dd.y) || 1;
await dragFrom([1, -1, 0], (dd.x / Ld) * 70, (dd.y / Ld) * 70);
b = await box1();
ok('rotated part: rotation untouched by scaling', b.rot.join() === rotBefore, `${rotBefore} -> ${b.rot.join()}`);

// World / Local
await page.keyboard.press('1');
await page.keyboard.press('l'); await page.waitForTimeout(200);
ok('L switches to local', (await page.getAttribute('[data-space="local"]', 'aria-pressed')) === 'true' && (await page.evaluate(() => __mt.transform.space)) === 'local');
await page.keyboard.press('l');
ok('L back to world', (await page.evaluate(() => __mt.transform.space)) === 'world');
await page.keyboard.press('3'); await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/meshtype-sbox.png', clip: { x: 262, y: 70, width: 730, height: 650 } });
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

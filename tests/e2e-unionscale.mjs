// Stretching a union of curved walls keeps the arcs joined. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
// two 90° walls on the same circle (radius R = L / (π/2)), meeting at the top
const L = 6, R = L / (Math.PI / 2);
const W = (id, name, pos, rot) => ({ kind: 'part', id, name, type: 'box', params: { bend: 90 }, pos, rot, scl: [L, 3, 0.3], neg: false, parent: 9, mat: 'matte', color: '#ccddee', visible: true });
const seed = { app: 'meshtype', name: 'ring', nextId: 20, sel: [9], active: 9, assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [
  { kind: 'group', id: 9, name: 'Ring', neg: false, mode: 'union', parent: null, visible: true },
  W(1, 'A', [0, 1.5, 0], [0, 0, 0]), W(2, 'B', [0, 1.5, 0], [0, -90, 0]) ] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);
await page.evaluate(() => __mt.camera.position.set(4, 14, 16));
await page.keyboard.press('3'); await page.waitForTimeout(400);
const handle = (p) => page.evaluate((p) => { const h = __mt.sbox.handles.find((m) => m.userData.handle.p.join() === p.join()); const v = h.getWorldPosition(new h.position.constructor()).project(__mt.camera); const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; }, p);
const before = await st();
const a = await handle([1, -1, 0]), b = await handle([-1, -1, 0]);
const len = Math.hypot(a.x - b.x, a.y - b.y);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + ((a.x - b.x) / len) * 120, a.y + ((a.y - b.y) / len) * 120, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(500);
const after = await st();
const A0 = before.nodes.find((n) => n.name === 'A'), A1 = after.nodes.find((n) => n.name === 'A'), B1 = after.nodes.find((n) => n.name === 'B');
const k = A1.scl[0] / A0.scl[0];
ok('union grew', k > 1.05, String(k));
ok('curved walls scale evenly (no squash)', [A1, B1].every((w) => w.scl.every((v, i) => Math.abs(v / A0.scl[i] - k) < 0.02)), JSON.stringify([A1.scl, B1.scl]));
ok('bend and rotation untouched', A1.params.bend === 90 && B1.params.bend === 90 && B1.rot[1] === -90, JSON.stringify([A1.rot, B1.rot]));
ok('walls still share one origin (arcs still meet)', Math.abs(A1.pos[0] - B1.pos[0]) < 1e-6 && Math.abs(A1.pos[2] - B1.pos[2]) < 1e-6, JSON.stringify([A1.pos, B1.pos]));
ok('union still solves', /tris/.test(await page.textContent('#stats')) && !/^0 tris/.test(await page.textContent('#stats')), await page.textContent('#stats'));
void R;
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

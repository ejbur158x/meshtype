// Arches and curved walls are built at their real size (their mesh is never scaled). Nothing
// may write the gizmo's scale (always 1 for them) back into their size. Serve on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const seed = { app: 'meshtype', name: 'rs', nextId: 9, sel: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [
  { kind: 'part', id: 1, name: 'Wall', type: 'box', params: { bend: 0 }, pos: [0, 1.5, 0], rot: [0, 0, 0], scl: [6, 3, 0.2], mat: 'matte', color: '#dddddd', visible: true },
  { kind: 'part', id: 2, name: 'Arch', type: 'arch', params: { round: 1, detail: 2 }, pos: [0, 1.2, 0], rot: [0, 0, 0], scl: [1.2, 2.4, 0.4], neg: true, mat: 'matte', color: '#ff0000', visible: true },
  { kind: 'part', id: 3, name: 'Curve', type: 'box', params: { bend: 90 }, pos: [5, 1, 0], rot: [0, 0, 0], scl: [4, 2, 0.2], mat: 'matte', color: '#dddddd', visible: true },
] };
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(2000);
const scl = (id) => page.evaluate((id) => __mt.getState().nodes.find((n) => n.id === id).scl.join(), id);
const handle = (p) => page.evaluate((p) => { const h = __mt.sbox.handles.find((m) => m.userData.handle.p.join() === p.join()); const v = h.getWorldPosition(new h.position.constructor()).project(__mt.camera); const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; }, p);

// scale box on the arch, then touch the move gizmo (this used to collapse it to 1 x 1 x 1)
await page.locator('#list li', { hasText: 'Arch' }).first().click();
await page.keyboard.press('3'); await page.waitForTimeout(300);
const h = await handle([1, -1, 1]);
await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x + 120, h.y + 60, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(600);
const grown = await scl(2);
ok('scale box grows the arch', grown !== '1.2,2.4,0.4', grown);
for (const m of ['1', '2']) {
  await page.keyboard.press(m); await page.waitForTimeout(150);
  await page.evaluate(() => __mt.transform.dispatchEvent({ type: 'objectChange' }));
}
ok('move/rotate gizmo keeps the arch size', (await scl(2)) === grown, await scl(2));
const geoW = await page.evaluate(() => { const g = __mt.rt.get(2).geo; g.computeBoundingBox(); return g.boundingBox.max.x - g.boundingBox.min.x; });
ok('arch mesh matches its size', Math.abs(geoW - Number(grown.split(',')[0])) < 1e-3, String(geoW));
// same for a curved wall
await page.locator('#list li', { hasText: 'Curve' }).first().click();
await page.keyboard.press('1'); await page.waitForTimeout(150);
await page.evaluate(() => __mt.transform.dispatchEvent({ type: 'objectChange' }));
ok('move gizmo keeps the curved wall size', (await scl(3)) === '4,2,0.2', await scl(3));
// union keeps it, and one undo takes back one step
await page.locator('#list li', { hasText: 'Wall' }).first().click();
await page.locator('#list li', { hasText: 'Arch' }).first().click({ modifiers: ['Shift'] });
await page.click('#btn-union'); await page.waitForTimeout(800);
ok('union keeps the arch size', (await scl(2)) === grown, await scl(2));
await page.evaluate(() => __mt.transform.dispatchEvent({ type: 'objectChange' }));
ok('moving the union keeps the arch size', (await scl(2)) === grown, await scl(2));
await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
ok('one undo undoes the union', await page.evaluate(() => __mt.getState().nodes.every((n) => n.kind === 'part')));
// mirror across height turns the arch upside down
await page.locator('#list li', { hasText: 'Arch' }).first().click();
await page.evaluate(() => {});
await page.click('[data-act="mirror:y"]').catch(() => {});
await page.waitForTimeout(300);
const rot = await page.evaluate(() => __mt.getState().nodes.find((n) => n.id === 2).rot);
ok('mirror Y flips the arch upside down', Math.abs(Math.abs(rot[2]) - 180) < 0.01 || Math.abs(Math.abs(rot[0]) - 180) < 0.01, JSON.stringify(rot));
ok('no page errors', errs.length === 0, errs.join(' | '));
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
await browser.close();
process.exit(failures ? 1 : 0);

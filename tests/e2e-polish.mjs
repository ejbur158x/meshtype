// Iso handles, change shape, multi-select materials, rounded drag, arrange UI. Serve on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const P = (id, name, pos, extra = {}) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 1 }, pos, rot: [0, 0, 0], scl: [1, 1, 1], neg: false, parent: null, mat: 'matte', color: '#ccddee', visible: true, ...extra });
const seed = { app: 'meshtype', name: 'p', nextId: 20, sel: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [P(1, 'A', [-1.5, 0.5, 0]), P(2, 'B', [1.5, 0.5, 0]), P(3, 'Round', [0, 0.5, 2], { round: { outer: 0.1, res: 48 } })] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(2500);

// multi-select material + color + change shape
await page.locator('#list li', { hasText: 'A' }).first().click();
await page.locator('#list li', { hasText: 'B' }).first().click({ modifiers: ['Shift'] });
ok('multi inspector has material + change shape', await page.isVisible('#f-mat') && await page.isVisible('[data-reshape]'));
await page.selectOption('#f-mat', 'painted'); await page.waitForTimeout(200);
await page.fill('#f-color', '#ff0000').catch(async () => { await page.$eval('#f-color', (e) => { e.value = '#ff0000'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }); });
let s = await st();
const ab = s.nodes.filter((n) => n.name === 'A' || n.name === 'B');
ok('material + color applied to both', ab.every((n) => n.mat === 'painted' && n.color === '#ff0000'), JSON.stringify(ab.map((n) => [n.mat, n.color])));
await page.selectOption('[data-reshape]', 'box'); await page.waitForTimeout(300);
s = await st();
const ab2 = s.nodes.filter((n) => n.name === 'A' || n.name === 'B');
ok('change shape keeps size/place/material', ab2.every((n) => n.type === 'box' && n.scl.join() === '1,1,1' && n.mat === 'painted') && ab2[0].pos[0] === -1.5, JSON.stringify(ab2.map((n) => [n.type, n.pos, n.mat])));
ok('arrange sections with icons', (await page.$$('.arr-sec .aico')).length === 4);

// iso: handle size stays sane
await page.keyboard.press('3'); await page.waitForTimeout(300);
const size = () => page.evaluate(() => { const h = __mt.sbox.handles[0]; const a = h.getWorldPosition(new h.position.constructor()); const b = a.clone().add(new h.position.constructor(h.scale.x, 0, 0)); const pa = a.clone().project(__mt.camera), pb = b.clone().project(__mt.camera); return Math.abs(pa.x - pb.x) * 650; });
const before = await size();
await page.click('#btn-iso'); await page.waitForTimeout(400);
const after = await size();
ok('iso keeps handle size on screen', after < before * 2 && after > before * 0.4, `${before.toFixed(1)}px -> ${after.toFixed(1)}px`);
await page.click('#btn-iso');
ok('handles draw after glass', await page.evaluate(() => __mt.sbox.handles.every((h) => h.material.transparent)));

// rounded part: drag it, the rounded mesh moves with it (no lag in the wrong spot)
await page.keyboard.press('1'); await page.keyboard.press('Escape');
await page.waitForFunction(() => !/rounding/.test(document.querySelector('#stats').textContent), null, { timeout: 90000 });
await page.waitForTimeout(500);
await page.evaluate(() => __mt.camera.position.set(0, 6, 12)); await page.waitForTimeout(300);
const sc = await page.evaluate(() => { const o = __mt.getState().nodes.find((n) => n.name === 'Round'); const v = new __mt.camera.position.constructor(...o.pos).project(__mt.camera); const r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; });
await page.mouse.move(sc.x, sc.y); await page.mouse.down(); await page.mouse.move(sc.x + 120, sc.y + 10, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(150);
const lag = await page.evaluate(() => { const o = __mt.getState().nodes.find((n) => n.name === 'Round'); const u = __mt.units.get(o.id); return { pos: o.pos, mesh: !!(u && u.mesh), off: u && u.mesh ? u.mesh.position.toArray() : null }; });
ok('moved rounded part keeps its rounded mesh, shifted along', lag.mesh && Math.abs(lag.off[0]) > 0.2, JSON.stringify(lag));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

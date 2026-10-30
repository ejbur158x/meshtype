// Ctrl+C / Ctrl+X / Ctrl+V, across projects. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const P = (id, name, pos, extra = {}) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 1 }, pos, rot: [0, 0, 0], scl: [1, 1, 1], neg: false, parent: null, mat: 'matte', color: '#9fd0f0', visible: true, ...extra });
const seed = { app: 'meshtype', version: '0.5.0', name: 'a', nextId: 10, sel: [1], active: 1, assets: {}, floor: { grid: 0.5, show: true }, floors: [],
  nodes: [{ kind: 'group', id: 1, name: 'Arch', neg: false, mode: 'union', parent: null, visible: true, tags: ['door'] }, P(2, 'Frame', [0, 1, 0], { parent: 1 }), P(3, 'Hole', [0, 0.8, 0], { parent: 1, neg: true })] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);
await page.locator('#list li').nth(0).click();
await page.keyboard.press('Control+c');
await page.keyboard.press('Control+v'); await page.waitForTimeout(400);
let s = await st();
const groups = s.nodes.filter((n) => n.kind === 'group');
ok('paste made a second union with its parts', groups.length === 2 && s.nodes.length === 6, JSON.stringify(s.nodes.map((n) => [n.id, n.kind, n.parent])));
const copy = groups.find((g) => g.id !== 1);
const kids = s.nodes.filter((n) => n.parent === copy.id);
ok('copy keeps cutter + tags', kids.some((k) => k.neg) && copy.tags[0] === 'door');
ok('paste lands exactly on top', kids.every((k) => k.pos[0] === 0 && k.pos[2] === 0), JSON.stringify(kids.map((k) => k.pos)));
ok('pasted copy is selected', s.sel.length === 1 && s.sel[0] === copy.id);
await page.keyboard.press('Control+v'); await page.waitForTimeout(300);
s = await st();
ok('second paste adds another', s.nodes.filter((n) => n.kind === 'group').length === 3);
// cut + paste in place
await page.keyboard.press('Control+x'); await page.waitForTimeout(300);
ok('cut removed it', (await st()).nodes.filter((n) => n.kind === 'group').length === 2);
await page.keyboard.press('Control+v'); await page.waitForTimeout(300);
s = await st();
ok('cut pastes back in place', s.nodes.filter((n) => n.kind === 'group').length === 3);
// across projects: new project, paste
await page.evaluate(() => localStorage.setItem('meshtype.autosave', JSON.stringify({ app: 'meshtype', name: 'b', nextId: 1, nodes: [], assets: {} })));
await page.reload(); await page.waitForTimeout(1200);
await page.keyboard.press('Control+v'); await page.waitForTimeout(400);
s = await st();
ok('pastes into another project after reload', s.nodes.filter((n) => n.kind === 'group').length === 1 && s.nodes.length === 3, JSON.stringify(s.nodes.map((n) => n.name)));
// sharp box + wall presets
await page.click('[data-add="box"]'); await page.click('[data-add="wall"]'); await page.waitForTimeout(400);
s = await st();
const bx = s.nodes.filter((n) => n.type === 'box');
ok('box + wall added, sitting on the floor', bx.length === 2 && bx[0].pos[1] === 0.5 && bx[1].pos[1] === 1.5 && bx[1].scl.join() === '4,3,0.2', JSON.stringify(bx.map((b) => [b.pos, b.scl])));
const tris = await page.evaluate((id) => { const g = __mt.rt.get(id).geo; return g.index.count / 3; }, bx[0].id);
ok('box is 12 triangles', tris === 12, String(tris));
// union two boxes (CSG on sharp boxes)
await page.locator('#list li', { hasText: 'Box' }).first().click();
await page.locator('#list li', { hasText: 'Wall' }).first().click({ modifiers: ['Shift'] });
await page.click('#btn-union'); await page.waitForTimeout(600);
ok('boxes union cleanly', /tris/.test(await page.textContent('#stats')) && (await st()).nodes.some((n) => n.kind === 'group' && n.name.startsWith('Union')));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

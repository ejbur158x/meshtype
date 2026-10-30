// Real-browser end-to-end check. Serve the repo on http://localhost:8123 first (python -m http.server 8123),
// then: node tests/e2e.mjs   (needs Playwright with Chromium)
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 560 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const rows = () => page.$$eval('#list li', (l) => l.map((x) => x.textContent.trim().replace(/\s+/g, ' ').replace('◉ ', '')));
const part = (id, name, pos, scl, extra = {}) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 2 }, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat: 'matte', color: '#aaccee', visible: true, ...extra });
const seed = { app: 'meshtype', version: '0.2.0', name: 'seed', nextId: 10, sel: [], nodes: [part(1, 'A', [-1.2, 0.3, 0], [1, 1, 1]), part(2, 'B', [1.0, 0.0, 0.5], [0.6, 0.6, 0.6])], assets: {} };
await page.goto('http://localhost:8123/');
await page.evaluate((s) => localStorage.setItem('meshtype.autosave', JSON.stringify(s)), seed);
await page.reload();
await page.waitForTimeout(1500);
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')));
const posOf = async (name) => (await state()).nodes.find((n) => n.name === name).pos;

// align on Y: min edge, to Lowest
await page.locator('#list li').nth(0).click(); await page.locator('#list li').nth(1).click({ modifiers: ['Control'] });
await page.click('[data-axis="y"]');
await page.selectOption('#al-edge', 'min'); await page.selectOption('#al-target', 'min');
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/meshtype-e2e-align.png' });
await page.click('[data-act="align"]'); await page.waitForTimeout(500);
const a = await posOf('A'), b = await posOf('B');
// A bottom = 0.3-0.5=-0.2 ; B bottom = 0-0.3=-0.3 ; lowest = -0.3 -> A y becomes 0.2 ; B unchanged 0
ok('align min->lowest', Math.abs(a[1] - 0.2) < 0.01 && Math.abs(b[1]) < 0.01, JSON.stringify([a, b]));

// center
await page.click('[data-act="center"]'); await page.waitForTimeout(400);
const a2 = await posOf('A'), b2 = await posOf('B');
const cx = ((a2[0] - 0.5) + (b2[0] - 0.3) + (a2[0] + 0.5) + (b2[0] + 0.3)) / 4; // rough
ok('center moved selection', Math.abs(a2[0] - a[0]) > 0.01, JSON.stringify([a2, b2]));

// multi move undo
await page.click('#btn-undo'); await page.waitForTimeout(300);
const a3 = await posOf('A');
ok('undo center', Math.abs(a3[0] - a[0]) < 1e-6);

// WASD camera: pixel diff
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
const before = await page.screenshot({ clip: { x: 262, y: 100, width: 400, height: 300 } });
await page.keyboard.down('w'); await page.waitForTimeout(900); await page.keyboard.up('w');
await page.waitForTimeout(500);
const after = await page.screenshot({ clip: { x: 262, y: 100, width: 400, height: 300 } });
ok('WASD moved camera', !before.equals(after));

// SVG import + rounding
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 H90 V60 H60 V90 H10 Z" fill="#000"/><circle cx="75" cy="78" r="12"/></svg>';
fs.writeFileSync('/tmp/meshtype-test.svg', svg);
await page.setInputFiles('#file-svg', '/tmp/meshtype-test.svg'); await page.waitForTimeout(1000);
ok('svg imported', (await rows()).some((r) => /test.*SOLID/.test(r)), JSON.stringify(await rows()));
console.log('toast:', await page.textContent('#toast'));
await page.screenshot({ path: '/tmp/meshtype-e2e-svg.png' });
await page.$eval('[data-round="outer"]', (e) => { e.value = '0.05'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForFunction(() => !/rounding/.test(document.querySelector('#stats').textContent), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log('stats after round:', await page.textContent('#stats'), '| toast:', await page.textContent('#toast'));
await page.screenshot({ path: '/tmp/meshtype-e2e-round.png' });

// GLB export
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.click('#btn-glb')]);
const p = await dl.path(); ok('glb exported', fs.statSync(p).size > 1000, String(fs.statSync(p).size));

// reload persistence + SW/offline
await page.reload(); await page.waitForTimeout(2000);
ok('autosave reload', (await rows()).length >= 3, JSON.stringify(await rows()));
console.log('sw:', await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? (r.active ? 'active' : 'installing') : 'none'; }));
await page.waitForTimeout(2500);
console.log('cache entries:', await page.evaluate(async () => { const k = await caches.keys(); return k.join(',') + ' ' + (await (await caches.open(k[0])).keys()).length; }));
await ctx.setOffline(true);
await page.reload(); await page.waitForTimeout(2500);
ok('offline reload', (await rows()).length >= 3, JSON.stringify(await rows()));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

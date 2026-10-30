// Mouse map, box select, view cube, sky. Serve the repo on :8123 first. node tests/e2e-controls.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(30000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const part = (id, name, pos) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 4, nProf: 4, detail: 1 }, pos, rot: [0, 0, 0], scl: [0.5, 0.5, 0.5], neg: false, parent: null, mat: 'matte', color: '#aaccee', visible: true });
const seed = { app: 'meshtype', version: '0.2.1', name: 'seed', nextId: 10, sel: [], nodes: [part(1, 'A', [-1, 0, 0]), part(2, 'B', [0, 0, 0]), part(3, 'C', [2.5, 0, 0])], assets: {} };
await page.goto('http://localhost:8123/');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1800);
const sel = async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')))).sel;
const camPos = () => page.evaluate(() => document.querySelector('#vc-cube').style.transform);

// left-drag over empty space draws a box; box around A and B (not C)
const box = await page.locator('#stage').boundingBox();
await page.mouse.move(box.x + 120, box.y + 130); await page.mouse.down(); await page.mouse.move(box.x + 500, box.y + 560, { steps: 6 });
ok('marquee visible while dragging', await page.isVisible('#marquee'));
await page.mouse.up(); await page.waitForTimeout(400);
const rows = await page.$$eval('#list li.sel', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
ok('box select picked something and not everything', rows.length >= 1 && rows.length < 3, JSON.stringify(rows));

// left-drag did not orbit
const c0 = await camPos();
await page.mouse.move(box.x + 700, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 760, box.y + 330, { steps: 4 }); await page.mouse.up();
ok('left drag does not orbit', c0 === await camPos());
// right-drag orbits
await page.mouse.move(box.x + 700, box.y + 300); await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + 780, box.y + 330, { steps: 6 }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(300);
ok('right drag orbits', c0 !== await camPos());
await page.keyboard.press('Escape');

// view cube click -> top view
await page.click('.vc-face[data-view="top"]', { force: true }); await page.waitForTimeout(900);
const t = await camPos();
ok('view cube click changes view', t !== c0);
await page.screenshot({ path: '/tmp/meshtype-vcube.png', clip: { x: 900, y: 70, width: 400, height: 200 } });
// view cube drag
await page.mouse.move(box.x + box.width - 40, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + box.width - 90, box.y + 80, { steps: 5 }); await page.mouse.up();
ok('view cube drag orbits', t !== await camPos());

// F frames selection
await page.locator('#list li').nth(2).click(); await page.keyboard.press('f'); await page.waitForTimeout(300);
ok('F key ran without error', errs.length === 0);

// shift-click multi select in list
await page.locator('#list li').nth(0).click(); await page.locator('#list li').nth(1).click({ modifiers: ['Shift'] });
ok('shift multi-select', (await page.$$('#list li.sel')).length === 2);

// sky
await page.click('#btn-sky'); ok('sky panel opens', await page.isVisible('#sky-panel'));
await page.click('[data-swatch="#d6f5e3"]'); await page.waitForTimeout(500);
ok('sky color mode', (await page.getAttribute('[data-sky="color"]', 'aria-pressed')) === 'true');
await page.screenshot({ path: '/tmp/meshtype-sky.png' });
// upload a generated panorama
await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 256; c.height = 128; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#ff7ad9'); g.addColorStop(1, '#3a1d8f'); x.fillStyle = g; x.fillRect(0, 0, 256, 128); window.__pano = c.toDataURL('image/png'); });
const buf = Buffer.from((await page.evaluate(() => window.__pano)).split(',')[1], 'base64');
await page.setInputFiles('#file-sky', { name: 'pano.png', mimeType: 'image/png', buffer: buf }); await page.waitForTimeout(1200);
ok('sky image mode', (await page.getAttribute('[data-sky="image"]', 'aria-pressed')) === 'true', await page.textContent('#toast'));
await page.reload(); await page.waitForTimeout(1800);
ok('sky persists after reload', (await page.getAttribute('[data-sky="image"]', 'aria-pressed')) === 'true');
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

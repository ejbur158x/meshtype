// Union display, union material/texture, rounding progress bar, sander. Serve on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const shot = (n) => page.screenshot({ path: `/tmp/meshtype-${n}.png`, clip: { x: 262, y: 70, width: 730, height: 650 } });
const P = (id, name, type, params, pos, scl, extra = {}) => ({ kind: 'part', id, name, type, params, pos, rot: [0, 0, 0], scl, neg: false, parent: 1, mat: 'gloss', color: '#5ac8e8', visible: true, ...extra });
const seed = { app: 'meshtype', version: '0.2.2', name: 'donut', nextId: 10, sel: [1], active: 1, assets: {}, nodes: [
  { kind: 'group', id: 1, name: 'Pot', neg: false, mode: 'union', parent: null, visible: true },
  P(2, 'Orb', 'squircle', { nPlan: 2, nProf: 2, detail: 2 }, [0, 0, 0], [1.6, 0.9, 1.6]),
  P(3, 'Hole', 'pill', { radius: 0.25, length: 0.5, detail: 2 }, [0, 0.5, 0], [1.6, 1, 1.6], { neg: true }),
] };
await page.goto('http://localhost:8123/');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(2000);
await shot('union-selected');
ok('union inspector has material', await page.isVisible('#inspector #f-mat'));
ok('union inspector has texture button', await page.isVisible('#inspector [data-act="tex"]'));
// material on union applies to all parts
await page.selectOption('#f-mat', 'chrome'); await page.waitForTimeout(300);
const mats = await page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')).nodes.filter((n) => n.kind === 'part').map((n) => n.mat));
ok('union material applied to all parts', mats.every((m) => m === 'chrome'), JSON.stringify(mats));
await page.selectOption('#f-mat', 'gloss');
// texture via generated image
const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) % 2 ? '#ffffff' : '#2a7fd4'; x.fillRect(i * 8, j * 8, 8, 8); } return c.toDataURL('image/png').split(',')[1]; }), 'base64');
await page.setInputFiles('#file-tex', { name: 'check.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(1200);
ok('texture set', await page.isVisible('[data-texsize]'));
await shot('union-textured');
await page.click('[data-act="tex-clear"]'); await page.waitForTimeout(300);
// round with progress bar
await page.$eval('[data-round="outer"]', (e) => { e.value = '0.06'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForSelector('#progress:not([hidden])', { timeout: 15000 }).then(() => ok('progress bar shows', true)).catch(() => ok('progress bar shows', false));
await page.screenshot({ path: '/tmp/meshtype-progress.png', clip: { x: 900, y: 715, width: 400, height: 40 } });
await page.waitForSelector('#progress[hidden]', { state: 'attached', timeout: 90000 });
await page.waitForTimeout(1000);
ok('progress bar hides when done', await page.$eval('#progress', (e) => e.hidden));
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await shot('rounded');
// negate the union -> red ghost
await page.locator('#list li').nth(0).click(); await page.click('#btn-negate'); await page.waitForTimeout(800);
await shot('negated');
console.log('stats:', await page.textContent('#stats'));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

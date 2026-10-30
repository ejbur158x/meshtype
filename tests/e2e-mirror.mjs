// Mirror + distribute. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const B = (id, name, pos, scl, rot = [0, 0, 0], params = { bend: 0 }) => ({ kind: 'part', id, name, type: 'box', params, pos, rot, scl, neg: false, parent: null, mat: 'matte', color: '#ccddee', visible: true });
const seed = { app: 'meshtype', name: 'm', nextId: 20, sel: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [
  B(1, 'A', [0, 0.5, 0], [1, 1, 1]), B(2, 'B', [1.3, 0.5, 0], [0.6, 1, 1]), B(3, 'C', [6, 0.5, 0], [2, 1, 1]),
  B(4, 'Tilted', [3, 1, 3], [2, 0.5, 0.5], [0, 30, 0]), B(5, 'Curve', [-3, 1.5, 0], [6, 3, 0.2], [0, 0, 0], { bend: 60 }) ] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
const nd = async (name) => (await st()).nodes.find((n) => n.name === name);
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);
const pick = async (names) => { for (let i = 0; i < names.length; i++) await page.locator('#list li', { hasText: names[i] }).first().click(i ? { modifiers: ['Shift'] } : {}); };

// distribute A, B, C along X: A spans -0.5..0.5, C spans 5..7; widths 1+0.6+2 = 3.6; span 7.5 -> gap 1.95
await pick(['A', 'B', 'C']);
await page.click('[data-act="dist:x"]'); await page.waitForTimeout(300);
const b = await nd('B');
ok('distribute: B lands with equal gaps', Math.abs(b.pos[0] - (0.5 + 1.95 + 0.3)) < 1e-3, JSON.stringify(b.pos));
ok('distribute: ends stay put', (await nd('A')).pos[0] === 0 && (await nd('C')).pos[0] === 6);

// mirror tilted box on X: alone, its center stays, its yaw flips
await pick(['Tilted']);
await page.click('[data-act="mirror:x"]'); await page.waitForTimeout(300);
let t = await nd('Tilted');
ok('mirror X flips yaw', Math.abs(t.rot[1] + 30) < 1e-3 && t.pos[0] === 3, JSON.stringify(t));
// mirror a pair across their shared center
await pick(['A', 'C']);
await page.click('[data-act="mirror:x"]'); await page.waitForTimeout(300);
ok('mirror pair swaps sides', (await nd('A')).pos[0] === 6.5 && (await nd('C')).pos[0] === 0.5, JSON.stringify([(await nd('A')).pos, (await nd('C')).pos]));
// curved wall mirrored across its thickness (Z) flips the bend
await pick(['Curve']);
await page.click('[data-act="mirror:z"]'); await page.waitForTimeout(300);
ok('mirror Z flips curve', (await nd('Curve')).params.bend === -60, JSON.stringify((await nd('Curve')).params));
await page.click('[data-act="mirror:x"]'); await page.waitForTimeout(300);
ok('mirror X keeps curve', (await nd('Curve')).params.bend === -60);
// Ctrl+R must not reload
await page.evaluate(() => { window.__alive = 1; });
await page.keyboard.press('Control+r'); await page.waitForTimeout(800);
ok('Ctrl+R does not reload', await page.evaluate(() => window.__alive === 1));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

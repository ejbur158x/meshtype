// Curved walls: bend angle applies over the whole length, any size. Serve the repo on :8123 first.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
await page.goto('http://localhost:8123/?test');
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify({ app: 'meshtype', name: 'hall', nextId: 1, nodes: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [] })); });
await page.reload(); await page.waitForTimeout(1200);
await page.click('[data-add="wall"]'); await page.waitForTimeout(300);
const setBend = async (v) => { await page.$eval('[data-param="bend"]', (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await page.waitForTimeout(300); };
/** angle (deg) between the two end caps' outward normals, measured from the geometry */
const endAngle = () => page.evaluate(() => {
  const s = __mt.getState();
  const o = s.nodes[s.nodes.length - 1];
  const g = __mt.rt.get(o.id).geo;
  g.computeBoundingBox();
  const pos = g.attributes.position, nor = g.attributes.normal;
  // end-cap vertices are the ones whose normal is (nearly) perpendicular to Y and to the long faces; pick the two most opposite normals
  let best = 0;
  const ns = [];
  for (let i = 0; i < nor.count; i++) if (Math.abs(nor.getY(i)) < 0.01) ns.push([nor.getX(i), nor.getZ(i)]);
  // end caps are flat, so their normals repeat exactly; take the pair with the smallest dot among distinct normals of the caps
  const caps = ns.filter(([x, z]) => Math.abs(x) > 0.3);
  let a = null, b = null;
  for (const n of caps) { if (!a || n[0] < a[0]) a = n; if (!b || n[0] > b[0]) b = n; }
  const dot = -(a[0] * b[0] + a[1] * b[1]); // caps face away from each other
  best = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  return { angle: best, size: g.boundingBox.max.clone().sub(g.boundingBox.min).toArray() };
});
await setBend(90);
let r = await endAngle();
ok('90° bend: ends 90° apart', Math.abs(r.angle - 90) < 1.5, JSON.stringify(r));
// make it twice as long: still 90°
let s = await page.evaluate(() => __mt.getState());
await page.fill('[data-t="scl"][data-i="0"]', '8'); await page.dispatchEvent('[data-t="scl"][data-i="0"]', 'change'); await page.waitForTimeout(300);
r = await endAngle();
ok('longer wall keeps 90°', Math.abs(r.angle - 90) < 1.5 && r.size[0] > 4, JSON.stringify(r));
await page.fill('[data-t="scl"][data-i="1"]', '5'); await page.dispatchEvent('[data-t="scl"][data-i="1"]', 'change');
await page.fill('[data-t="scl"][data-i="2"]', '1'); await page.dispatchEvent('[data-t="scl"][data-i="2"]', 'change'); await page.waitForTimeout(300);
r = await endAngle();
ok('taller and thicker keeps 90°', Math.abs(r.angle - 90) < 1.5 && Math.abs(r.size[1] - 5) < 1e-6, JSON.stringify(r));
await setBend(180);
r = await endAngle();
// 180°: a U. Centerline radius R = L/π; outer width = 2(R + D/2), depth = R + D/2
{ const R = 8 / Math.PI; ok('180° makes a true half-circle U', Math.abs(r.size[0] - 2 * (R + 0.5)) < 0.02 && Math.abs(r.size[2] - (R + 0.5)) < 0.02, JSON.stringify(r)); }
await setBend(0);
const tris = await page.evaluate(() => { const s = __mt.getState(); const o = s.nodes[s.nodes.length - 1]; const g = __mt.rt.get(o.id).geo; return g.index.count / 3; });
ok('back to 0° is a plain 12-triangle box', tris === 12, String(tris));
await setBend(-90);
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/meshtype-curve.png', clip: { x: 262, y: 70, width: 730, height: 650 } });
void s;
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

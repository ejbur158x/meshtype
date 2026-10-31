// Group/Ungroup, sun, corner views, iso, pivot, Ctrl+S. Serve the repo on :8123 first.
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 }, acceptDownloads: true })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const B = (id, name, pos) => ({ kind: 'part', id, name, type: 'box', params: { bend: 0 }, pos, rot: [0, 0, 0], scl: [1, 1, 1], neg: false, parent: null, mat: 'matte', color: '#ccddee', visible: true });
const seed = { app: 'meshtype', name: 'g', nextId: 20, sel: [], assets: {}, floor: { grid: 0.5, show: true }, floors: [], nodes: [B(1, 'Chair A', [-1, 0.5, 0]), B(2, 'Chair B', [1, 0.5, 0]), B(3, 'Desk', [0, 0.5, 2])] };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);

await page.locator('#list li', { hasText: 'Chair A' }).click();
await page.locator('#list li', { hasText: 'Chair B' }).click({ modifiers: ['Shift'] });
await page.keyboard.press('Control+g'); await page.waitForTimeout(300);
let s = await st();
const grp = s.nodes.find((n) => n.mode === 'folder');
ok('Ctrl+G makes a group (not a union)', grp && s.nodes.filter((n) => n.parent === grp.id).length === 2 && s.sel[0] === grp.id, JSON.stringify(s.nodes.map((n) => [n.name, n.parent, n.mode])));
ok('grouped parts still render separately', /tris/.test(await page.textContent('#stats')) && (await page.evaluate(() => [...__mt.rt.values()].filter((r) => r.part.visible).length)) === 3);
// move the group as one with R (quarter turn about its center)
await page.keyboard.press('r'); await page.waitForTimeout(300);
s = await st();
const a = s.nodes.find((n) => n.name === 'Chair A'), b = s.nodes.find((n) => n.name === 'Chair B');
ok('group turns as one', Math.abs(a.pos[0]) < 1e-6 && Math.abs(Math.abs(a.pos[2]) - 1) < 1e-6 && Math.abs(a.pos[2] + b.pos[2]) < 1e-6, JSON.stringify([a.pos, b.pos]));
// export: group becomes a parent node
const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.click('#btn-glb');
for (let i = 0; i < 100 && downloads.length < 2; i++) await page.waitForTimeout(200);
const glb = fs.readFileSync(await downloads.find((d) => d.suggestedFilename().endsWith('.glb')).path());
const gltf = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString());
const gnode = gltf.nodes.find((n) => /^group-/.test(n.name || ''));
ok('GLB keeps the group as a parent node', gnode && gnode.children && gnode.children.length === 2 && gnode.children.every((i) => /^chair-/.test(gltf.nodes[i].name)), JSON.stringify(gltf.nodes.map((n) => n.name)));
const man = JSON.parse(fs.readFileSync(await downloads.find((d) => d.suggestedFilename().endsWith('.room.json')).path(), 'utf8'));
ok('room JSON has the group path', man.nodes.filter((n) => n.group && n.group.length === 1).length === 2);
// ungroup
await page.locator('#list li', { hasText: 'Group' }).first().click();
await page.keyboard.press('Control+u'); await page.waitForTimeout(300);
s = await st();
ok('Ctrl+U ungroups', !s.nodes.some((n) => n.mode === 'folder') && s.nodes.every((n) => n.parent == null));
// Ctrl+S saves
const before = downloads.length;
await page.keyboard.press('Control+s'); await page.waitForTimeout(800);
ok('Ctrl+S downloads the project', downloads.length === before + 1 && downloads[downloads.length - 1].suggestedFilename().endsWith('.meshtype.json'));

// sun
await page.keyboard.press('Escape');
await page.keyboard.press('l'); await page.waitForTimeout(300);
ok('L opens the sun', await page.isVisible('[data-sun="intensity"]') && (await page.evaluate(() => __mt.transform.object && __mt.transform.object.geometry && __mt.transform.object.geometry.type)) === 'SphereGeometry');
await page.evaluate(() => { const t = __mt.transform; t.object.position.set(-8, 6, 0); t.dispatchEvent({ type: 'objectChange' }); t.dispatchEvent({ type: 'dragging-changed', value: false }); });
await page.$eval('[data-sun="intensity"]', (e) => { e.value = '2.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await page.check('#sun-export');
s = await st();
ok('sun moved + settings saved', s.sun.pos[0] === -8 && s.sun.intensity === 2.5 && s.sun.export === true, JSON.stringify(s.sun));
await page.screenshot({ path: '/tmp/meshtype-sun.png', clip: { x: 262, y: 70, width: 730, height: 650 } });
await page.keyboard.press('l');
ok('L closes the sun', !(await page.isVisible('[data-sun="intensity"]')));
downloads.length = 0;
await page.click('#btn-glb');
for (let i = 0; i < 100 && downloads.length < 2; i++) await page.waitForTimeout(200);
const g2 = fs.readFileSync(await downloads.find((d) => d.suggestedFilename().endsWith('.glb')).path());
const gl2 = JSON.parse(g2.slice(20, 20 + g2.readUInt32LE(12)).toString());
ok('sun exports as a directional light', (gl2.extensions?.KHR_lights_punctual?.lights || []).some((l) => l.type === 'directional'));

// views
await page.click('.vc-face[data-view="front"] .vc-corner.tr', { force: true }); await page.waitForTimeout(700);
const dir = await page.evaluate(() => { const d = __mt.camera.position.clone().sub(new __mt.camera.position.constructor(...__mt.getTarget())).normalize(); return d.toArray(); });
ok('front top-right corner = iso view from (+X,+Y,+Z)', dir.every((v) => Math.abs(v - 0.577) < 0.03), JSON.stringify(dir));
await page.click('#btn-iso'); await page.waitForTimeout(200);
ok('iso toggle', (await page.evaluate(() => __mt.camera.fov)) < 5 && (await page.textContent('#btn-iso')) === 'ISO');
await page.click('#btn-iso');
await page.click('#btn-pivot');
ok('pivot locks to world center', (await page.evaluate(() => __mt.getTarget())).every((v) => v === 0) && (await page.textContent('#btn-pivot')) === 'WORLD');
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

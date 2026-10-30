// Lights, tags, room JSON, Ctrl directional scaling. Serve the repo on :8123 first.
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 760 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const part = (id, name, pos, scl) => ({ kind: 'part', id, name, type: 'squircle', params: { nPlan: 8, nProf: 8, detail: 1 }, pos, rot: [0, 0, 0], scl, neg: false, parent: null, mat: 'matte', color: '#e8eef4', visible: true });
const seed = { app: 'meshtype', version: '0.4.0', name: 'room-b', nextId: 10, sel: [], assets: {}, nodes: [part(1, 'Arch', [0, 1, 0], [2, 2, 0.4])], floor: { on: true, w: 6, d: 6, preset: 'tile', grid: 0.5 } };
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('meshtype.autosave')));
await page.goto('http://localhost:8123/?test');
await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('meshtype.autosave', JSON.stringify(s)); }, seed);
await page.reload(); await page.waitForTimeout(1500);

// tags on the arch
await page.locator('#list li').nth(0).click();
await page.fill('#f-tag', 'door'); await page.keyboard.press('Enter');
await page.fill('#f-tag', 'Keycard Red'); await page.click('[data-act="tag"]');
let st = await saved();
ok('tags saved', JSON.stringify(st.nodes[0].tags) === '["door","keycard-red"]', JSON.stringify(st.nodes[0].tags));
await page.click('[data-untag="door"]');
ok('tag removed', JSON.stringify((await saved()).nodes[0].tags) === '["keycard-red"]');

// (part scaling is covered by tests/e2e-transform.mjs)

// lights
await page.click('[data-add-light="point"]'); await page.waitForTimeout(300);
await page.click('[data-add-light="spot"]'); await page.waitForTimeout(300);
st = await saved();
ok('two lights added', st.nodes.filter((n) => n.kind === 'light').length === 2);
ok('light inspector', await page.isVisible('[data-light="intensity"]') && await page.isVisible('[data-light="angle"]'));
await page.$eval('[data-light="intensity"]', (e) => { e.value = '150'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
await page.fill('#f-tag', 'alarm'); await page.keyboard.press('Enter');
st = await saved();
const spot = st.nodes.find((n) => n.lightType === 'spot');
ok('spot settings saved', spot.intensity === 150 && spot.tags[0] === 'alarm', JSON.stringify(spot));
await page.keyboard.press('Escape');
await page.screenshot({ path: '/tmp/meshtype-lights.png', clip: { x: 262, y: 70, width: 730, height: 650 } });

// export: GLB + room JSON
const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.click('#btn-glb');
for (let i = 0; i < 100 && downloads.length < 2; i++) await page.waitForTimeout(200);
ok('two downloads (glb + json)', downloads.length === 2, downloads.map((d) => d.suggestedFilename()).join(','));
const glbDl = downloads.find((d) => d.suggestedFilename().endsWith('.glb'));
const jsonDl = downloads.find((d) => d.suggestedFilename().endsWith('.room.json'));
const buf = fs.readFileSync(await glbDl.path());
const gltf = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString());
const names = gltf.nodes.map((n) => n.name);
ok('GLB has lights (KHR_lights_punctual)', (gltf.extensionsUsed || []).includes('KHR_lights_punctual') && gltf.extensions.KHR_lights_punctual.lights.length === 2, JSON.stringify(gltf.extensions && gltf.extensions.KHR_lights_punctual));
ok('GLB node names', names.includes('arch-col') && names.some((n) => /^floor.*-col$/.test(n || '')), JSON.stringify(names));
const archNode = gltf.nodes.find((n) => n.name === 'arch-col');
ok('tags in glTF extras', JSON.stringify(archNode.extras).includes('keycard-red'), JSON.stringify(archNode.extras));
const man = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
ok('room JSON nodes match GLB', man.nodes.every((e) => names.includes(e.node)) && man.lights.every((l) => names.includes(l.node)), JSON.stringify(man.nodes.map((n) => n.node)) + JSON.stringify(man.lights.map((n) => n.node)));
ok('room JSON light details', man.lights.some((l) => l.type === 'spot' && l.intensityCandela === 150 && l.godotType === 'SpotLight3D'));
fs.writeFileSync('/tmp/meshtype-room.json', JSON.stringify(man, null, 2));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

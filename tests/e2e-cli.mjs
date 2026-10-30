// CLI build + opening an authoring-form room in the editor. Serve the repo on :8123 first.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
let failures = 0;
const ok = (n, c, x = '') => { console.log(c ? 'PASS' : 'FAIL', n, x); if (!c) failures++; };
const root = new URL('..', import.meta.url).pathname;
const out = '/tmp/meshtype-cli-test';
fs.rmSync(out, { recursive: true, force: true });
execFileSync('node', [root + 'tools/meshtype.mjs', 'build', root + 'examples/hall-a.meshtype.json', '--out', out], { stdio: 'inherit' });
const man = JSON.parse(fs.readFileSync(out + '/hall-a.room.json', 'utf8'));
const buf = fs.readFileSync(out + '/hall-a.glb');
const gltf = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString());
const names = gltf.nodes.map((n) => n.name);
ok('CLI: GLB has the walls, the door union, bench, lamp and floor', ['wall-north-col', 'wall-west-col', 'door-wall-col', 'curved-bench-col', 'lamp-orb', 'floor-col'].every((n) => names.includes(n)), JSON.stringify(names));
ok('CLI: light exported', (gltf.extensions?.KHR_lights_punctual?.lights || []).length === 1);
ok('CLI: manifest tags', man.nodes.find((n) => n.node === 'door-wall-col').tags.includes('door'));
ok('CLI: preview written', fs.statSync(out + '/hall-a.preview.png').size > 50000);
let failedCheck = false;
try { execFileSync('node', [root + 'tools/meshtype.mjs', 'check', '/dev/stdin'], { input: '{"nodes":[{"type":"cube"}]}', stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) { failedCheck = e.status === 1; }
ok('CLI: check fails on errors', failedCheck);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 760 } })).newPage();
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8123/?test');
await page.waitForTimeout(1200);
await page.setInputFiles('#file-open', root + 'examples/hall-a.meshtype.json');
await page.waitForTimeout(2500);
const st = await page.evaluate(() => JSON.parse(JSON.stringify(__mt.getState())));
ok('editor Open accepts the authoring form', st.nodes.length === 8 && st.floors.length === 1 && st.nodes.some((n) => n.kind === 'group' && n.name === 'Door Wall'), JSON.stringify(st.nodes.map((n) => [n.name, n.kind, n.parent])));
console.log('ERRORS:', errs.join('\n') || 'none');
await browser.close();
process.exit(failures || errs.length ? 1 : 0);

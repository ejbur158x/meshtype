#!/usr/bin/env node
// Meshtype command line: build, check and preview rooms without clicking anything.
//
//   node tools/meshtype.mjs build    rooms/hall-a.meshtype.json [--out dir] [--no-preview] [--no-collision] [--strict]
//   node tools/meshtype.mjs check    rooms/hall-a.meshtype.json
//   node tools/meshtype.mjs preview  rooms/hall-a.meshtype.json [--out dir]
//
// It runs the real editor in a hidden Chromium (Playwright), so a build is
// byte-for-byte what the Export GLB button makes. See docs/AGENTS.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ arguments ------------------------------ */

const argv = process.argv.slice(2);
const cmd = argv[0];
const VALUE_OPTS = new Set(['--out']);
const files = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUE_OPTS.has(all[i - 1]));
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
if (!['build', 'check', 'preview'].includes(cmd) || !files.length) {
  console.log(`Meshtype CLI

  node tools/meshtype.mjs build   <room.meshtype.json>... [--out dir] [--no-preview] [--no-collision] [--strict]
  node tools/meshtype.mjs check   <room.meshtype.json>...
  node tools/meshtype.mjs preview <room.meshtype.json>... [--out dir]

build    writes <name>.glb, <name>.room.json and <name>.preview.png (next to the input, or in --out)
check    prints problems (errors, warnings) without writing anything; exit code 1 on errors
preview  writes only the 2x2 preview image

--strict makes warnings fail the build too. Format: docs/FORMAT.md. Workflow: docs/AGENTS.md.`);
  process.exit(cmd ? 2 : 0);
}

/* ------------------------------ playwright ----------------------------- */

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (e) {
    // fall back to a global install (npm i -g playwright) or PLAYWRIGHT_DIR
    const tries = [process.env.PLAYWRIGHT_DIR, '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
    for (const dir of tries) {
      try {
        return createRequire(import.meta.url)(dir);
      } catch (err) {
        /* next */
      }
    }
    console.error('Playwright is not installed. Run:  npm install  &&  npx playwright install chromium');
    process.exit(3);
  }
}

/* ---------------------------- static server ---------------------------- */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* -------------------------------- main --------------------------------- */

const LAUNCH = {
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  ...(process.env.MESHTYPE_CHROMIUM ? { executablePath: process.env.MESHTYPE_CHROMIUM } : {}),
};
async function launch() {
  const { chromium } = await loadPlaywright();
  try {
    return await chromium.launch(LAUNCH);
  } catch (err) {
    // the local Playwright has no browser downloaded yet: try a global install before giving up
    for (const dir of [process.env.PLAYWRIGHT_DIR, '/opt/npm-tools/node_modules/playwright'].filter(Boolean)) {
      try {
        return await createRequire(import.meta.url)(dir).chromium.launch(LAUNCH);
      } catch (e) {
        /* next */
      }
    }
    console.error('No Chromium for Playwright yet. Run:  npx playwright install chromium\n(or set MESHTYPE_CHROMIUM to a Chrome/Chromium executable)');
    process.exit(3);
  }
}
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.addInitScript(() => {
  try {
    localStorage.clear();
  } catch (e) {
    /* ignore */
  }
});
await page.goto(base + '?cli');
await page.waitForFunction(() => window.__mt && window.__mt.cli);

let failed = false;
for (const file of files) {
  const label = path.basename(file);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✗ ${label}: cannot read JSON: ${err.message}`);
    failed = true;
    continue;
  }
  const data = doc;
  if (!data.assets) data.assets = {};
  // SVG assets may be given as file paths relative to the room file
  for (const [k, v] of Object.entries(data.assets)) {
    if (typeof v === 'string' && !v.trim().startsWith('<') && !v.startsWith('data:') && fs.existsSync(path.resolve(path.dirname(file), v))) {
      data.assets[k] = fs.readFileSync(path.resolve(path.dirname(file), v), 'utf8');
    }
  }
  const stem = label.replace(/\.meshtype\.json$|\.json$/i, '');
  const outDir = opt('out', path.dirname(file));
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const expanded = await page.evaluate((d) => window.__mt.cli.load(d), data);
  const problems = await page.evaluate((d) => window.__mt.cli.validate(d), expanded);
  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');
  for (const p of problems) console.log(`  ${p.level === 'error' ? 'ERROR' : p.level === 'warn' ? 'warn ' : 'info '} ${p.node ? `[${p.node}] ` : ''}${p.msg}`);
  const bad = errors.length || (flag('strict') && warns.length);

  if (cmd === 'check') {
    console.log(`${bad ? '✗' : '✓'} ${label}: ${errors.length} error(s), ${warns.length} warning(s)`);
    if (bad) failed = true;
    continue;
  }
  if (bad && cmd === 'build') {
    console.log(`✗ ${label}: not built (${errors.length} error(s)${flag('strict') ? `, ${warns.length} warning(s) with --strict` : ''})`);
    failed = true;
    continue;
  }
  const written = [];
  if (cmd === 'build') {
    if (flag('no-collision')) await page.evaluate(() => (document.querySelector('#chk-col').checked = false));
    else await page.evaluate(() => (document.querySelector('#chk-col').checked = true));
    const res = await page.evaluate(() => window.__mt.cli.exportGLB());
    if (!res) {
      console.log(`✗ ${label}: nothing to export (only cutters, or everything hidden)`);
      failed = true;
      continue;
    }
    const manifest = { ...res.manifest, room: stem, glb: `${stem}.glb` };
    fs.writeFileSync(path.join(outDir, `${stem}.glb`), Buffer.from(res.glb, 'base64'));
    fs.writeFileSync(path.join(outDir, `${stem}.room.json`), JSON.stringify(manifest, null, 2) + '\n');
    written.push(`${stem}.glb`, `${stem}.room.json`);
  }
  if (cmd === 'preview' || !flag('no-preview')) {
    const url = await page.evaluate(() => window.__mt.cli.snap(512));
    fs.writeFileSync(path.join(outDir, `${stem}.preview.png`), Buffer.from(url.split(',')[1], 'base64'));
    written.push(`${stem}.preview.png`);
  }
  console.log(`✓ ${label} → ${written.join(', ')} in ${outDir} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
if (pageErrors.length) {
  console.error('Editor errors:\n  ' + pageErrors.join('\n  '));
  failed = true;
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

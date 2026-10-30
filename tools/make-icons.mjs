// Renders icons/icon.svg to the PNG sizes the manifest needs. Uses Playwright's Chromium.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const svg = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
async function shot(size, file, { pad = 0, bg = 'transparent' } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size - pad * 2;
  await page.setContent(`<body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`);
  await page.screenshot({ path: path.join(root, 'icons', file), omitBackground: bg === 'transparent' });
}
await shot(192, 'icon-192.png');
await shot(512, 'icon-512.png');
await shot(512, 'icon-maskable-512.png', { pad: 64, bg: '#4fb6f0' });
await shot(180, 'apple-touch-icon.png', { pad: 10, bg: '#4fb6f0' });
await browser.close();

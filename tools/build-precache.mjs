// Writes precache.json: every file the app needs offline, plus a content hash used as the cache version.
// Run from the repo root before deploying: node tools/build-precache.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const include = ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'icons', 'assets', 'src', 'vendor'];
const skip = /(^|\/)(README\.md)$/;
const files = [];
const walk = (rel) => {
  const abs = path.join(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, f));
  else if (!skip.test(rel)) files.push(rel);
};
include.forEach(walk);
const hash = crypto.createHash('sha1');
for (const f of files) {
  hash.update(f);
  hash.update(fs.readFileSync(path.join(root, f)));
}
const version = hash.digest('hex').slice(0, 10);
const list = ['./', ...files.filter((f) => f !== 'sw.js').map((f) => './' + f)];
fs.writeFileSync(path.join(root, 'precache.json'), JSON.stringify({ version, files: list }, null, 2) + '\n');
console.log(`precache.json: ${list.length} files, version ${version}`);

import { brotliCompressSync, constants } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.FROGLABEL_SIZE_OUTPUT ?? path.join(root, 'dist'));
const html = await readFile(path.join(output, 'index.html'), 'utf8');

const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/gu)].map((match) => match[1]);
const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map((match) => match[1]);
if (scripts.length !== 1 || styles.length !== 1) {
  throw new Error(
    `Expected one production script and stylesheet in index.html; found ${scripts.length}/${styles.length}`,
  );
}

const checks = [
  { name: 'JS entry', urls: scripts, limit: 150_000 },
  { name: 'CSS entry', urls: styles, limit: 10_000 },
];
let failed = false;
for (const check of checks) {
  let bytes = 0;
  for (const url of check.urls) {
    const pathname = new URL(url, 'https://froglabel.local/').pathname;
    const relative = pathname.replace(/^\/frog_label\//u, '').replace(/^\//u, '');
    const source = await readFile(path.join(output, relative));
    bytes += brotliCompressSync(source, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }
  process.stdout.write(`${check.name}: ${bytes} B Brotli (limit ${check.limit} B)\n`);
  if (bytes > check.limit) failed = true;
}
if (failed) process.exitCode = 1;

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const [rootArgument = 'build/pages', baseArgument = '/frog_label/', portArgument = '4180'] =
  process.argv.slice(2);
const root = path.resolve(rootArgument);
const base = `/${baseArgument.replace(/^\/+|\/+$/gu, '')}/`;
const port = Number(portArgument);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid port');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wav', 'audio/wav'],
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(base)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(base.length));
    const requested = path.resolve(root, relative || 'index.html');
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
      response.writeHead(400).end('Invalid path');
      return;
    }
    let target = requested;
    try {
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      if (!(await stat(target)).isFile()) throw new Error('Not a file');
    } catch {
      // Deliberately no SPA fallback: this server models plain GitHub Pages.
      // Static-mode direct links must resolve to real emitted files (queries
      // and hashes still resolve to the single root index by HTTP semantics).
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': types.get(path.extname(target)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' blob:",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : 'Server error');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`FrogLabel static server: http://127.0.0.1:${port}${base}`);
});

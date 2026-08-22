import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'build', 'pages');
if (path.basename(output) !== 'pages' || path.basename(path.dirname(output)) !== 'build') {
  throw new Error(`Refusing unsafe Pages output: ${output}`);
}
await rm(output, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'pages'],
    {
      cwd: root,
      env: { ...process.env, FROGLABEL_BASE: '/frog_label/' },
      stdio: 'inherit',
    },
  );
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Pages asset build exited with ${signal ?? code}`));
  });
});

await mkdir(path.join(output, 'audio'), { recursive: true });
await Promise.all([
  cp(path.join(root, 'public/audio'), path.join(output, 'audio'), { recursive: true }),
  cp(path.join(root, 'public/favicon.svg'), path.join(output, 'favicon.svg')),
  cp(path.join(root, 'public/icons.svg'), path.join(output, 'icons.svg')),
]);

const index = await readFile(path.join(output, 'index.html'), 'utf8');
if (!index.includes('/frog_label/assets/')) {
  throw new Error('Pages index does not use the required /frog_label/ asset base');
}
const assets = await readdir(path.join(output, 'assets'));
const entries = assets.filter((name) => /^index-.*\.(?:js|css)$/u.test(name));
const greenTreeAudio = assets.filter((name) => /^green_tree-.*\.mp3$/u.test(name));
if (greenTreeAudio.length !== 1) {
  throw new Error(`Pages output must contain one bundled GRE recording, found: ${greenTreeAudio}`);
}
for (const entry of entries) {
  if (!index.includes(`/frog_label/assets/${entry}`)) {
    throw new Error(`Pages output contains an orphan entry asset: ${entry}`);
  }
}
await Promise.all([
  access(path.join(output, 'audio/synthetic-frog-practice.wav')),
  access(path.join(output, 'icons.svg')),
]);
console.log(`GitHub Pages assets ready: ${output}`);

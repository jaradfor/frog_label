import { spawn } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'build', 'ce');
if (path.basename(output) !== 'ce' || path.basename(path.dirname(output)) !== 'build') {
  throw new Error(`Refusing unsafe CE output: ${output}`);
}
await rm(output, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', output],
    {
      cwd: root,
      env: { ...process.env, FROGLABEL_BASE: '/react-app/froglabel/' },
      stdio: 'inherit',
    },
  );
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`CE asset build exited with ${signal ?? code}`));
  });
});

const index = await readFile(path.join(output, 'index.html'), 'utf8');
if (!index.includes('/react-app/froglabel/assets/')) {
  throw new Error('CE index does not use the required /react-app/froglabel/ asset base');
}
await Promise.all([
  access(path.join(output, 'audio/synthetic-frog-practice.wav')),
  access(path.join(output, 'icons.svg')),
]);
// Vite's development public tree contains a deterministic ReactCode host used
// only by local E2E. It must never become a production same-origin CE route.
await rm(path.join(output, 'fake-host'), { recursive: true, force: true });
console.log(`CE FrogLabel assets ready: ${output}`);

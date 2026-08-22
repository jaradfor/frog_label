import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentChromiumExecutable, prepareAgentPlaywrightTools } from './agent-chromium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function run(script, args, environment) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} exited with ${signal ?? code}`));
    });
  });
}

const executablePath = await agentChromiumExecutable();
const browsersPath = await prepareAgentPlaywrightTools(root);
const environment = {
  ...process.env,
  FROGLABEL_BASE: '/frog_label/',
  FROGLABEL_E2E_IN_PROCESS: '1',
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: executablePath,
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
};

console.log(`Agent E2E Chromium: ${executablePath}`);
await run(path.join(root, 'node_modules/vite/bin/vite.js'), ['build'], environment);
await run(
  path.join(root, 'node_modules/@playwright/test/cli.js'),
  ['test', ...process.argv.slice(2)],
  environment,
);

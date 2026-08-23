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
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  FROGLABEL_BASE: '/frog_label/',
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: executablePath,
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
};

console.log(`Static Pages Chromium: ${executablePath}`);
await run(path.join(root, 'scripts/build-pages-assets.mjs'), [], environment);
await run(
  path.join(root, 'node_modules/@playwright/test/cli.js'),
  ['test', '--config', 'playwright.pages.config.ts', ...process.argv.slice(2)],
  environment,
);

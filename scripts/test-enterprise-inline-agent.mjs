import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'vite';

import { agentChromiumExecutable, prepareAgentPlaywrightTools } from './agent-chromium.mjs';

const repository = path.resolve(import.meta.dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = await prepareAgentPlaywrightTools(repository);
const { chromium } = await import('@playwright/test');
const enterpriseDirectory = path.resolve(
  process.env.FROGLABEL_ENTERPRISE_ARTIFACTS ?? '.cache/enterprise-run-1',
);
const output = path.resolve(
  process.env.FROGLABEL_ENTERPRISE_EVIDENCE ??
    'test-results/playwright-reactcode-inline-harness/run-1',
);
const port = Number(process.env.FROGLABEL_ENTERPRISE_PORT ?? '8130');
const origin = `http://127.0.0.1:${port}`;
const xmlPath = path.join(enterpriseDirectory, 'froglabel.enterprise.xml');
const xml = await readFile(xmlPath, 'utf8');
const component = extractComponent(xml);
const hostBuild = path.join(repository, '.cache', 'enterprise-inline-host-build');
const browserEvents = [];
const network = [];
const fatal = [];
const explorerSeed = Number(process.env.FROGLABEL_EXPLORER_SEED ?? '24082026');
const explorerActions = [];
const recordAction = (action, invariant) =>
  explorerActions.push({ index: explorerActions.length, action, invariant });
const startedAt = Date.now();
let browser;
let context;
let server;

await mkdir(output, { recursive: true });
await build({
  configFile: false,
  logLevel: 'error',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: hostBuild,
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    target: 'es2022',
    lib: {
      entry: path.join(repository, 'scripts', 'enterprise-inline-harness-entry.tsx'),
      formats: ['iife'],
      name: 'FrogLabelEnterpriseInlineHarness',
      fileName: () => 'host.js',
    },
  },
});
const hostJavaScript = await readFile(path.join(hostBuild, 'host.js'));
const audioProfile = process.env.FROGLABEL_ENTERPRISE_AUDIO_PROFILE ?? 'standard';
const audio =
  audioProfile === 'maximum'
    ? maximumStereoWav()
    : await readFile(path.join(repository, 'public', 'audio', 'synthetic-frog-practice.wav'));
const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0"><div id="root"></div>
    <script>
      window.__froglabelBootstrap = { beforeComponent: true };
      window.addEventListener('error', (event) => {
        window.__froglabelBootstrap.windowError = String(event.error?.stack ?? event.message);
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__froglabelBootstrap.unhandledRejection = String(
          event.reason?.stack ?? event.reason,
        );
      });
    </script>
    <script>${component}</script>
    <script>
      window.__froglabelBootstrap.afterComponent = true;
      window.__froglabelBootstrap.componentType = typeof FrogLabelEnterprise;
    </script>
    <script
      src="/host.js"
      onload="window.__froglabelBootstrap.hostLoaded = true"
      onerror="window.__froglabelBootstrap.hostLoadError = true"
    ></script>
  </body>
</html>`;

function extractComponent(value) {
  const match = value.match(/<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>/u);
  if (!match) throw new Error('Generated Enterprise XML has no CDATA component');
  if (/\ssrc\s*=/u.test(value)) throw new Error('Generated Enterprise XML unexpectedly has src');
  if (match[1].includes('</script')) {
    throw new Error(
      'Generated Enterprise component cannot be injected as a literal browser script',
    );
  }
  return match[1];
}

function respond(response, status, contentType, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': contentType,
  });
  response.end(body);
}

function maximumStereoWav() {
  const sampleRate = 192_000;
  const seconds = 30;
  const channels = 2;
  const frameCount = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + frameCount * channels * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(frameCount * channels * 2, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    const rightOnly = time >= 0.1 && time < 0.22 ? 0.55 * Math.sin(2 * Math.PI * 42_000 * time) : 0;
    const antiphase =
      time >= 29.82 && time < 29.94 ? 0.4 * Math.sin(2 * Math.PI * 18_000 * time) : 0;
    bytes.writeInt16LE(Math.round(antiphase * 32_767), 44 + frame * 4);
    bytes.writeInt16LE(Math.round((rightOnly - antiphase) * 32_767), 46 + frame * 4);
  }
  return bytes;
}

async function listen() {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', origin).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      respond(response, 200, 'text/html; charset=utf-8', html);
    } else if (pathname === '/host.js') {
      respond(response, 200, 'text/javascript; charset=utf-8', hostJavaScript);
    } else if (pathname === '/audio.wav') {
      respond(response, 200, 'audio/wav', audio);
    } else {
      respond(response, 404, 'text/plain; charset=utf-8', 'not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function drawBox(page) {
  await waitForFirstSpectrogramFrame(page.locator('.spectrogram-shell'));
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).click();
  await page.getByRole('button', { name: /Draw Box/ }).click();
  const rectangle = await page.locator('canvas.spectrogram-canvas').boundingBox();
  if (!rectangle) throw new Error('Enterprise exact-code spectrogram has no bounding box');
  await page.mouse.move(rectangle.x + rectangle.width * 0.2, rectangle.y + rectangle.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width * 0.52,
    rectangle.y + rectangle.height * 0.62,
    {
      steps: 8,
    },
  );
  await page.mouse.up();
  await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).waitFor();
}

async function waitForFirstSpectrogramFrame(shell) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await shell.getAttribute('data-spectrogram-state')) === 'firstFrameReady') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Spectrogram did not paint its first current frame');
}

async function waitForRegions(page, count) {
  await page.waitForFunction(
    (expected) => window.__enterpriseHarness?.annotations().length === expected,
    count,
  );
}

try {
  await listen();
  const executablePath = await agentChromiumExecutable();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--no-first-run',
    ],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  // Intercept only network schemes. Routing blob: worker bootstrap requests in
  // Chromium changes their lifecycle reporting and can manufacture ERR_ABORTED.
  await context.route(/^https?:\/\//u, async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) {
      fatal.push(`external-request:${route.request().method()} ${requested.href}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  context.on('request', (request) => {
    network.push({ event: 'request', method: request.method(), url: request.url() });
  });
  context.on('response', (response) => {
    network.push({
      event: 'response',
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    });
    if (response.status() >= 400) {
      fatal.push(`http:${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  context.on('requestfailed', (request) => {
    fatal.push(
      `requestfailed:${request.failure()?.errorText ?? 'unknown'} ${request.method()} ${request.url()}`,
    );
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    const entry = `console:${message.type()} ${message.text()}`;
    browserEvents.push(entry);
    if (['warning', 'error'].includes(message.type())) fatal.push(entry);
  });
  page.on('pageerror', (error) => {
    const entry = `pageerror:${error.stack ?? error.message}`;
    browserEvents.push(entry);
    fatal.push(entry);
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).waitFor({ timeout: 180_000 });
  const startupMilliseconds = Date.now() - startedAt;
  recordAction('execute exact XML component', 'inline workspace reached ready state');

  if (audioProfile === 'maximum') {
    await page.keyboard.press('3');
    const channel = page.getByLabel('Analysis channel');
    await channel.waitFor({ state: 'visible' });
    for (const label of ['Max', 'Left', 'Right', 'Average mixdown']) {
      await channel.selectOption({ label });
    }
    recordAction(
      'load 30-second 192 kHz stereo fixture and cycle analysis channels',
      'stereo playback source retained; Average/Max/Left/Right controls rendered',
    );
  }

  await drawBox(page);
  await waitForRegions(page, 1);
  const beforeResize = await page.evaluate(() => window.__enterpriseHarness.annotations());
  const stableOuterId = beforeResize[0].id;

  await page.getByRole('button', { name: 'Select V' }).click();
  await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).click();
  const resize = page.getByRole('button', { name: 'Resize GRE box from SE corner' });
  const rectangle = await resize.boundingBox();
  if (!rectangle) throw new Error('Enterprise selected box has no SE resize handle');
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width / 2 + 30,
    rectangle.y + rectangle.height / 2 + 16,
    {
      steps: 4,
    },
  );
  await page.mouse.up();
  await page.getByTestId('host-submit').click();
  await page.waitForFunction(() => window.__enterpriseHarness.lastSubmit()?.boxes?.length === 1);
  const submitted = await page.evaluate(() => window.__enterpriseHarness.lastSubmit());
  const afterResize = await page.evaluate(() => window.__enterpriseHarness.annotations());
  if (afterResize[0].id !== stableOuterId)
    throw new Error('Enterprise update changed outer region ID');
  if (JSON.stringify(afterResize[0].value) !== JSON.stringify(submitted)) {
    throw new Error('Immediate resize-to-Submit lost the final authoritative document');
  }
  recordAction(
    'draw, resize pointer-up, submit simulation',
    'stable outer identity and exact edit',
  );

  await page.getByTestId('host-reload').click();
  await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).waitFor();
  const reloaded = await page.evaluate(() => window.__enterpriseHarness.annotations());
  if (JSON.stringify(reloaded[0].value) !== JSON.stringify(submitted)) {
    throw new Error('Enterprise authoritative reload changed the canonical document');
  }
  recordAction('authoritative reload', 'canonical submitted bytes preserved');
  await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).click();
  await page.getByRole('button', { name: 'Play selected box' }).click();
  await page.getByRole('button', { name: 'Help and tutorial' }).click();
  await page.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  if (
    JSON.stringify(await page.evaluate(() => window.__enterpriseHarness.annotations())) !==
    JSON.stringify(reloaded)
  ) {
    throw new Error('Enterprise tutorial mutated authoritative host regions');
  }
  recordAction(
    'selection playback and tutorial Space/Escape',
    'practice left host regions unchanged',
  );
  await page.screenshot({
    path: path.join(output, 'enterprise-inline-annotated.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Delete GRE box' }).click();
  await waitForRegions(page, 0);
  await page.getByRole('button', { name: 'No calls present (Shift+N)' }).click();
  await waitForRegions(page, 1);
  const noCalls = await page.evaluate(() => window.__enterpriseHarness.annotations()[0]);
  if (noCalls.value.reviewStatus !== 'no_calls' || noCalls.value.boxes?.length !== 0) {
    throw new Error('Enterprise explicit No calls did not create the required singleton');
  }
  await page.getByTestId('host-submit').click();
  await page.getByTestId('host-reload').click();
  if (
    (await page
      .getByRole('button', { name: 'No calls present (Shift+N)' })
      .getAttribute('aria-pressed')) !== 'true'
  ) {
    throw new Error('Enterprise No calls did not survive authoritative reload');
  }
  recordAction('delete, explicit No calls, submit and reload', 'zero-box singleton preserved');

  await page.getByTestId('host-lock').click();
  await page.getByText('Read-only', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'No calls present (Shift+N)' }).isEnabled()) {
    throw new Error('Enterprise viewState lock left domain mutation enabled');
  }
  await page.getByTestId('host-lock').click();
  await page.getByTestId('host-switch').click();
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).waitFor({ timeout: 180_000 });
  if ((await page.getByTestId('host-region-count').innerText()) !== '0 region(s)') {
    throw new Error('Enterprise task switch retained a region from the prior epoch');
  }
  await page.getByRole('button', { name: 'No calls present (Shift+N)' }).click();
  await waitForRegions(page, 1);
  recordAction(
    'task epoch switch and new No calls',
    'prior task state cleaned before new mutation',
  );
  await page.evaluate(() => window.__enterpriseHarness.setDuplicate());
  await page
    .getByText('More than one FrogLabel document exists in this annotation', { exact: true })
    .waitFor({ timeout: 30_000 });
  recordAction(
    'lock then inject duplicate host region',
    'mutation disabled and duplicate failed read-only',
  );

  if (fatal.length) throw new Error(`Forbidden browser/network events:\n${fatal.join('\n')}`);
  const raw = {
    afterResize,
    beforeResize,
    noCalls,
    reloaded,
    stableOuterId,
    submitted,
  };
  const summary = {
    audioBytes: audio.length,
    audioProfile,
    browser: await browser.version(),
    componentBytes: Buffer.byteLength(component),
    exactExtractedComponent: true,
    networkRequests: network.filter((entry) => entry.event === 'request').length,
    startupMilliseconds,
    usedJsHeapBytes: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null),
    xmlBytes: Buffer.byteLength(xml),
  };
  await writeFile(
    path.join(output, 'raw-region-lifecycle.json'),
    `${JSON.stringify(raw, null, 2)}\n`,
  );
  await writeFile(path.join(output, 'network.json'), `${JSON.stringify(network, null, 2)}\n`);
  await writeFile(
    path.join(output, 'browser.log'),
    `${browserEvents.join('\n')}${browserEvents.length ? '\n' : ''}`,
  );
  await writeFile(path.join(output, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    path.join(output, 'seeded-explorer.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        seed: explorerSeed,
        target: 'enterprise-exact-inline-xml-local-harness',
        actions: explorerActions,
        browserProblems: fatal,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.at(-1);
    if (page) {
      await page
        .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
        .catch(() => undefined);
      await writeFile(
        path.join(output, 'failure.html'),
        await page.content().catch(() => '<html><body>page content unavailable</body></html>'),
      );
      await writeFile(
        path.join(output, 'bootstrap.json'),
        `${JSON.stringify(
          await page
            .evaluate(() => window.__froglabelBootstrap ?? null)
            .catch((evaluationError) => ({ evaluationError: String(evaluationError) })),
          null,
          2,
        )}\n`,
      );
    }
  }
  await writeFile(
    path.join(output, 'browser.log'),
    `${[...browserEvents, ...fatal.filter((entry) => !browserEvents.includes(entry))].join('\n')}${
      browserEvents.length || fatal.length ? '\n' : ''
    }`,
  );
  await writeFile(path.join(output, 'network.json'), `${JSON.stringify(network, null, 2)}\n`);
  throw error;
} finally {
  await context?.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => undefined);
  await context?.close().catch(() => undefined);
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}

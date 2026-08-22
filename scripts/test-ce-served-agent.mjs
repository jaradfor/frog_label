import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { agentChromiumExecutable } from './agent-chromium.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const required = ['FROGLABEL_CE_SOURCE', 'FROGLABEL_CE_VENV'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const source = path.resolve(process.env.FROGLABEL_CE_SOURCE);
const venv = path.resolve(process.env.FROGLABEL_CE_VENV);
const python = path.join(venv, 'bin', 'python');
const froglabel = path.join(venv, 'bin', 'froglabel');
const manage = path.join(source, 'label_studio', 'manage.py');
const port = Number(process.env.FROGLABEL_CE_PORT ?? '8093');
const proxyPort = port + 1;
const origin = `http://127.0.0.1:${port}`;
const output = path.resolve(
  process.env.FROGLABEL_CE_EVIDENCE ?? 'test-results/playwright-label-studio-ce-served/run-1',
);
const email = 'agent@example.test';
const outsiderEmail = 'outsider@example.test';
const password = 'froglabel-local-only';
const runtime = await mkdtemp(path.join(os.tmpdir(), 'froglabel-ce-served-'));
const dataDir = path.join(runtime, 'data');
const databaseTemplate = process.env.FROGLABEL_CE_DATABASE_TEMPLATE
  ? path.resolve(process.env.FROGLABEL_CE_DATABASE_TEMPLATE)
  : null;
const serverLogPath = path.join(output, 'server.log');
const browserLogPath = path.join(output, 'browser.log');
const networkLogPath = path.join(output, 'network.json');
const commandLogPath = path.join(output, 'commands.json');
const commands = [];
const browserEvents = [];
const networkEvents = [];
const fatalBrowserEvents = [];
const explorerSeed = Number(process.env.FROGLABEL_EXPLORER_SEED ?? '24082026');
const explorerActions = [];
const recordAction = (action, invariant) =>
  explorerActions.push({ index: explorerActions.length, action, invariant });
const pendingDocuments = new Set();
let lastDocumentActivityAt = Date.now();
let browser;
let server;
let denyProxy;
let fixture;

await mkdir(dataDir, { recursive: true });
await mkdir(output, { recursive: true });
if (databaseTemplate) {
  await copyFile(databaseTemplate, path.join(dataDir, 'label_studio.sqlite3'));
}

const djangoEnvironment = {
  ...process.env,
  ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
  COLLECT_ANALYTICS: '0',
  COVERAGE_PROCESS_START: '',
  DJANGO_SETTINGS_MODULE: 'froglabel_cli.ce_overlay.settings',
  FRONTEND_SENTRY_DSN: '',
  FROGLABEL_SERVE_STATIC: '1',
  HOST: origin,
  HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
  HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
  LABEL_STUDIO_BASE_DATA_DIR: dataDir,
  LATEST_VERSION_CHECK: '0',
  NO_PROXY: '127.0.0.1,localhost',
  PYTHONPATH: [path.join(repoRoot, 'python'), source, path.join(source, 'label_studio')].join(
    path.delimiter,
  ),
  SENTRY_DSN: '',
  all_proxy: `http://127.0.0.1:${proxyPort}`,
  http_proxy: `http://127.0.0.1:${proxyPort}`,
  https_proxy: `http://127.0.0.1:${proxyPort}`,
  no_proxy: '127.0.0.1,localhost',
};

function pythonScriptArguments(script, scriptArguments = []) {
  const sourcePackage = path.join(source, 'label_studio');
  const launcher = [
    'import runpy, sys',
    `sys.path.insert(0, ${JSON.stringify(sourcePackage)})`,
    `sys.argv = [${JSON.stringify(script)}, *sys.argv[1:]]`,
    `runpy.run_path(${JSON.stringify(script)}, run_name='__main__')`,
  ].join('; ');
  return ['-c', launcher, ...scriptArguments];
}

function now() {
  return new Date().toISOString();
}

function run(command, args, { cwd = repoRoot, env = djangoEnvironment, timeoutMs = 180_000 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      const record = {
        args,
        command,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        signal,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      commands.push(record);
      if (code === 0) resolve(record);
      else
        reject(
          new Error(
            `Command failed (${code ?? signal}): ${command} ${args.join(' ')}\n${record.stderr}`,
          ),
        );
    });
  });
}

async function provision() {
  await run(
    python,
    databaseTemplate
      ? pythonScriptArguments(manage, ['migrate', '--check', '--verbosity', '0'])
      : pythonScriptArguments(manage, ['migrate', '--noinput', '--verbosity', '0']),
    { timeoutMs: 300_000 },
  );
  await run(
    python,
    pythonScriptArguments(manage, ['collectstatic', '--noinput', '--verbosity', '0']),
    {
      timeoutMs: 300_000,
    },
  );
  const fixtureScript = path.join(repoRoot, 'scripts', 'provision_ce_fixture.py');
  const fixtureResult = await run(
    python,
    pythonScriptArguments(fixtureScript, [
      '--email',
      email,
      '--password',
      password,
      '--title',
      'FrogLabel CE served evidence',
    ]),
  );
  fixture = JSON.parse(fixtureResult.stdout.trim());
  if (fixture.isStaff || fixture.isSuperuser) {
    throw new Error('CE browser proof user unexpectedly has administrator privileges');
  }
  const projectEnvironment = { ...djangoEnvironment };
  for (const name of [
    'COVERAGE_PROCESS_START',
    'DJANGO_SETTINGS_MODULE',
    'FROGLABEL_SERVE_STATIC',
    'LABEL_STUDIO_BASE_DATA_DIR',
    'PYTHONPATH',
  ]) {
    delete projectEnvironment[name];
  }
  await run(
    froglabel,
    [
      'project',
      'init',
      '--target',
      'ce',
      '--source',
      source,
      '--data-dir',
      dataDir,
      '--project',
      '1',
      '--config-dir',
      path.join(repoRoot, 'examples', 'configs'),
      '--config-name',
      'demo-seeded',
    ],
    { cwd: runtime, env: projectEnvironment },
  );
}

async function startServer() {
  const startedAt = Date.now();
  const stdout = [];
  const stderr = [];
  const serverArguments = [
    'ls-ce',
    'start',
    '--source',
    source,
    '--data-dir',
    dataDir,
    '--bind',
    `127.0.0.1:${port}`,
  ];
  server = spawn(froglabel, serverArguments, {
    cwd: runtime,
    detached: true,
    env: djangoEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => stdout.push(chunk));
  server.stderr.on('data', (chunk) => stderr.push(chunk));
  server.once('error', (error) =>
    fatalBrowserEvents.push(`server:error ${error.stack ?? error.message}`),
  );
  server.once('exit', (code, signal) => {
    if (code !== null && code !== 0)
      fatalBrowserEvents.push(`server:exit code=${code} signal=${signal}`);
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        commands.push({
          args: serverArguments,
          command: froglabel,
          durationMs: Date.now() - startedAt,
          exitCode: null,
          signal: null,
          stderr: '',
          stdout: 'Server reached /health; terminated by the evidence harness after the run.\n',
        });
        return { stdout, stderr };
      }
    } catch {
      // Normal during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Label Studio did not become healthy at ${origin}`);
}

function installFailureGuards(context, page) {
  context.on('request', (request) => {
    if (request.resourceType() === 'document') {
      pendingDocuments.add(request);
      lastDocumentActivityAt = Date.now();
    }
    networkEvents.push({
      at: now(),
      event: 'request',
      method: request.method(),
      url: request.url(),
    });
  });
  context.on('response', (response) => {
    const request = response.request();
    networkEvents.push({
      at: now(),
      contentType: response.headers()['content-type'] ?? '',
      event: 'response',
      method: request.method(),
      status: response.status(),
      url: response.url(),
    });
    if (response.status() >= 400) {
      fatalBrowserEvents.push(`http:${response.status()} ${request.method()} ${response.url()}`);
    }
  });
  context.on('requestfinished', (request) => {
    pendingDocuments.delete(request);
    if (request.resourceType() === 'document') lastDocumentActivityAt = Date.now();
  });
  context.on('requestfailed', (request) => {
    pendingDocuments.delete(request);
    const failure = request.failure()?.errorText ?? 'unknown';
    const message = `requestfailed:${failure} ${request.method()} ${request.url()}`;
    const requested = new URL(request.url());
    const expectedTutorialCancellation =
      failure === 'net::ERR_ABORTED' &&
      request.method() === 'GET' &&
      requested.origin === origin &&
      requested.pathname === '/react-app/froglabel/audio/synthetic-frog-practice.wav';
    if (request.resourceType() === 'document') lastDocumentActivityAt = Date.now();
    networkEvents.push({
      at: now(),
      error: failure,
      event: 'requestfailed',
      expectedCancellation: expectedTutorialCancellation,
      method: request.method(),
      url: request.url(),
    });
    browserEvents.push(message);
    if (!expectedTutorialCancellation) fatalBrowserEvents.push(message);
  });
  page.on('console', (message) => {
    const location = message.location();
    const source = location.url
      ? ` ${location.url}:${location.lineNumber}:${location.columnNumber}`
      : '';
    const entry = `console:${message.type()} ${message.text()}${source}`;
    browserEvents.push(entry);
    if (['warning', 'error'].includes(message.type())) fatalBrowserEvents.push(entry);
  });
  page.on('pageerror', (error) => {
    const entry = `pageerror:${error.stack ?? error.message}`;
    browserEvents.push(entry);
    fatalBrowserEvents.push(entry);
  });
}

async function waitForNetworkSettled(timeoutMilliseconds = 30_000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    // A Label Studio MobX reaction can enqueue a replacement iframe document
    // in the tick immediately after a submit/reload assertion. Always allow a
    // short observation window before declaring an already-quiet connection
    // settled, then require the full post-navigation idle interval. Without
    // the first condition page.goto can race that deferred iframe load and
    // manufacture a local net::ERR_ABORTED that no user workflow produced.
    if (
      pendingDocuments.size === 0 &&
      Date.now() - startedAt >= 300 &&
      Date.now() - lastDocumentActivityAt >= 1_500
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Document navigation did not settle; ${pendingDocuments.size} request(s) remain`);
}

async function startDenyProxy() {
  denyProxy = createServer((request, response) => {
    const entry = `proxy-blocked:${request.method} ${request.url}`;
    browserEvents.push(entry);
    fatalBrowserEvents.push(entry);
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('External network access is forbidden in FrogLabel evidence runs.\n');
  });
  denyProxy.on('connect', (request, socket) => {
    const entry = `proxy-blocked:CONNECT ${request.url}`;
    browserEvents.push(entry);
    fatalBrowserEvents.push(entry);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    denyProxy.once('error', reject);
    denyProxy.listen(proxyPort, '127.0.0.1', resolve);
  });
}

async function apiJson(context, pathname) {
  const response = await context.request.get(`${origin}${pathname}`);
  if (!response.ok()) throw new Error(`API GET ${pathname} returned ${response.status()}`);
  return response.json();
}

async function waitForTask(context, taskId, predicate, description) {
  let task;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    task = await apiJson(context, `/api/tasks/${taskId}`);
    assertSingletonPerAnnotation(task);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for task ${taskId}: ${description}`);
}

function annotationResults(task) {
  return (task.annotations ?? []).map((annotation) => ({
    annotation,
    results: (annotation.result ?? []).filter((entry) => entry.type === 'reactcode'),
  }));
}

function assertSingletonPerAnnotation(task) {
  for (const { annotation, results } of annotationResults(task)) {
    if (results.length > 1) {
      throw new Error(
        `Task ${task.id} annotation ${annotation.id} has ${results.length} FrogLabel singleton results`,
      );
    }
  }
}

function completedDocuments(task) {
  return annotationResults(task)
    .flatMap(({ results }) => results)
    .map((result) => result.value?.reactcode)
    .filter(Boolean);
}

async function openTask(page, taskId) {
  await waitForNetworkSettled();
  await page.goto(`${origin}/projects/1/data?task=${taskId}`, { waitUntil: 'domcontentloaded' });
  const frame = page.frameLocator('[data-testid="froglabel-reactcode-frame"]');
  await frame.getByRole('button', { name: 'No calls present (Shift+N)' }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await frame.locator('canvas.spectrogram-canvas').waitFor({ state: 'visible', timeout: 60_000 });
  await waitForFirstSpectrogramFrame(frame.locator('.spectrogram-shell'));
  return frame;
}

async function selectSpecies(frame, name = 'GRE Green Tree Frog') {
  const option = frame.getByRole('option', { name });
  await option.waitFor({ state: 'visible', timeout: 60_000 });
  await option.click();
}

async function addProjectSpecies(page, frame) {
  await frame.getByRole('button', { name: /Add missing species/ }).click();
  await frame.getByLabel('Three-letter code').fill('TST');
  await frame.getByLabel('Full Species Name').fill('Test Tree Frog');
  const catalogResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/froglabel\/api\/projects\/1\/catalog\/$/u.test(new URL(response.url()).pathname),
    { timeout: 30_000 },
  );
  await frame.getByRole('button', { name: 'Save species' }).click();
  const response = await catalogResponse;
  if (!response.ok()) throw new Error(`Add species returned HTTP ${response.status()}`);
  await frame.getByRole('option', { name: 'TST Test Tree Frog' }).waitFor({ state: 'attached' });
  await selectSpecies(frame, 'TST Test Tree Frog');
  return response.json();
}

async function drawBox(page, frame, start, end) {
  await frame.getByRole('button', { name: /Draw Box/ }).click();
  const canvas = frame.locator('canvas.spectrogram-canvas');
  const rectangle = await canvas.boundingBox();
  if (!rectangle) throw new Error('FrogLabel spectrogram canvas has no bounding box');
  await page.mouse.move(
    rectangle.x + rectangle.width * start.x,
    rectangle.y + rectangle.height * start.y,
  );
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width * end.x,
    rectangle.y + rectangle.height * end.y,
    { steps: 8 },
  );
  await page.mouse.up();
}

async function waitForFirstSpectrogramFrame(shell) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if ((await shell.getAttribute('data-spectrogram-state')) === 'firstFrameReady') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Spectrogram did not paint its first current frame');
}

async function waitForBoxCount(frame, expected, species = /TST — Test Tree Frog/) {
  const rows = frame.getByRole('row', { name: species });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await rows.count()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FrogLabel did not render ${expected} matching species boxes`);
}

async function waitForHostEcho(frame) {
  await frame.getByText('Current Label Studio annotation updated', { exact: true }).waitFor({
    timeout: 30_000,
  });
}

function nativeSubmitButton(page) {
  return page
    .locator('button')
    .filter({ hasText: /^\s*(Submit|Update)\s*$/ })
    .last();
}

async function downloadNativeExport(page) {
  await waitForNetworkSettled();
  await page.goto(`${origin}/projects/1/data`, { waitUntil: 'domcontentloaded' });
  const exportButton = page.getByTestId('dm-export-button').first();
  await exportButton.waitFor({ state: 'visible', timeout: 60_000 });
  await exportButton.click();
  const exportAction = page.getByRole('button', { name: 'Export data' });
  await exportAction.waitFor({ state: 'visible', timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), exportAction.click()]);
  const destination = path.join(output, 'label-studio-ce-export.json');
  await download.saveAs(destination);
  return { destination, value: JSON.parse(await readFile(destination, 'utf8')) };
}

function exportedTask(exportValue, taskId) {
  const tasks = Array.isArray(exportValue) ? exportValue : exportValue.tasks;
  if (!Array.isArray(tasks))
    throw new Error('Native Label Studio export did not contain a task array');
  const task = tasks.find((candidate) => Number(candidate.id) === taskId);
  if (!task) throw new Error(`Native Label Studio export omitted task ${taskId}`);
  return task;
}

function listedTasks(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload.results)) return payload.results;
  throw new Error(`Unexpected task-list response: ${JSON.stringify(payload).slice(0, 500)}`);
}

async function login(page, accountEmail = email) {
  await page.goto(`${origin}/user/login/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill(accountEmail);
  await page.locator('#password').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/user/login/'),
    page.locator('#login-form button[type="submit"]').click(),
  ]);
}

async function nativeImport(page, files) {
  await waitForNetworkSettled();
  await page.goto(`${origin}/projects/1/data`, { waitUntil: 'domcontentloaded' });
  const openImport = page.getByTestId('dm-import-button').first();
  await openImport.waitFor({ state: 'visible', timeout: 60_000 });
  await Promise.all([
    page.waitForURL((url) => url.pathname.endsWith('/import'), { timeout: 60_000 }),
    openImport.click(),
  ]);
  const input = page.locator('#file-input');
  await input.waitFor({ state: 'attached', timeout: 60_000 });
  await input.setInputFiles(files);
  await page
    .getByText(`${files.length} files uploaded`, { exact: true })
    .waitFor({ timeout: 60_000 });
  const finish = page.getByRole('button', { name: 'Finish import' });
  await finish.waitFor({ state: 'visible' });
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/import'), { timeout: 60_000 }),
    finish.click(),
  ]);
}

async function waitUntil(description, callback, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} did not settle${lastError ? `: ${lastError.message}` : ''}`);
}

async function tutorialStep(frame, step, geometry) {
  const coach = frame.getByRole('dialog', { name: `Tutorial step ${step} of 12` });
  await coach.waitFor({ state: 'visible', timeout: 30_000 });
  const anchor = (await coach.getAttribute('data-tutorial-anchor')) ?? 'none';
  const settled = await waitUntil(`tutorial step ${step} target/coach geometry`, async () => {
    const coachBox = await coach.boundingBox();
    const targetBox =
      anchor === 'none' ? null : await frame.locator('.tutorial-ring').boundingBox();
    if (
      !coachBox ||
      coachBox.width <= 0 ||
      coachBox.height <= 0 ||
      (anchor !== 'none' && (!targetBox || targetBox.width <= 0 || targetBox.height <= 0))
    )
      return null;
    let overlapRatio = 0;
    if (targetBox) {
      const width = Math.max(
        0,
        Math.min(targetBox.x + targetBox.width, coachBox.x + coachBox.width) -
          Math.max(targetBox.x, coachBox.x),
      );
      const height = Math.max(
        0,
        Math.min(targetBox.y + targetBox.height, coachBox.y + coachBox.height) -
          Math.max(targetBox.y, coachBox.y),
      );
      overlapRatio = (width * height) / (targetBox.width * targetBox.height);
    }
    return overlapRatio <= 0.25 ? { anchor, coachBox, targetBox, overlapRatio, step } : null;
  });
  geometry.push(settled);
}

async function tutorialNext(frame) {
  await frame.getByRole('button', { name: /^Next/ }).click();
}

async function tutorialDraw(page, frame) {
  const stage = frame.locator('.tutorial-practice-layer .spectrogram-stage');
  const rectangle = await stage.boundingBox();
  if (!rectangle) throw new Error('Tutorial spectrogram stage has no bounding box');
  await page.mouse.move(
    rectangle.x + rectangle.width * 0.43,
    rectangle.y + rectangle.height * 0.72,
  );
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width * 0.57,
    rectangle.y + rectangle.height * 0.96,
    { steps: 8 },
  );
  await page.mouse.up();
  await waitUntil(
    'one tutorial box',
    async () => (await stage.getAttribute('data-box-count')) === '1',
  );
  const cells = await frame
    .getByRole('row', { name: /PER — Peron's Tree Frog/ })
    .locator('td')
    .allTextContents();
  const [start, end, low, high] = cells.slice(0, 4).map(Number);
  if (start > 3.6 || end < 4.4 || low > 1_050 || high < 5_000) {
    throw new Error(`Tutorial box missed the known practice call: ${cells.join(' | ')}`);
  }
}

async function tutorialResize(page, frame) {
  const selected = frame.locator('.tutorial-practice-layer .annotation-box.selected');
  await selected.waitFor({ state: 'visible' });
  const boxId = await selected.getAttribute('data-box-id');
  const before = await selected.getAttribute('style');
  const handle = await selected.locator('.handle-se').boundingBox();
  if (!boxId || !handle) throw new Error('Tutorial Select mode did not expose a stable box/handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2 + 20, {
    steps: 6,
  });
  await page.mouse.up();
  if ((await frame.locator(`.tutorial-practice-layer [data-box-id="${boxId}"]`).count()) !== 1)
    throw new Error('Tutorial resize changed the stable box count/identity');
  if ((await selected.getAttribute('style')) === before)
    throw new Error('Tutorial resize did not change box geometry');
  return boxId;
}

async function startTutorial(frame) {
  await frame.getByRole('button', { name: 'Help and tutorial' }).click();
  await frame.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await frame.getByRole('dialog', { name: /Tutorial step 1/ }).waitFor({ state: 'visible' });
}

async function completeCeTutorial(page, frame, expectedLiveBoxCount) {
  const geometry = [];
  await startTutorial(frame);
  await tutorialStep(frame, 1, geometry);
  const coach = frame.locator('.coachmark');
  await coach.focus();
  await coach.press('Space');
  await tutorialStep(frame, 2, geometry);
  await frame.getByRole('button', { name: 'Back', exact: true }).click();
  await tutorialStep(frame, 1, geometry);
  await tutorialNext(frame);
  await tutorialStep(frame, 2, geometry);
  await frame.getByRole('button', { name: /Play Audio/ }).click();
  await frame.getByRole('button', { name: /Pause/ }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 3, geometry);
  await frame.getByRole('option', { name: "PER Peron's Tree Frog" }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 4, geometry);
  await frame.getByRole('button', { name: /Draw Box/ }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 5, geometry);
  await tutorialDraw(page, frame);
  await tutorialNext(frame);
  await tutorialStep(frame, 6, geometry);
  await frame.getByRole('button', { name: 'Select V' }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 7, geometry);
  await tutorialResize(page, frame);
  await frame.getByRole('button', { name: 'Restart', exact: true }).click();
  await tutorialStep(frame, 1, geometry);
  if (
    (await frame
      .locator('.tutorial-practice-layer .spectrogram-stage')
      .getAttribute('data-box-count')) !== '0'
  )
    throw new Error('Tutorial Restart retained practice boxes');
  if (
    (await frame.getByRole('button', { name: 'Select V' }).getAttribute('aria-pressed')) !== 'true'
  )
    throw new Error('Tutorial Restart did not restore the initial Select tool');
  if (
    (await frame.locator('.tutorial-practice-layer').getByLabel('Current species').inputValue()) !==
    ''
  )
    throw new Error('Tutorial Restart retained the practice species selection');

  await tutorialNext(frame);
  await tutorialStep(frame, 2, geometry);
  await frame.getByRole('button', { name: /Play Audio/ }).click();
  await frame.getByRole('button', { name: /Pause/ }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 3, geometry);
  await frame.getByRole('option', { name: "PER Peron's Tree Frog" }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 4, geometry);
  await frame.getByRole('button', { name: /Draw Box/ }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 5, geometry);
  await tutorialDraw(page, frame);
  const stableBoxId = await frame
    .locator('.tutorial-practice-layer .annotation-box.selected')
    .getAttribute('data-box-id');
  await tutorialNext(frame);
  await tutorialStep(frame, 6, geometry);
  await frame.getByRole('button', { name: 'Select V' }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 7, geometry);
  if ((await tutorialResize(page, frame)) !== stableBoxId)
    throw new Error('Tutorial resize replaced the practice box UUID');
  // Deliberately put the next anchor into a state an ordinary learner does not
  // need to create. Force this test-only setup even when the current coach is
  // the topmost element at a short CE iframe height; the product behavior under
  // test is that advancing reopens and re-resolves the hidden target.
  await frame.getByRole('button', { name: '2 Details' }).click({ force: true });
  await tutorialNext(frame);
  await tutorialStep(frame, 8, geometry);
  if (
    !/^\d+\.\d{3}$/u.test(
      await frame.locator('.tutorial-practice-layer').getByLabel('Start (s)').inputValue(),
    )
  )
    throw new Error('Tutorial details did not use the three-decimal display format');
  if (
    !/^\d+$/u.test(
      await frame.locator('.tutorial-practice-layer').getByLabel('Low (Hz)').inputValue(),
    )
  )
    throw new Error('Tutorial details did not use the whole-Hz display format');

  const datasetBeforeView = await frame
    .getByRole('row', { name: /PER — Peron's Tree Frog/ })
    .innerText();
  await tutorialNext(frame);
  await tutorialStep(frame, 9, geometry);
  await frame.getByRole('button', { name: 'Zoom in spectrogram' }).click();
  await waitForFirstSpectrogramFrame(frame.locator('.tutorial-practice-layer .spectrogram-shell'));
  await frame.getByRole('button', { name: 'Pan P' }).click();
  const stageRectangle = await frame
    .locator('.tutorial-practice-layer .spectrogram-stage')
    .boundingBox();
  if (!stageRectangle) throw new Error('Tutorial stage disappeared during pan');
  const centerX = stageRectangle.x + stageRectangle.width / 2;
  const centerY = stageRectangle.y + stageRectangle.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 45, centerY, { steps: 6 });
  await page.mouse.up();
  await frame.getByRole('button', { name: 'Reset and fit spectrogram view' }).click();
  await waitForFirstSpectrogramFrame(frame.locator('.tutorial-practice-layer .spectrogram-shell'));
  if (
    (await frame.getByRole('row', { name: /PER — Peron's Tree Frog/ }).innerText()) !==
    datasetBeforeView
  )
    throw new Error('Tutorial zoom/pan/reset changed canonical coordinates');

  await tutorialNext(frame);
  await tutorialStep(frame, 10, geometry);
  await frame.getByRole('button', { name: /Add missing species/ }).click();
  await frame
    .locator('.tutorial-practice-layer')
    .getByLabel('Three-letter code')
    .waitFor({ state: 'visible' });
  await frame.getByRole('button', { name: 'Cancel' }).click();
  await tutorialNext(frame);
  await tutorialStep(frame, 11, geometry);
  if (
    (await frame
      .locator('.tutorial-practice-layer .spectrogram-stage')
      .getAttribute('data-box-count')) !== '1'
  )
    throw new Error('No-calls explanation changed the positive tutorial exercise');
  await tutorialNext(frame);
  await tutorialStep(frame, 12, geometry);
  await frame.getByRole('button', { name: /^Finish/ }).click();
  await waitUntil(
    'tutorial exit and live workspace restoration',
    async () =>
      (await frame.getByRole('dialog', { name: /Tutorial step/ }).count()) === 0 &&
      (await frame
        .locator('.live-workspace-layer .spectrogram-stage')
        .getAttribute('data-box-count')) === String(expectedLiveBoxCount) &&
      (await frame
        .locator('.live-workspace-layer .spectrogram-shell')
        .getAttribute('data-spectrogram-state')) === 'firstFrameReady',
  );

  await startTutorial(frame);
  await frame.locator('.coachmark').focus();
  await frame.locator('.coachmark').press('Escape');
  await waitUntil(
    'Escape tutorial exit',
    async () => (await frame.getByRole('dialog', { name: /Tutorial step/ }).count()) === 0,
  );
  return geometry;
}

async function runStockProjectCanary(page, context) {
  await waitForNetworkSettled();
  await page.goto(`${origin}/projects/${fixture.stockProject}/data?task=${fixture.stockTask}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2_000);
  const stockDiagnostic = {
    bodyText: (await page.locator('body').innerText()).slice(0, 10_000),
    frames: page.frames().map((frame) => ({ name: frame.name(), url: frame.url() })),
  };
  await writeFile(
    path.join(output, 'stock-label-studio-before-submit.json'),
    `${JSON.stringify(stockDiagnostic, null, 2)}\n`,
  );
  await page.screenshot({
    path: path.join(output, 'stock-label-studio-before-submit.png'),
    fullPage: true,
  });
  const stockSurface = page.frames().find((candidate) => candidate !== page.mainFrame()) ?? page;
  const frogChoice = stockSurface.getByText(/^Frog(?:\[1\])?$/u).last();
  await frogChoice.waitFor({ state: 'visible', timeout: 30_000 });
  await frogChoice.click();
  const submit = nativeSubmitButton(page);
  await submit.waitFor({ state: 'visible', timeout: 30_000 });
  await submit.click();
  const task = await waitForTask(
    context,
    fixture.stockTask,
    (candidate) =>
      (candidate.annotations ?? []).some((annotation) =>
        (annotation.result ?? []).some(
          (result) => result.type === 'choices' && result.value?.choices?.includes('Frog'),
        ),
      ),
    'stock non-FrogLabel Choices Submit',
  );
  await page.screenshot({
    path: path.join(output, 'stock-label-studio-canary.png'),
    fullPage: true,
  });
  await writeFile(
    path.join(output, 'stock-label-studio-canary.json'),
    `${JSON.stringify(task, null, 2)}\n`,
  );
  return task;
}

async function verifyOutsiderPermissionError(browserInstance) {
  const outsiderContext = await browserInstance.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await outsiderContext.route(/^https?:\/\//u, async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const outsiderPage = await outsiderContext.newPage();
  try {
    await login(outsiderPage, outsiderEmail);
    const catalogResponse = await outsiderContext.request.get(
      `${origin}/froglabel/api/projects/1/catalog/`,
    );
    const catalogBody = await catalogResponse.text();
    if (![403, 404].includes(catalogResponse.status())) {
      throw new Error(
        `Unprivileged project catalog request returned HTTP ${catalogResponse.status()}`,
      );
    }
    if (!catalogBody.trim()) throw new Error('Unprivileged project catalog error was blank');
    const catalogMessageActionable =
      /permission|access|not found|not available|organization|forbidden|exist|match|query|credential|denied/iu.test(
        catalogBody,
      );
    if (!catalogMessageActionable)
      throw new Error('Unprivileged project catalog error was not actionable');
    const projectResponse = await outsiderPage.goto(`${origin}/projects/1/data`, {
      waitUntil: 'domcontentloaded',
    });
    await outsiderPage.waitForTimeout(750);
    const pageText = await outsiderPage.locator('body').innerText();
    if (!pageText.trim()) throw new Error('Unprivileged project page rendered a blank error state');
    if (!/not available|not found|no project|permission|access|match/iu.test(pageText)) {
      throw new Error('Unprivileged project page did not explain the denied access');
    }
    await outsiderPage.screenshot({
      path: path.join(output, 'unprivileged-project-error.png'),
      fullPage: true,
    });
    const evidence = {
      catalogBody,
      catalogStatus: catalogResponse.status(),
      catalogMessageActionable,
      pageStatus: projectResponse?.status() ?? null,
      pageText: pageText.slice(0, 2_000),
    };
    await writeFile(
      path.join(output, 'unprivileged-project-error.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    return evidence;
  } finally {
    await outsiderContext.close();
  }
}

async function assertClean(stage) {
  if (fatalBrowserEvents.length) {
    throw new Error(
      `${stage} emitted forbidden browser/network events:\n${fatalBrowserEvents.join('\n')}`,
    );
  }
}

let serverBuffers;
try {
  await startDenyProxy();
  await provision();
  serverBuffers = await startServer();
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
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=127.0.0.1;localhost',
    ],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    serviceWorkers: 'allow',
    // Label Studio's left table and right inspector leave the central editor
    // close to the independently reviewed ~844 px embedded width here.
    viewport: { width: 1440, height: 1000 },
  });
  // The proxy policy concerns HTTP(S). Leave browser-owned blob: worker URLs
  // alone so route interception cannot alter their lifecycle.
  await context.route(/^https?:\/\//u, async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin !== origin) {
      const entry = `external-request:${route.request().method()} ${requested.href}`;
      browserEvents.push(entry);
      fatalBrowserEvents.push(entry);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await context.addInitScript(() => {
    window.__froglabelObservedMessages = [];
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && typeof data === 'object' && typeof data.type === 'string') {
        window.__froglabelObservedMessages.push({
          data,
          origin: event.origin,
          sourceIsParent: event.source === window.parent,
        });
      }
    });
    window.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.error(`Unhandled rejection: ${String(event.reason)}`);
    });
  });
  const page = await context.newPage();
  installFailureGuards(context, page);

  await login(page);
  await assertClean('login');
  recordAction('authenticate disposable CE user', 'fresh local session; no external request');

  const mp3Path = path.join(runtime, 'short-stereo.mp3');
  const blankCheckPath = path.join(runtime, 'blank-submit-check.wav');
  const mp3Base64 = await readFile(
    path.join(repoRoot, 'tests', 'fixtures', 'short-stereo.mp3.b64'),
    'utf8',
  );
  await writeFile(mp3Path, Buffer.from(mp3Base64.trim(), 'base64'));
  await copyFile(
    path.join(repoRoot, 'public', 'audio', 'synthetic-frog-practice.wav'),
    blankCheckPath,
  );
  await nativeImport(page, [
    path.join(repoRoot, 'public', 'audio', 'synthetic-frog-practice.wav'),
    mp3Path,
    blankCheckPath,
  ]);
  await assertClean('native audio import');
  recordAction('native import WAV, MP3, and blank-check WAV', 'three URL-string task payloads');

  const taskPayload = await apiJson(context, '/api/tasks/?project=1');
  const tasks = listedTasks(taskPayload).sort((left, right) => left.id - right.id);
  if (tasks.length !== 3)
    throw new Error(`Native import produced ${tasks.length} tasks instead of 3`);
  for (const task of tasks) {
    if (typeof task.data?.froglabel !== 'string') {
      throw new Error(`Task ${task.id} did not map its uploaded media to data.froglabel`);
    }
  }
  await writeFile(
    path.join(output, 'tasks-after-native-import.json'),
    `${JSON.stringify(tasks, null, 2)}\n`,
  );

  const firstTaskId = tasks[0].id;
  const noCallsTaskId = tasks[1].id;
  const blankTaskId = tasks[2].id;
  let frame = await openTask(page, firstTaskId);
  const embeddedFrameRectangle = await page
    .locator('[data-testid="froglabel-reactcode-frame"]')
    .boundingBox();
  if (
    !embeddedFrameRectangle ||
    embeddedFrameRectangle.width < 700 ||
    embeddedFrameRectangle.width > 1_000
  ) {
    throw new Error(
      `CE iframe evidence width was not realistic: ${JSON.stringify(embeddedFrameRectangle)}`,
    );
  }
  let addedSpecies;
  try {
    addedSpecies = await addProjectSpecies(page, frame);
  } catch (error) {
    const diagnostic = {
      frameBody: await frame
        .locator('body')
        .innerText()
        .catch(() => '<frame body unavailable>'),
      frameMessages: await frame
        .locator('body')
        .evaluate(() => window.__froglabelObservedMessages)
        .catch(() => '<frame messages unavailable>'),
      parentMessages: await page.evaluate(() => window.__froglabelObservedMessages),
      url: page.url(),
    };
    await writeFile(
      path.join(output, 'iframe-diagnostic.json'),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
    );
    await page.screenshot({ path: path.join(output, 'iframe-failure.png'), fullPage: true });
    throw error;
  }
  await page.screenshot({ path: path.join(output, 'ce-native-import-loaded.png'), fullPage: true });
  await assertClean('FrogLabel iframe load');
  await writeFile(
    path.join(output, 'ordinary-member-add-species.json'),
    `${JSON.stringify({ fixture, response: addedSpecies }, null, 2)}\n`,
  );
  recordAction(
    'ordinary member adds and selects TST Test Tree Frog',
    'project catalog write succeeded without staff/superuser privileges',
  );

  await drawBox(page, frame, { x: 0.18, y: 0.24 }, { x: 0.48, y: 0.58 });
  await waitForBoxCount(frame, 1);
  await waitForHostEcho(frame);
  await drawBox(page, frame, { x: 0.31, y: 0.34 }, { x: 0.61, y: 0.68 });
  await waitForBoxCount(frame, 2);
  await waitForHostEcho(frame);

  await frame.getByRole('button', { name: 'Select V' }).click();
  const canvasRectangle = await frame.locator('canvas.spectrogram-canvas').boundingBox();
  if (!canvasRectangle) throw new Error('FrogLabel spectrogram canvas disappeared');
  const overlapPoint = {
    x: canvasRectangle.x + canvasRectangle.width * 0.39,
    y: canvasRectangle.y + canvasRectangle.height * 0.45,
  };
  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  const selectedOverlap = frame.locator('.annotation-box.selected');
  await selectedOverlap.waitFor({ state: 'visible' });
  if ((await selectedOverlap.getAttribute('data-overlap-count')) !== '2') {
    throw new Error('Overlap hit did not expose the deterministic two-box selection stack');
  }
  const selectedBeforeCycle = await selectedOverlap.getAttribute('data-box-id');
  await frame.locator('body').press('BracketRight');
  const selectedAfterCycle = await selectedOverlap.getAttribute('data-box-id');
  if (!selectedBeforeCycle || !selectedAfterCycle || selectedBeforeCycle === selectedAfterCycle) {
    throw new Error('BracketRight did not cycle to the next overlapping box');
  }
  recordAction('draw overlap and cycle selection', 'two boxes; selection changed without reorder');

  await frame.getByRole('button', { name: 'Undo' }).click();
  await waitForBoxCount(frame, 1);
  await waitForHostEcho(frame);
  await frame.getByRole('button', { name: 'Redo' }).click();
  await waitForBoxCount(frame, 2);
  await waitForHostEcho(frame);
  const selectedRow = frame.getByRole('row', { name: /TST — Test Tree Frog/ }).last();
  await selectedRow.click();
  await frame.getByRole('button', { name: 'Play selected box' }).click();
  recordAction('undo, redo, and selection playback', 'two boxes restored; semantic state valid');

  const resizeHandle = frame.getByRole('button', { name: 'Resize TST box from SE corner' });
  const resizeRectangle = await resizeHandle.boundingBox();
  if (!resizeRectangle) throw new Error('Selected box SE resize handle has no bounding box');
  const submit = nativeSubmitButton(page);
  await submit.waitFor({ state: 'visible', timeout: 30_000 });
  const resultRequest = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/tasks\/\d+\/annotations\/?$/.test(new URL(response.url()).pathname),
    { timeout: 30_000 },
  );
  await page.mouse.move(
    resizeRectangle.x + resizeRectangle.width / 2,
    resizeRectangle.y + resizeRectangle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resizeRectangle.x + resizeRectangle.width / 2 + 26,
    resizeRectangle.y + resizeRectangle.height / 2 + 18,
    { steps: 4 },
  );
  await page.mouse.up();
  await submit.click();
  const submittedResponse = await resultRequest;
  if (!submittedResponse.ok()) {
    throw new Error(`Native first Submit returned HTTP ${submittedResponse.status()}`);
  }

  const submittedTask = await waitForTask(
    context,
    firstTaskId,
    (task) => completedDocuments(task).some((document) => document.boxes?.length === 2),
    'two-box first Submit',
  );
  const submittedDocuments = completedDocuments(submittedTask);
  if (submittedDocuments.length !== 1) {
    throw new Error(`First Submit persisted ${submittedDocuments.length} FrogLabel documents`);
  }
  const submittedDocument = submittedDocuments[0];
  if (
    submittedDocument.boxes.some(
      (box) =>
        box.species.code !== 'TST' ||
        box.species.speciesName !== 'Test Tree Frog' ||
        box.species.addedAfterInitialization !== true,
    )
  ) {
    throw new Error('Ordinary-user annotation did not snapshot the added TST species identity');
  }
  const addedSpeciesId = submittedDocument.boxes[0].species.speciesId;
  const submittedAnnotation = annotationResults(submittedTask).find(
    ({ results }) => results.length === 1,
  );
  const stableResultId = submittedAnnotation.results[0].id;
  await writeFile(
    path.join(output, 'ce-annotated-after-submit.json'),
    `${JSON.stringify(submittedTask, null, 2)}\n`,
  );
  await assertClean('native first Submit');
  recordAction('resize pointer-up then native Submit', 'two-box singleton committed immediately');

  frame = await openTask(page, firstTaskId);
  await waitForBoxCount(frame, 2);
  await page.screenshot({ path: path.join(output, 'ce-annotated-reloaded.png'), fullPage: true });
  await frame
    .getByRole('row', { name: /TST — Test Tree Frog/ })
    .first()
    .click();
  const firstBox = submittedDocument.boxes[0];
  const updatedEnd = Number((firstBox.endTimeSeconds + 0.000123456789).toPrecision(15));
  await frame.getByLabel('End (s)').fill(String(updatedEnd));
  await frame.getByRole('button', { name: 'Update geometry' }).click();
  await waitForHostEcho(frame);
  const updateButton = nativeSubmitButton(page);
  const updateResponsePromise = page.waitForResponse(
    (response) =>
      ['PATCH', 'PUT'].includes(response.request().method()) &&
      /\/api\/annotations\/\d+\/?$/.test(new URL(response.url()).pathname),
    { timeout: 30_000 },
  );
  await updateButton.click();
  const updateResponse = await updateResponsePromise;
  if (!updateResponse.ok())
    throw new Error(`Native Update returned HTTP ${updateResponse.status()}`);
  const updatedTask = await waitForTask(
    context,
    firstTaskId,
    (task) => completedDocuments(task)[0]?.boxes?.some((box) => box.endTimeSeconds === updatedEnd),
    'full-precision geometry Update',
  );
  const updatedResult = annotationResults(updatedTask).find(({ results }) => results.length === 1)
    .results[0];
  if (updatedResult.id !== stableResultId) {
    throw new Error(
      `Outer FrogLabel result ID changed from ${stableResultId} to ${updatedResult.id}`,
    );
  }
  const updatedDocument = updatedResult.value.reactcode;
  if (
    updatedDocument.boxes.some(
      (box) => box.species.speciesId !== addedSpeciesId || box.species.code !== 'TST',
    )
  ) {
    throw new Error('Reload/Update changed the immutable added-species identity snapshot');
  }
  await writeFile(
    path.join(output, 'ce-reloaded.json'),
    `${JSON.stringify(updatedTask, null, 2)}\n`,
  );
  await assertClean('native Update');
  recordAction('reload, full-precision edit, native Update', 'stable outer result identity');

  frame = await openTask(page, firstTaskId);
  await waitForBoxCount(frame, 2);
  const tutorialHostBefore = await apiJson(context, `/api/tasks/${firstTaskId}`);
  const tutorialCatalogBefore = await apiJson(context, '/froglabel/api/projects/1/catalog/');
  const tutorialGeometry = await completeCeTutorial(page, frame, 2);
  const tutorialHostAfter = await apiJson(context, `/api/tasks/${firstTaskId}`);
  const tutorialCatalogAfter = await apiJson(context, '/froglabel/api/projects/1/catalog/');
  if (
    JSON.stringify(annotationResults(tutorialHostBefore)) !==
    JSON.stringify(annotationResults(tutorialHostAfter))
  ) {
    throw new Error('Tutorial mutated the host-authoritative ReactCode result');
  }
  if (JSON.stringify(tutorialCatalogBefore) !== JSON.stringify(tutorialCatalogAfter)) {
    throw new Error('Tutorial isolated-memory Add species mutated the live project catalog');
  }
  await writeFile(
    path.join(output, 'ce-tutorial-trace.json'),
    `${JSON.stringify(
      {
        geometry: tutorialGeometry,
        hostMutation: false,
        liveCatalogMutation: false,
        restartVerified: true,
        escapeVerified: true,
      },
      null,
      2,
    )}\n`,
  );
  await page.screenshot({ path: path.join(output, 'ce-tutorial-complete.png'), fullPage: true });

  await startTutorial(frame);
  frame = await openTask(page, noCallsTaskId);
  await frame.getByRole('option', { name: 'TST Test Tree Frog' }).waitFor({
    state: 'attached',
    timeout: 30_000,
  });
  frame = await openTask(page, firstTaskId);
  await waitForBoxCount(frame, 2);
  const tutorialTaskSwitchAfter = await apiJson(context, `/api/tasks/${firstTaskId}`);
  if (
    JSON.stringify(annotationResults(tutorialHostAfter)) !==
    JSON.stringify(annotationResults(tutorialTaskSwitchAfter))
  ) {
    throw new Error('Switching tasks during the tutorial mutated the authoritative annotation');
  }
  await writeFile(
    path.join(output, 'ce-tutorial-task-switch.json'),
    `${JSON.stringify({ hostMutation: false, restoredBoxCount: 2 }, null, 2)}\n`,
  );
  await assertClean('full CE tutorial, Escape, and task-switch restoration');
  recordAction(
    'complete all tutorial steps plus Back, Restart, Escape, missing-anchor recovery, task switch',
    'practice state discarded; host result and project catalog unchanged',
  );

  const compareAll = page.getByRole('button', { name: 'Compare all annotations' });
  await compareAll.waitFor({ state: 'visible', timeout: 30_000 });
  await compareAll.click();
  await page.getByRole('heading', { name: 'Task Summary' }).waitFor({ timeout: 30_000 });
  const taskSummaryText = await page
    .getByRole('heading', { name: 'Task Summary' })
    .locator('..')
    .innerText();
  await writeFile(path.join(output, 'task-summary.txt'), `${taskSummaryText}\n`);
  await page.screenshot({
    path: path.join(output, 'ce-task-summary-view-all.png'),
    fullPage: true,
  });
  await compareAll.click();
  await assertClean('Task Summary/View All');
  recordAction('open Task Summary/View All', 'derived current summary rendered without crash');

  frame = await openTask(page, noCallsTaskId);
  await frame.getByRole('option', { name: 'TST Test Tree Frog' }).waitFor({
    state: 'attached',
    timeout: 30_000,
  });
  const secondTaskCatalog = await apiJson(context, '/froglabel/api/projects/1/catalog/');
  if (
    !JSON.stringify(secondTaskCatalog).includes(addedSpeciesId) ||
    !JSON.stringify(secondTaskCatalog).includes('Test Tree Frog')
  ) {
    throw new Error('Second project task did not observe the immutable added species');
  }
  await writeFile(
    path.join(output, 'project-catalog-second-task.json'),
    `${JSON.stringify(secondTaskCatalog, null, 2)}\n`,
  );
  await frame.getByRole('button', { name: 'No calls present (Shift+N)' }).click();
  await waitForHostEcho(frame);
  await nativeSubmitButton(page).click();
  const noCallsTask = await waitForTask(
    context,
    noCallsTaskId,
    (task) => completedDocuments(task)[0]?.reviewStatus === 'no_calls',
    'explicit reviewed-negative Submit',
  );
  const noCallsDocument = completedDocuments(noCallsTask)[0];
  if (noCallsDocument.boxes.length !== 0) throw new Error('No-calls document persisted boxes');
  await writeFile(
    path.join(output, 'ce-no-calls.json'),
    `${JSON.stringify(noCallsTask, null, 2)}\n`,
  );
  frame = await openTask(page, noCallsTaskId);
  await frame
    .getByRole('button', { name: 'No calls present (Shift+N)' })
    .waitFor({ state: 'visible', timeout: 30_000 });
  if (
    (await frame
      .getByRole('button', { name: 'No calls present (Shift+N)' })
      .getAttribute('aria-pressed')) !== 'true'
  ) {
    throw new Error('Explicit no-calls state did not survive reload');
  }
  await page.screenshot({ path: path.join(output, 'ce-no-calls-reloaded.png'), fullPage: true });
  await assertClean('explicit No calls Submit/reload');
  recordAction('submit and reload explicit No calls', 'zero-box singleton remains distinct');

  frame = await openTask(page, blankTaskId);
  const blankSubmit = nativeSubmitButton(page);
  await blankSubmit.waitFor({ state: 'visible', timeout: 30_000 });
  const blankWasDisabled = await blankSubmit.isDisabled();
  if (!blankWasDisabled) {
    await blankSubmit.click();
    await page.waitForTimeout(750);
  }
  const blankTask = await apiJson(context, `/api/tasks/${blankTaskId}`);
  assertSingletonPerAnnotation(blankTask);
  if (completedDocuments(blankTask).length !== 0 || (blankTask.annotations ?? []).length !== 0) {
    throw new Error('Blank task was accepted despite enable_empty_annotation=false');
  }
  recordAction('attempt blank submission', 'blank task remained unreviewed with no annotation');
  await writeFile(
    path.join(output, 'blank-submit-result.json'),
    `${JSON.stringify({ blankWasDisabled, task: blankTask }, null, 2)}\n`,
  );

  const nativeExport = await downloadNativeExport(page);
  const exportedCallsTask = exportedTask(nativeExport.value, firstTaskId);
  const exportedNoCallsTask = exportedTask(nativeExport.value, noCallsTaskId);
  const exportedCalls = completedDocuments(exportedCallsTask);
  const exportedNoCalls = completedDocuments(exportedNoCallsTask);
  if (JSON.stringify(exportedCalls) !== JSON.stringify([updatedDocument])) {
    throw new Error(
      'Native export calls-present document differs from the reloaded canonical value',
    );
  }
  if (JSON.stringify(exportedNoCalls) !== JSON.stringify([noCallsDocument])) {
    throw new Error('Native export no-calls document differs from the reloaded canonical value');
  }
  if (
    exportedCalls[0].boxes.some(
      (box) => box.species.speciesId !== addedSpeciesId || box.species.code !== 'TST',
    )
  ) {
    throw new Error('Native export changed the immutable added-species identity snapshot');
  }
  await writeFile(
    path.join(output, 'label-studio-ce-export-parse.json'),
    `${JSON.stringify(
      {
        // CE's default native export excludes a task with no annotation.  That
        // is the expected blank/unreviewed representation, not a missing result.
        blankTaskDocuments: 0,
        blankTaskPresent: (Array.isArray(nativeExport.value)
          ? nativeExport.value
          : nativeExport.value.tasks
        ).some((candidate) => Number(candidate.id) === blankTaskId),
        callsPresent: exportedCalls,
        noCalls: exportedNoCalls,
        roundTripExact: true,
      },
      null,
      2,
    )}\n`,
  );
  await assertClean('complete native Submit/reload/View All/export flow');
  recordAction('native export and canonical comparison', 'calls/no-calls exact round-trip');

  const stockTask = await runStockProjectCanary(page, context);
  await assertClean('stock non-FrogLabel project canary');
  recordAction(
    'submit a stock Label Studio Choices task',
    'generic editor path remains functional',
  );

  const unprivileged = await verifyOutsiderPermissionError(browser);
  recordAction(
    'verify an authenticated non-member project denial',
    `catalog returned HTTP ${unprivileged.catalogStatus} with a nonblank actionable error`,
  );

  const inspection = path.join(repoRoot, 'scripts', 'inspect_ce_database.py');
  const databaseInspection = await run(python, pythonScriptArguments(inspection));
  await writeFile(path.join(output, 'database-inspection.json'), databaseInspection.stdout);

  const summary = {
    browser: await browser.version(),
    dataDir,
    exactCeCommit: '2a9bfbcbf0a844b999de97e601d16050a893f5fb',
    exactCeVersion: '1.23.0',
    embeddedFrame: embeddedFrameRectangle,
    blankSubmissionRejected: true,
    importedTasks: tasks.map((task) => ({ id: task.id, froglabel: task.data.froglabel })),
    nativeExport: path.basename(nativeExport.destination),
    noCallsDocument,
    ordinaryMember: {
      email,
      isStaff: fixture.isStaff,
      isSuperuser: fixture.isSuperuser,
    },
    origin,
    project: 1,
    stableResultId,
    stockCanaryAnnotationCount: stockTask.annotations?.length ?? 0,
    submittedDocument,
    tutorial: {
      completedSteps: 12,
      hostMutation: false,
      projectCatalogMutation: false,
    },
    unprivilegedCatalogStatus: unprivileged.catalogStatus,
    updatedDocument,
  };
  await writeFile(path.join(output, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    path.join(output, 'seeded-explorer.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        seed: explorerSeed,
        target: 'label-studio-ce-1.23.0-normal-http',
        actions: explorerActions,
        browserProblems: fatalBrowserEvents,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  await browser?.close();
  if (denyProxy) {
    denyProxy.closeAllConnections();
    await new Promise((resolve) => denyProxy.close(resolve));
  }
  if (serverBuffers) {
    await writeFile(
      serverLogPath,
      `${Buffer.concat(serverBuffers.stdout).toString('utf8')}${Buffer.concat(serverBuffers.stderr).toString('utf8')}`,
    );
  }
  await writeFile(browserLogPath, `${browserEvents.join('\n')}${browserEvents.length ? '\n' : ''}`);
  await writeFile(networkLogPath, `${JSON.stringify(networkEvents, null, 2)}\n`);
  await writeFile(commandLogPath, `${JSON.stringify(commands, null, 2)}\n`);
  try {
    await copyFile(
      path.join(dataDir, 'label_studio.sqlite3'),
      path.join(output, 'label_studio.sqlite3'),
    );
  } catch {
    // Provisioning failures can occur before the database exists.
  }
  if (process.env.FROGLABEL_CE_KEEP_RUNTIME !== '1')
    await rm(runtime, { recursive: true, force: true });
}

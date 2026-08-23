import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { chromium } from '@playwright/test';

import { agentChromiumExecutable } from './agent-chromium.mjs';

const repository = path.resolve(import.meta.dirname, '..');
for (const name of ['FROGLABEL_CE_SOURCE', 'FROGLABEL_CE_VENV']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const source = path.resolve(process.env.FROGLABEL_CE_SOURCE);
const venv = path.resolve(process.env.FROGLABEL_CE_VENV);
const python = path.join(venv, 'bin', 'python');
const froglabel = path.join(venv, 'bin', 'froglabel');
const manage = path.join(source, 'label_studio', 'manage.py');
const browserOrigin = 'http://localhost:8080';
const projectId = 1;
const taskId = 1;
const email = 'agent@example.test';
const password = 'froglabel-local-only';
const output = path.resolve(
  process.env.FROGLABEL_CE_EVIDENCE ?? 'test-results/playwright-label-studio-ce-wsgi/run-1',
);
const runtime = await mkdtemp(path.join(os.tmpdir(), 'froglabel-ce-wsgi-'));
const dataDir = path.join(runtime, 'data');
const commands = [];
const browserEvents = [];
const fatalEvents = [];
const pendingRequests = new Set();
const explorerSeed = Number(process.env.FROGLABEL_EXPLORER_SEED ?? '24082026');
const explorerActions = [];
const recordAction = (action, invariant) =>
  explorerActions.push({ index: explorerActions.length, action, invariant });
let bridge;
let browser;

await mkdir(dataDir, { recursive: true });
await mkdir(output, { recursive: true });

const djangoEnvironment = {
  ...process.env,
  COLLECT_ANALYTICS: '0',
  DJANGO_SETTINGS_MODULE: 'froglabel_cli.ce_overlay.settings',
  FRONTEND_SENTRY_DSN: '',
  FROGLABEL_CE_DATA: dataDir,
  FROGLABEL_CE_SOURCE: source,
  FROGLABEL_CE_USERNAME: email,
  FROGLABEL_SERVE_STATIC: '1',
  LABEL_STUDIO_BASE_DATA_DIR: dataDir,
  LATEST_VERSION_CHECK: '0',
  PYTHONPATH: [path.join(repository, 'python'), source, path.join(source, 'label_studio')].join(
    path.delimiter,
  ),
  SENTRY_DSN: '',
};

function run(command, args, timeoutMilliseconds = 300_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      env: djangoEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMilliseconds);
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

class DjangoBridge {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = [];
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(python, [path.join(repository, 'scripts', 'ce_wsgi_bridge.py')], {
      cwd: repository,
      env: djangoEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.stderr.on('data', (chunk) => this.diagnostics.push(chunk.toString()));
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) => {
      if (code !== 0 && code !== null) this.fail(new Error(`Django bridge exited with ${code}`));
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.diagnostics.push(`${line}\n`);
      return;
    }
    if (message.ready) {
      this.resolveReady();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else {
      pending.resolve({
        status: message.status,
        headers: message.headers,
        body: Buffer.from(message.body, 'base64'),
      });
    }
  }

  fail(error) {
    const enriched = new Error(`${error.message}\n${this.diagnostics.join('')}`);
    this.rejectReady(enriched);
    for (const pending of this.pending.values()) pending.reject(enriched);
    this.pending.clear();
  }

  async request(pathname, { method = 'GET', headers = {}, body } = {}) {
    await this.ready;
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(
      `${JSON.stringify({
        id,
        method,
        path: pathname,
        headers,
        body: body ? Buffer.from(body).toString('base64') : '',
      })}\n`,
    );
    return response;
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

async function proxyToCe(route) {
  const request = route.request();
  const requested = new URL(request.url());
  if (requested.origin !== browserOrigin) {
    const event = `external-request:${request.method()} ${requested.href}`;
    fatalEvents.push(event);
    await route.abort('blockedbyclient');
    return;
  }
  const headers = { ...request.headers(), 'accept-encoding': 'identity' };
  delete headers.host;
  delete headers['content-length'];
  const response = await bridge.request(`${requested.pathname}${requested.search}`, {
    method: request.method(),
    headers,
    body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer(),
  });
  const responseHeaders = {};
  for (const [name, value] of response.headers) {
    responseHeaders[name] = responseHeaders[name] ? `${responseHeaders[name]}\n${value}` : value;
  }
  delete responseHeaders['content-encoding'];
  delete responseHeaders['content-length'];
  delete responseHeaders['transfer-encoding'];
  if (responseHeaders.location) {
    responseHeaders.location = responseHeaders.location.replace('http://testserver', browserOrigin);
  }
  if (response.status >= 400) {
    fatalEvents.push(`http:${response.status} ${request.method()} ${requested.href}`);
  }
  await route.fulfill({ status: response.status, headers: responseHeaders, body: response.body });
}

async function persistedTask() {
  const response = await bridge.request(`/api/tasks/${taskId}`);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Task verification returned HTTP ${response.status}`);
  }
  return JSON.parse(response.body.toString('utf8'));
}

function completedReactCode(task) {
  const completed = (task.annotations ?? []).filter((annotation) => !annotation.was_cancelled);
  for (const annotation of completed) {
    const values = (annotation.result ?? []).filter((entry) => entry.type === 'reactcode');
    if (values.length > 1) {
      throw new Error(`Annotation ${annotation.id} contains ${values.length} ReactCode results`);
    }
  }
  const withDocument = completed
    .map((annotation) => ({
      annotation,
      results: (annotation.result ?? []).filter((entry) => entry.type === 'reactcode'),
    }))
    .filter((entry) => entry.results.length === 1);
  if (withDocument.length !== 1) {
    throw new Error(
      `Expected one completed annotation with a singleton; received ${withDocument.length}`,
    );
  }
  return withDocument[0];
}

async function waitForBoxCount(expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await persistedTask();
    try {
      const completed = completedReactCode(task);
      if (completed.results[0].value?.reactcode?.boxes?.length === expected)
        return { task, completed };
    } catch {
      // The first submit may still be committing.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CE WSGI persistence did not reach ${expected} box(es)`);
}

async function drawBox(page, frame, startFraction) {
  await waitForFirstSpectrogramFrame(frame.locator('.spectrogram-shell'));
  await ensurePanelOpen(frame, '1 Species');
  await frame.getByRole('option', { name: 'GRE Green Tree Frog' }).click();
  await frame.getByRole('button', { name: '1 Species' }).click();
  await ensureDrawTool(frame, true);
  const canvas = frame.locator('canvas.spectrogram-canvas');
  const rectangle = await canvas.boundingBox();
  if (!rectangle) throw new Error('FrogLabel spectrogram canvas has no bounding box');
  await page.mouse.move(
    rectangle.x + rectangle.width * startFraction,
    rectangle.y + rectangle.height * 0.25,
  );
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width * (startFraction + 0.13),
    rectangle.y + rectangle.height * 0.53,
    { steps: 6 },
  );
  await page.mouse.up();
  await ensurePanelOpen(frame, '4 Dataset');
}

async function ensurePanelOpen(frame, name) {
  const button = frame.getByRole('button', { name });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}

async function ensureDrawTool(frame, draw) {
  const button = frame.getByRole('button', { name: 'Toggle Select and Draw tools (T)' });
  if ((await button.getAttribute('aria-pressed')) !== String(draw)) await button.click();
}

async function waitForFirstSpectrogramFrame(shell) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await shell.getAttribute('data-spectrogram-state')) === 'firstFrameReady') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Spectrogram did not paint its first current frame');
}

async function waitForNetworkSettled(timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let idleSince = null;
  while (Date.now() < deadline) {
    if (pendingRequests.size === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 500) return;
    } else {
      idleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`WSGI browser network did not settle (${pendingRequests.size} pending)`);
}

function assertClean(stage) {
  if (fatalEvents.length) {
    throw new Error(
      `${stage} emitted forbidden browser/network events:\n${fatalEvents.join('\n')}`,
    );
  }
}

function nativeSubmit(page, label) {
  return page
    .locator('button')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'u') })
    .last();
}

try {
  await run(python, [manage, 'migrate', '--noinput', '--verbosity', '0']);
  await run(python, [manage, 'collectstatic', '--noinput', '--verbosity', '0']);
  await run(python, [
    path.join(repository, 'scripts', 'provision_ce_fixture.py'),
    '--email',
    email,
    '--password',
    password,
    '--title',
    'FrogLabel restricted WSGI evidence',
    '--task-audio-url',
    '/react-app/froglabel/audio/synthetic-frog-practice.wav',
    '--task-count',
    '2',
  ]);
  await run(froglabel, [
    'project',
    'init',
    '--target',
    'ce',
    '--project',
    '1',
    '--source',
    source,
    '--data-dir',
    dataDir,
    '--config-dir',
    path.join(repository, 'examples', 'configs'),
    '--config-name',
    'demo-seeded',
  ]);
  recordAction('provision restricted CE fixture', 'fresh migrations/user/project/task/catalog');

  bridge = new DjangoBridge();
  await bridge.ready;
  const executablePath = await agentChromiumExecutable();
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'));
  const page = await context.newPage();
  context.on('request', (request) => pendingRequests.add(request));
  context.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('console', (message) => {
    const entry = `console:${message.type()} ${message.text()}`;
    browserEvents.push(entry);
    if (
      ['warning', 'error'].includes(message.type()) &&
      !isBenignSoftwareWebGlWarning(message.type(), message.text())
    )
      fatalEvents.push(entry);
  });
  page.on('pageerror', (error) => {
    const entry = `pageerror:${error.stack ?? error.message}`;
    browserEvents.push(entry);
    fatalEvents.push(entry);
  });
  page.on('requestfailed', (request) => {
    pendingRequests.delete(request);
    const entry = `requestfailed:${request.failure()?.errorText ?? 'unknown'} ${request.url()}`;
    browserEvents.push(entry);
    fatalEvents.push(entry);
  });
  // This WSGI bridge owns HTTP(S) only; blob: workers stay browser-managed.
  await page.route(/^https?:\/\//u, proxyToCe);
  await page.goto(`${browserOrigin}/projects/${projectId}/data?task=${taskId}`, {
    waitUntil: 'domcontentloaded',
  });

  const frame = page.frameLocator('[data-testid="froglabel-reactcode-frame"]');
  await ensurePanelOpen(frame, '1 Species');
  await frame.getByRole('option', { name: 'GRE Green Tree Frog' }).waitFor({ timeout: 60_000 });
  await waitForNetworkSettled();
  assertClean('initial WSGI task load');
  await drawBox(page, frame, 0.12);
  await nativeSubmit(page, 'Submit').click();
  const first = await waitForBoxCount(1);
  await waitForNetworkSettled();
  assertClean('first WSGI Submit');
  const outerResultId = first.completed.results[0].id;
  await writeFile(
    path.join(output, 'task-after-submit.json'),
    `${JSON.stringify(first.task, null, 2)}\n`,
  );
  await page.screenshot({ path: path.join(output, 'ce-wsgi-first-submit.png'), fullPage: true });
  recordAction('draw then first native Submit', 'one singleton with one box persisted');

  await page.goto(`${browserOrigin}/projects/${projectId}/data?task=${taskId}`, {
    waitUntil: 'domcontentloaded',
  });
  await ensurePanelOpen(frame, '4 Dataset');
  await frame.getByRole('row', { name: /GRE — Green Tree Frog/ }).waitFor({ timeout: 60_000 });
  await drawBox(page, frame, 0.58);
  await nativeSubmit(page, 'Update').click();
  const second = await waitForBoxCount(2);
  await waitForNetworkSettled();
  assertClean('WSGI Update');
  if (second.completed.results[0].id !== outerResultId) {
    throw new Error('CE WSGI Update changed the stable outer result ID');
  }
  recordAction('reload, draw, native Update', 'two boxes and stable outer result identity');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensurePanelOpen(frame, '4 Dataset');
  await frame
    .getByRole('row', { name: /GRE — Green Tree Frog/ })
    .nth(1)
    .waitFor({
      timeout: 60_000,
    });
  await page.screenshot({ path: path.join(output, 'ce-wsgi-update-reloaded.png'), fullPage: true });
  await waitForNetworkSettled();
  assertClean('WSGI reload');

  await writeFile(
    path.join(output, 'task-after-update.json'),
    `${JSON.stringify(second.task, null, 2)}\n`,
  );
  await copyFile(
    path.join(dataDir, 'label_studio.sqlite3'),
    path.join(output, 'label_studio.sqlite3'),
  );
  const summary = {
    browser: await browser.version(),
    exactCeVersion: '1.23.0',
    fixture: 'fresh disposable migrations/user/organization/project/task',
    firstSubmitBoxes: 1,
    updateBoxes: 2,
    stableOuterResultId: outerResultId,
    transport: 'real Django WSGI/test client intercepted into Chromium; service worker disabled',
  };
  await writeFile(path.join(output, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    path.join(output, 'seeded-explorer.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        seed: explorerSeed,
        target: 'label-studio-ce-1.23.0-restricted-wsgi',
        actions: explorerActions,
        browserProblems: fatalEvents,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await writeFile(
    path.join(output, 'browser.log'),
    `${browserEvents.join('\n')}${browserEvents.length ? '\n' : ''}`,
  ).catch(() => undefined);
  await writeFile(
    path.join(output, 'commands.json'),
    `${JSON.stringify(commands, null, 2)}\n`,
  ).catch(() => undefined);
  if (bridge?.diagnostics?.length) {
    await writeFile(path.join(output, 'bridge.log'), bridge.diagnostics.join('')).catch(
      () => undefined,
    );
  }
  await browser?.close();
  bridge?.close();
  await rm(runtime, { recursive: true, force: true });
}

function isBenignSoftwareWebGlWarning(type, text) {
  return type === 'warning' && text.includes('GPU stall due to ReadPixels');
}

import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type ActionRecord = {
  action: string;
  assertion: string;
  at: number;
};

export async function runSeededStandaloneExplorer(
  page: Page,
  testInfo: TestInfo,
  options: { localUrl?: string } = {},
): Promise<void> {
  const seed = Number(process.env.FROGLABEL_EXPLORER_SEED ?? '24082026');
  const random = mulberry32(seed);
  const actions: ActionRecord[] = [];
  const browserProblems: string[] = [];
  const requests: string[] = [];
  const record = (action: string, assertion: string) =>
    actions.push({ action, assertion, at: actions.length });

  page.on('console', (message) => {
    if (
      ['warning', 'error'].includes(message.type()) &&
      !isBenignSoftwareWebGlWarning(message.type(), message.text())
    ) {
      browserProblems.push(`console:${message.type()} ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => browserProblems.push(`pageerror:${error.message}`));
  page.on('requestfailed', (request) =>
    browserProblems.push(
      `requestfailed:${request.failure()?.errorText ?? 'unknown'} ${request.url()}`,
    ),
  );
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(options.localUrl ?? './froglabel-local/');
  record('open local-file route', 'explicit local mode rendered');
  const audioInput = page.locator('input[type="file"][accept*="audio/wav"]');
  await audioInput.setInputFiles(
    path.resolve(import.meta.dirname, '../public/audio/synthetic-frog-practice.wav'),
  );
  await expect(page.getByText(/source-faithful PCM/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
  record('open synthetic WAV through File API', 'source-faithful WAV decoded');

  await page.getByRole('button', { name: '1 Species' }).click();
  await page.getByRole('button', { name: /Add missing species/ }).click();
  await page.getByLabel('Left-hand code (1–6 letters)').fill('EXF');
  await page.getByLabel('Full Species Name').fill('Explorer Tree Frog');
  await page.getByRole('button', { name: 'Save species' }).click();
  await expect(page.getByRole('option', { name: 'EXF Explorer Tree Frog' })).toBeVisible();
  record('add/select project-session species', 'full name and left-hand code accepted');
  await page.getByRole('button', { name: '1 Species' }).click();

  const tool = page.getByRole('button', { name: 'Toggle Select and Draw tools (T)' });
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const canvas = page.locator('canvas.spectrogram-canvas');
  const rectangle = await canvas.boundingBox();
  if (!rectangle) throw new Error('Seeded explorer spectrogram has no bounding box');
  const offset = 0.01 * Math.floor(random() * 4);
  for (const shift of [0, 0.035]) {
    await page.mouse.move(
      rectangle.x + rectangle.width * (0.2 + offset + shift),
      rectangle.y + rectangle.height * (0.25 + shift),
    );
    await page.mouse.down();
    await page.mouse.move(
      rectangle.x + rectangle.width * (0.55 + offset + shift),
      rectangle.y + rectangle.height * (0.7 + shift),
      { steps: 7 },
    );
    await page.mouse.up();
  }
  await page.getByRole('button', { name: '4 Dataset' }).click();
  await expect(page.getByRole('row', { name: /EXF — Explorer Tree Frog/ })).toHaveCount(2);
  record('draw two overlapping boxes', 'two bounded canonical boxes visible');

  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.click(
    rectangle.x + rectangle.width * (0.4 + offset),
    rectangle.y + rectangle.height * 0.48,
  );
  await page.keyboard.press('KeyC');
  await page.getByRole('button', { name: '2 Details' }).click();
  await page.getByRole('button', { name: /Replay box raw/i }).click();
  record('select overlap, cycle forward, replay selection', 'selection-only actions completed');

  const beforeView = await downloadJson(page);
  const palettes = ['Magma', 'Inferno', 'Plasma', 'Gray'];
  const palette = palettes[Math.floor(random() * palettes.length)];
  await page.getByRole('button', { name: 'Zoom in spectrogram' }).click();
  await page.getByRole('button', { name: 'Zoom out spectrogram' }).click();
  await page.getByRole('button', { name: '3 Display' }).click();
  await page.getByRole('radio', { name: `${palette} palette`, exact: true }).click();
  await page.getByRole('button', { name: 'Toggle light and dark theme' }).click();
  const afterView = await downloadJson(page);
  expect(afterView.document).toEqual(beforeView.document);
  record('seeded zoom/palette/theme sequence', 'canonical document byte-shape unchanged');

  await page.getByRole('button', { name: 'Help and tutorial' }).click();
  await page.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Tutorial step/ })).toHaveCount(0);
  const afterTutorial = await downloadJson(page);
  expect(afterTutorial.document).toEqual(beforeView.document);
  record('tutorial Space then Escape', 'isolated practice left live document unchanged');

  page.once('dialog', (dialog) => dialog.accept());
  const noCalls = page.getByRole('button', { name: /No calls present/ }).first();
  await noCalls.click();
  await expect(noCalls).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(page.getByRole('row', { name: /EXF — Explorer Tree Frog/ })).toHaveCount(2);
  record('No calls then one semantic Undo', 'prior boxes and calls-present state restored');

  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csvPath = await (await csvDownload).path();
  if (!csvPath) throw new Error('Seeded explorer CSV download has no path');
  expect(await readFile(csvPath, 'utf8')).toContain('recordType');
  record('download flat CSV', 'box/review contract emitted');

  const unexpected = requests.filter((value) => {
    const url = new URL(value);
    return (
      !['127.0.0.1', 'localhost', 'froglabel.test'].includes(url.hostname) &&
      url.protocol !== 'blob:'
    );
  });
  expect(unexpected).toEqual([]);
  expect(browserProblems).toEqual([]);
  await testInfo.attach('seeded-explorer.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          seed,
          target: testInfo.project.name,
          actions,
          actionCount: actions.length,
          browserProblems,
          unexpectedRequests: unexpected,
          finalCanonicalDocument: afterTutorial.document,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('seeded-explorer-final.png'), fullPage: true });
}

function isBenignSoftwareWebGlWarning(type: string, text: string): boolean {
  return type === 'warning' && text.includes('GPU stall due to ReadPixels');
}

async function downloadJson(page: Page): Promise<Record<string, unknown>> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const downloadPath = await (await downloadPromise).path();
  if (!downloadPath) throw new Error('Seeded explorer JSON download has no path');
  return JSON.parse(await readFile(downloadPath, 'utf8')) as Record<string, unknown>;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4_294_967_296;
  };
}

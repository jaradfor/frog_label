import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runCompleteTutorialWorkflow } from '../e2e-support/tutorialWorkflow';

const root = path.resolve(import.meta.dirname, '..');

interface ExportGeometry {
  startTimeSeconds: number;
  endTimeSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
}

interface LocalExport {
  kind: string;
  document: { boxes: ExportGeometry[] };
}

test('opens the seeded root, locks early drawing, and preserves one UUID through resize', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await expect(page.getByText('Browser workflow demo')).toBeVisible();
  await expect(page.getByText('green_tree.mp3', { exact: true })).toBeVisible();
  await expect(page.getByText('GRE demo recording', { exact: true })).toBeVisible();
  for (const species of [
    'GRE Green Tree Frog',
    "PER Peron's Tree Frog",
    'RED Red-Eyed Tree Frog',
    'COR Corroboree Frog',
  ]) {
    await expect(page.getByRole('option', { name: species })).toBeAttached();
  }

  const shell = page.locator('.spectrogram-shell');
  await expect(shell).toHaveAttribute('data-spectrogram-state', 'analyzing');
  const draw = page.getByRole('button', { name: /Draw Box/ });
  await expect(draw).toBeDisabled();
  await page.keyboard.press('KeyD');
  const stage = page.locator('.spectrogram-stage');
  const early = await stage.boundingBox();
  expect(early).not.toBeNull();
  await page.mouse.move(early!.x + 80, early!.y + 80);
  await page.mouse.down();
  await page.mouse.move(early!.x + 180, early!.y + 180);
  await page.mouse.up();
  await expect(stage).toHaveAttribute('data-box-count', '0');

  await expect(shell).toHaveAttribute('data-spectrogram-state', 'firstFrameReady', {
    timeout: 15_000,
  });
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).click();
  await draw.click();
  const ready = await stage.boundingBox();
  expect(ready).not.toBeNull();
  await page.mouse.move(ready!.x + ready!.width * 0.35, ready!.y + ready!.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(ready!.x + ready!.width * 0.58, ready!.y + ready!.height * 0.72, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(stage).toHaveAttribute('data-box-count', '1');

  const selected = page.locator('.annotation-box.selected');
  const boxId = await selected.getAttribute('data-box-id');
  expect(boxId).toBeTruthy();
  await expect(selected.locator('.resize-handle')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select V' }).click();
  await page.keyboard.press('Escape');
  await expect(stage).toHaveAttribute('data-selected-box-id', '');
  await page.getByRole('button', { name: /Select GRE, Green Tree Frog box/ }).press('Enter');
  await expect(stage).toHaveAttribute('data-selected-box-id', boxId!);
  const beforeStyle = await selected.getAttribute('style');
  const handle = await selected.locator('.handle-se').boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 35, handle!.y + 22, { steps: 6 });
  await page.mouse.up();
  await expect(stage).toHaveAttribute('data-box-count', '1');
  await expect(page.locator(`[data-box-id="${boxId}"]`)).toHaveCount(1);
  expect(await page.locator(`[data-box-id="${boxId}"]`).getAttribute('style')).not.toBe(
    beforeStyle,
  );
  await page.screenshot({ path: testInfo.outputPath('seeded-ready-resized.png') });

  const ownAudio = page.getByRole('link', { name: 'Try your own audio' });
  await expect(ownAudio).toHaveAttribute('href', /\?mode=local$/u);
  await ownAudio.click();
  await expect(page.getByText('Private local workspace')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Private local workspace')).toBeVisible();
});

test('runs the complete private WAV/MP3, JSON/CSV, tutorial, and dirty-state flow', async ({
  page,
}, testInfo) => {
  const browserProblems: string[] = [];
  const network: string[] = [];
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) {
      browserProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => browserProblems.push(`pageerror: ${error.message}`));
  page.on('request', (request) => network.push(request.url()));
  page.on('requestfailed', (request) =>
    browserProblems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );

  await page.goto('./?mode=local');
  await expect(page).toHaveTitle('FrogLabel local demo');
  await expect(page.getByText('Private local workspace')).toBeVisible();
  await expect(page.getByText('No JSON prepared', { exact: true })).toBeVisible();

  const audioInput = page.locator('input[type="file"][accept*="audio/wav"]');
  await audioInput.setInputFiles(path.join(root, 'public/audio/synthetic-frog-practice.wav'));
  await expect(page.getByText(/source-faithful PCM/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );

  await page.getByRole('button', { name: /Add missing species/ }).click();
  await page.getByLabel('Three-letter code').fill('GTF');
  await page.getByLabel('Full Species Name').fill('Green Tree Frog');
  await page.getByRole('button', { name: 'Save species' }).click();
  await expect(page.getByRole('option', { name: 'GTF Green Tree Frog' })).toBeVisible();

  const canvas = page.locator('canvas.spectrogram-canvas');
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + rect!.width * 0.13, rect!.y + rect!.height * 0.58);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.26, rect!.y + rect!.height * 0.88, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(page.getByRole('row', { name: /GTF — Green Tree Frog/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('static-green-tree-annotation.png') });

  await expect(page.getByLabel('Start (s)')).toHaveValue(/^\d+\.\d{3}$/u);
  await expect(page.getByLabel('Low (Hz)')).toHaveValue(/^\d+$/u);
  const precisionBaselinePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const precisionBaselinePath = await (await precisionBaselinePromise).path();
  expect(precisionBaselinePath).not.toBeNull();
  const precisionBaseline = JSON.parse(
    await readFile(precisionBaselinePath!, 'utf8'),
  ) as LocalExport;
  const originalGeometry = precisionBaseline.document.boxes[0];
  await page.getByLabel('Start (s)').fill('0.777');
  await page.getByRole('button', { name: 'Update geometry' }).click();

  const jsonPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const jsonDownload = await jsonPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(/\.froglabel\.json$/u);
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).not.toBeNull();
  const wrapper = JSON.parse(await readFile(jsonPath!, 'utf8')) as Record<string, unknown>;
  expect(wrapper.kind).toBe('froglabel.local-file');
  expect(wrapper).not.toHaveProperty('audioBytes');
  const updatedGeometry = (wrapper as unknown as LocalExport).document.boxes[0];
  expect(updatedGeometry.startTimeSeconds).toBe(0.777);
  expect(updatedGeometry.endTimeSeconds).toBe(originalGeometry.endTimeSeconds);
  expect(updatedGeometry.lowFrequencyHz).toBe(originalGeometry.lowFrequencyHz);
  expect(updatedGeometry.highFrequencyHz).toBe(originalGeometry.highFrequencyHz);
  await expect(page.getByText(/JSON download prepared at/)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: /No calls present/ })
    .first()
    .click();
  await expect(page.getByText('Reviewed: no calls present')).toBeVisible();
  await expect(page.getByText('Changes since JSON preparation', { exact: true })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles(jsonPath!);
  await expect(page.getByRole('row', { name: /GTF — Green Tree Frog/ })).toBeVisible();
  await expect(page.getByText('No JSON prepared', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Delete GTF box' }).click();
  await expect(page.getByText(/changes in memory/)).toBeVisible();

  const mp3 = Buffer.from(
    (await readFile(path.join(root, 'tests/fixtures/short-stereo.mp3.b64'), 'utf8')).trim(),
    'base64',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await audioInput.setInputFiles({ name: 'short-stereo.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
  await expect(page.getByText('short-stereo.mp3', { exact: true })).toBeVisible();
  const mp3Shell = page.locator('.spectrogram-shell');
  const mp3Stage = page.locator('.spectrogram-stage');
  await expect(mp3Shell).toHaveAttribute('data-spectrogram-state', 'analyzing');
  await expect(page.getByRole('button', { name: /Draw Box/ })).toBeDisabled();
  await page.keyboard.press('KeyD');
  const mp3Early = await mp3Stage.boundingBox();
  expect(mp3Early).not.toBeNull();
  await page.mouse.move(mp3Early!.x + 60, mp3Early!.y + 60);
  await page.mouse.down();
  await page.mouse.move(mp3Early!.x + 160, mp3Early!.y + 150);
  await page.mouse.up();
  await expect(mp3Stage).toHaveAttribute('data-box-count', '0');
  await expect(page.getByText(/browser-decoded range/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/native stereo playback/)).toBeVisible();
  await expect(mp3Shell).toHaveAttribute('data-spectrogram-state', 'firstFrameReady', {
    timeout: 15_000,
  });
  await page.getByRole('option', { name: 'GTF Green Tree Frog' }).click();
  await page.getByRole('button', { name: /Draw Box/ }).click();
  const mp3Ready = await mp3Stage.boundingBox();
  expect(mp3Ready).not.toBeNull();
  await page.mouse.move(mp3Ready!.x + mp3Ready!.width * 0.25, mp3Ready!.y + 60);
  await page.mouse.down();
  await page.mouse.move(mp3Ready!.x + mp3Ready!.width * 0.55, mp3Ready!.y + 160, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(mp3Stage).toHaveAttribute('data-box-count', '1');

  await page.getByRole('button', { name: 'Help and tutorial' }).click();
  await page.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await expect(page.getByRole('dialog', { name: /Tutorial step 1/ })).toBeVisible();
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.getByText(/Temporary synthetic practice audio/)).toBeVisible();
  await page.getByRole('button', { name: /Exit tutorial/ }).click();

  const csvPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/\.froglabel\.csv$/u);
  const csvPath = await csvDownload.path();
  expect(await readFile(csvPath!, 'utf8')).toContain('recordType');

  const unexpectedNetwork = network.filter((value) => {
    const url = new URL(value);
    return !['127.0.0.1', 'blob:'].includes(url.hostname) && url.protocol !== 'blob:';
  });
  expect(unexpectedNetwork).toEqual([]);
  expect(browserProblems).toEqual([]);
  await testInfo.attach('network.json', {
    body: Buffer.from(JSON.stringify(network, null, 2)),
    contentType: 'application/json',
  });
});

test('completes, restarts, recovers, and exits the full isolated tutorial', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
  await runCompleteTutorialWorkflow(page, page, testInfo, { expectedLiveBoxCount: 0 });
  await page.screenshot({ path: testInfo.outputPath('tutorial-live-restored.png') });
});

test('keeps essential controls reachable at standalone and CE iframe widths', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 1440, height: 900, label: 'wide' },
    { width: 1280, height: 720, label: 'standalone' },
    { width: 844, height: 720, label: 'ce-iframe' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('./');
    await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
      'data-spectrogram-state',
      'firstFrameReady',
      { timeout: 15_000 },
    );
    const documentWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(documentWidth.scroll).toBe(documentWidth.client);

    for (const control of [
      page.getByRole('button', { name: 'Help and tutorial' }),
      page.getByRole('button', { name: /Play Audio/ }),
      page.getByRole('button', { name: 'Select V' }),
      page.getByRole('button', { name: /Draw Box/ }),
      page.getByRole('button', { name: 'Pan P' }),
      page.getByRole('button', { name: /Zoom in/ }),
      page.getByRole('button', { name: /Undo/ }),
      page.getByRole('button', { name: /Redo/ }),
      page.getByRole('button', { name: /No calls present/ }).first(),
      page.getByRole('option', { name: "PER Peron's Tree Frog" }),
    ]) {
      await expect(control).toBeVisible();
      const rectangle = await control.boundingBox();
      expect(rectangle).not.toBeNull();
      expect(rectangle!.x).toBeGreaterThanOrEqual(0);
      expect(rectangle!.x + rectangle!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    }
    const dataset = page.locator('.dataset-panel');
    await dataset.scrollIntoViewIfNeeded();
    const datasetRectangle = await dataset.boundingBox();
    expect(datasetRectangle).not.toBeNull();
    expect(datasetRectangle!.y).toBeLessThan(viewport.height);
    if (viewport.label === 'ce-iframe') {
      await expect(page.getByRole('link', { name: 'Try your own audio' })).toBeVisible();
      await page.goto('./?mode=local');
      await expect(page.getByRole('link', { name: 'Seeded demo' })).toBeVisible();
      await expect(page.locator('.local-notice')).toContainText('Open a WAV or MP3');
      await expect(page.locator('.local-notice')).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`layout-${viewport.label}.png`) });
  }
});

test('serves the exact repository subpath and excludes Label Studio host code', async ({
  page,
}) => {
  const responses: Array<{ url: string; status: number }> = [];
  page.on('response', (response) =>
    responses.push({ url: response.url(), status: response.status() }),
  );
  await page.goto('./');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'FrogLabel' })).toBeVisible();
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
  expect(responses.filter((response) => response.status >= 400)).toEqual([]);
  expect(
    responses.some(
      ({ url, status }) =>
        status === 200 &&
        /\/frog_label\/assets\/green_tree-[^/]+\.mp3$/u.test(new URL(url).pathname),
    ),
  ).toBe(true);

  const html = await readFile(path.join(root, 'build/pages/index.html'), 'utf8');
  const referencedEntry = html.match(/\/frog_label\/(assets\/index-[^"']+\.js)/u)?.[1];
  expect(referencedEntry).toBeTruthy();
  const assets = await readdir(path.join(root, 'build/pages/assets'));
  const entries = assets.filter((file) => /^index-.*\.js$/u.test(file));
  expect(entries).toEqual([path.basename(referencedEntry!)]);
  for (const entry of entries) {
    const script = await readFile(path.join(root, 'build/pages/assets', entry), 'utf8');
    expect(script).not.toMatch(
      /ReactCodeSrcPort|froglabel_species_v1|LABEL_STUDIO_API_KEY|\/api\//u,
    );
  }
  expect(html).toContain('/frog_label/assets/');
  expect((await page.request.get('./froglabel-local/')).status()).toBe(404);
  expect((await page.request.get('./?mode=local')).status()).toBe(200);
});

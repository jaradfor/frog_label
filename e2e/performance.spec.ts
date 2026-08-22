import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { test } from './fixture';

const BOX_COUNT = 2_000;
const SAMPLE_COUNT = 100;
const MAXIMUM_P95_MILLISECONDS = 100;
const MAXIMUM_LONG_TASK_MILLISECONDS = 250;
const AUDIO_SHA256 = '87f07fbd056bccc8354e0dfb3c781ff35025fc468f9be8d562a1bf38cc377f17';
const AUDIO_BYTES = 705_644;
const TIMESTAMP = '2026-08-20T00:00:00.000Z';

interface BrowserLatency {
  selection: number[];
  drag: number[];
  pan: number[];
  phase?: 'selection' | 'drag' | 'pan' | null;
  started?: number;
}

// Trace DOM snapshots materially perturb a dense-canvas timing measurement.
// The ordinary workflows retain trace evidence; this benchmark emits its own
// metrics artifact and measures the production page without recorder overhead.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('keeps the 2,000-box workspace responsive and enforces the POC ceiling', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(globalThis, '__froglabelLongTasks', {
      configurable: true,
      value: durations,
    });
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // Chromium exposes this in the release browser. If it is unavailable,
        // the latency assertions below remain mandatory and the result records
        // an empty long-task list instead of synthesizing observations.
      }
    }
  });

  await page.goto('./froglabel-local/');
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

  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: 'two-thousand-boxes.froglabel.json',
    mimeType: 'application/json',
    buffer: Buffer.from(`${JSON.stringify(benchmarkLocalFile())}\n`),
  });
  const stage = page.locator('.spectrogram-stage');
  await expect(stage).toHaveAttribute('data-box-count', String(BOX_COUNT), { timeout: 30_000 });
  await expect(page.locator('.annotation-layer-canvas')).toBeVisible();
  // Resuming the benchmark document creates a new workspace session. Close
  // the optional table after that remount so the gate measures the primary
  // canvas workflow instead of 2,000 accessible table rows.
  const datasetButton = page.getByRole('button', { name: '4 Dataset' });
  if ((await datasetButton.getAttribute('aria-pressed')) === 'true') await datasetButton.click();
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );

  const stageRectangle = await stage.boundingBox();
  if (!stageRectangle) throw new Error('Benchmark spectrogram stage has no bounding box');
  const warmupPoint = {
    x: stageRectangle.x + (3.94 / 8) * stageRectangle.width,
    y: stageRectangle.y + ((22_050 - 11_000) / 22_050) * stageRectangle.height,
  };
  await page.mouse.click(warmupPoint.x, warmupPoint.y);
  await expect(page.locator('.annotation-box.selected')).toHaveCount(1, { timeout: 5_000 });
  const warmupHandle = await page.locator('.annotation-box.selected .handle-se').boundingBox();
  if (!warmupHandle) throw new Error('Benchmark warm-up resize handle has no bounding box');
  const warmupX = warmupHandle.x + warmupHandle.width / 2;
  const warmupY = warmupHandle.y + warmupHandle.height / 2;
  await page.mouse.move(warmupX, warmupY);
  for (const delta of [2, -2]) {
    await page.mouse.down();
    await page.mouse.move(warmupX + delta, warmupY + delta);
    await page.mouse.up();
  }
  await page.locator('button[aria-label="Zoom in spectrogram"]').click();
  await page.getByRole('button', { name: /^Pan P$/u }).click();
  await page.mouse.move(stageRectangle.x + stageRectangle.width / 2, warmupPoint.y);
  await page.mouse.down();
  await page.mouse.move(stageRectangle.x + stageRectangle.width / 2 + 3, warmupPoint.y);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Reset and fit spectrogram view' }).click();
  await page.getByRole('button', { name: /^Select V$/u }).click();
  await page.mouse.click(
    stageRectangle.x + stageRectangle.width / 2,
    stageRectangle.y + stageRectangle.height - 2,
  );
  // Resetting the viewport schedules the production spectrogram worker after
  // its 180 ms debounce. Let that final warm-up render and its canvas upload
  // settle before clearing the long-task buffer; the gate below is intended
  // to measure the 300 user interactions, not deferred setup work.
  await page.waitForTimeout(1_200);

  // Initial import/render is bounded separately. Interaction samples begin
  // after the workspace has painted the complete document and initialized
  // each interaction path once.
  await page.evaluate(() => {
    const values = (globalThis as typeof globalThis & { __froglabelLongTasks?: number[] })
      .__froglabelLongTasks;
    if (values) values.length = 0;
  });
  await installBrowserLatencyObserver(page);

  const selectionDriverMilliseconds: number[] = [];
  // One reserve click keeps the sample count exact when a point lands on the
  // selected box's resize handle and is correctly classified as a drag target.
  const selectionRectangles = Array.from({ length: SAMPLE_COUNT + 1 }, (_, sampleIndex) => {
    const gridIndex = sampleIndex % SAMPLE_COUNT;
    const timeCell = 5 + (gridIndex % 10) * 9;
    const frequencyCell = 1 + Math.floor(gridIndex / 10) * 2;
    const timeCenter = 0.04 + timeCell * 0.078;
    const frequencyCenter = 500 + frequencyCell * 1_050;
    return {
      x: stageRectangle.x + (timeCenter / 8) * stageRectangle.width,
      y: stageRectangle.y + ((22_050 - frequencyCenter) / 22_050) * stageRectangle.height,
    };
  });
  for (let index = 0; index < selectionRectangles.length; index += 1) {
    const point = selectionRectangles[index];
    const started = performance.now();
    await page.mouse.click(point.x, point.y);
    await nextPaint(page);
    selectionDriverMilliseconds.push(performance.now() - started);
  }

  const dragDriverMilliseconds: number[] = [];
  const selected = page.locator('.annotation-box.selected');
  await expect(selected).toHaveCount(1);
  const handleRectangle = await selected.locator('.handle-se').boundingBox();
  if (!handleRectangle) throw new Error('Benchmark resize handle has no bounding box');
  let handleX = handleRectangle.x + handleRectangle.width / 2;
  let handleY = handleRectangle.y + handleRectangle.height / 2;
  await page.mouse.move(handleX, handleY);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const delta = index % 2 === 0 ? 2 : -2;
    const started = performance.now();
    await page.mouse.down();
    await page.mouse.move(handleX + delta, handleY + delta);
    await page.mouse.up();
    await nextPaint(page);
    dragDriverMilliseconds.push(performance.now() - started);
    handleX += delta;
    handleY += delta;
  }

  const panDriverMilliseconds: number[] = [];
  await page.locator('button[aria-label="Zoom in spectrogram"]').click();
  await page.getByRole('button', { name: /^Pan P$/u }).click();
  const canvasRectangle = await page.locator('canvas.spectrogram-canvas').boundingBox();
  if (!canvasRectangle) throw new Error('Benchmark canvas has no bounding box');
  const centerX = canvasRectangle.x + canvasRectangle.width / 2;
  const centerY = canvasRectangle.y + canvasRectangle.height / 2;
  let panX = centerX;
  await page.mouse.move(panX, centerY);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const delta = index % 2 === 0 ? 3 : -3;
    const started = performance.now();
    await page.mouse.down();
    await page.mouse.move(panX + delta, centerY);
    await page.mouse.up();
    await nextPaint(page);
    panDriverMilliseconds.push(performance.now() - started);
    panX += delta;
  }

  const observed = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __froglabelLongTasks?: number[];
      __froglabelLatency?: BrowserLatency;
    };
    return {
      longTasks: runtime.__froglabelLongTasks ?? [],
      latency: runtime.__froglabelLatency ?? { selection: [], drag: [], pan: [] },
    };
  });
  expect(observed.latency.selection.length).toBeGreaterThanOrEqual(SAMPLE_COUNT);
  expect(observed.latency.drag).toHaveLength(SAMPLE_COUNT);
  expect(observed.latency.pan).toHaveLength(SAMPLE_COUNT);
  const result = {
    schemaVersion: 1,
    browser: await page.evaluate(() => navigator.userAgent),
    boxCount: BOX_COUNT,
    samplesPerInteraction: SAMPLE_COUNT,
    selection: summarize(observed.latency.selection.slice(-SAMPLE_COUNT)),
    drag: summarize(observed.latency.drag),
    pan: summarize(observed.latency.pan),
    automationRoundTrip: {
      selection: summarize(selectionDriverMilliseconds.slice(-SAMPLE_COUNT)),
      drag: summarize(dragDriverMilliseconds),
      pan: summarize(panDriverMilliseconds),
    },
    longTasks: {
      count: observed.longTasks.length,
      maximumMilliseconds: Math.max(0, ...observed.longTasks),
      durationsMilliseconds: observed.longTasks,
    },
    limits: {
      p95Milliseconds: MAXIMUM_P95_MILLISECONDS,
      individualLongTaskMilliseconds: MAXIMUM_LONG_TASK_MILLISECONDS,
      importedBoxes: 5_000,
    },
  };

  const evidenceDirectory = path.resolve('test-results/performance');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, 'workspace-2000-boxes.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await testInfo.attach('workspace-2000-boxes.json', {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: 'application/json',
  });

  expect(result.selection.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.drag.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.pan.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.longTasks.maximumMilliseconds).toBeLessThanOrEqual(MAXIMUM_LONG_TASK_MILLISECONDS);
});

function benchmarkLocalFile() {
  const species = {
    schemaVersion: 1,
    kind: 'froglabel.species',
    speciesId: 'local:benchmark-green-tree-frog',
    code: 'GRE',
    speciesName: 'Green Tree Frog',
    scientificName: 'Ranoidea caerulea',
    addedAfterInitialization: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const boxes = Array.from({ length: BOX_COUNT }, (_, index) => {
    const timeCell = index % 100;
    const frequencyCell = Math.floor(index / 100);
    const startTimeSeconds = 0.02 + timeCell * 0.078;
    const lowFrequencyHz = 150 + frequencyCell * 1_050;
    return {
      id: `box:benchmark-${index.toString().padStart(4, '0')}`,
      species: {
        speciesId: species.speciesId,
        code: species.code,
        speciesName: species.speciesName,
        scientificName: species.scientificName,
        addedAfterInitialization: false,
      },
      startTimeSeconds,
      endTimeSeconds: startTimeSeconds + 0.04,
      lowFrequencyHz,
      highFrequencyHz: lowFrequencyHz + 700,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      provenance: { source: 'human' },
    };
  });
  return {
    kind: 'froglabel.local-file',
    schemaVersion: 1,
    audio: {
      filename: 'synthetic-frog-practice.wav',
      sizeBytes: AUDIO_BYTES,
      mimeType: 'audio/wav',
      durationSeconds: 8,
      sampleRateHz: 44_100,
      channelCount: 1,
      fingerprint: {
        algorithm: 'sha256',
        value: AUDIO_SHA256,
        scope: 'file-bytes',
      },
    },
    catalogSnapshot: [species],
    document: {
      kind: 'froglabel.annotation-set',
      schemaVersion: 1,
      catalogId: 'local:benchmark',
      reviewStatus: 'calls_present',
      boxes,
    },
  };
}

async function installBrowserLatencyObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.spectrogram-stage');
    if (!stage) throw new Error('Latency observer cannot find the spectrogram stage');
    const latency: BrowserLatency = { selection: [], drag: [], pan: [], phase: null, started: 0 };
    Object.defineProperty(globalThis, '__froglabelLatency', {
      configurable: true,
      value: latency,
    });
    const finish = (phase: 'selection' | 'drag' | 'pan') => {
      if (latency.phase !== phase || !latency.started) return;
      latency[phase].push(performance.now() - latency.started);
      latency.phase = null;
      latency.started = 0;
    };
    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !stage.contains(target)) return;
        if (target?.closest('.resize-handle')) {
          latency.phase = 'drag';
          latency.started = 0;
        } else if (stage.classList.contains('tool-pan')) {
          latency.phase = 'pan';
          latency.started = 0;
        } else if (stage.classList.contains('tool-select')) {
          latency.phase = 'selection';
          latency.started = performance.now();
        }
      },
      true,
    );
    document.addEventListener(
      'pointerup',
      () => {
        if (latency.phase === 'selection') {
          requestAnimationFrame(() => finish('selection'));
          return;
        }
        if (latency.phase === 'drag' || latency.phase === 'pan') {
          latency.started = performance.now();
        }
      },
      true,
    );
    const observer = new MutationObserver((records) => {
      if (
        latency.phase === 'selection' &&
        records.some(
          (record) =>
            record.type === 'childList' ||
            (record.type === 'attributes' && record.attributeName === 'data-selected-box-id'),
        )
      ) {
        finish('selection');
      }
      if (
        latency.phase === 'drag' &&
        records.some(
          (record) =>
            record.type === 'attributes' &&
            record.attributeName === 'style' &&
            record.target instanceof Element &&
            record.target.classList.contains('annotation-box'),
        )
      ) {
        finish('drag');
      }
      if (
        latency.phase === 'pan' &&
        records.some(
          (record) =>
            record.type === 'attributes' &&
            record.attributeName === 'aria-label' &&
            record.target instanceof Element &&
            record.target.classList.contains('spectrogram-canvas'),
        )
      ) {
        finish('pan');
      }
    });
    observer.observe(stage, {
      attributes: true,
      attributeFilter: ['aria-label', 'class', 'data-selected-box-id', 'style'],
      childList: true,
      subtree: true,
    });
  });
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    minimumMilliseconds: sorted[0] ?? 0,
    medianMilliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    maximumMilliseconds: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { test } from './fixture';

const BOX_COUNT = 5_000;
const SAMPLE_COUNT = 100;
const EXACT_SAMPLE_COUNT = 30;
const MAXIMUM_P95_MILLISECONDS = 100;
const MAXIMUM_FIRST_PREVIEW_MILLISECONDS = 100;
const MAXIMUM_LONG_TASK_MILLISECONDS = 50;
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

test('keeps the 5,000-box workspace responsive and enforces the rendering ceilings', async ({
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
  await installFirstFrameObserver(page);
  const audioInput = page.locator('input[type="file"][accept*="audio/wav"]');
  await audioInput.setInputFiles(
    path.resolve(import.meta.dirname, '../public/audio/synthetic-frog-practice.wav'),
  );
  await expect(page.getByText('synthetic-frog-practice.wav', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
  const spectrogramShell = page.locator('.spectrogram-shell');
  await expect
    .poll(async () => renderGeneration(spectrogramShell), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const firstPreviewAfterDecodedMilliseconds = await page.evaluate(() => {
    const timing = (
      globalThis as typeof globalThis & {
        __froglabelFirstFrameTiming?: {
          decodedAt: number | null;
          paintedAt: number | null;
        };
      }
    ).__froglabelFirstFrameTiming;
    if (timing?.decodedAt === null || timing?.paintedAt === null || !timing) {
      throw new Error('First-frame timing did not observe decoded audio and a canvas paint');
    }
    return Math.max(0, timing.paintedAt - timing.decodedAt);
  });

  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: 'five-thousand-boxes.froglabel.json',
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
  await expect(spectrogramShell).toHaveAttribute('data-spectrogram-state', 'firstFrameReady', {
    timeout: 15_000,
  });

  const stageRectangle = await stage.boundingBox();
  if (!stageRectangle) throw new Error('Benchmark spectrogram stage has no bounding box');
  const warmupPoint = {
    x: stageRectangle.x + (4 / 8) * stageRectangle.width,
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
  let renderBefore = await renderGeneration(spectrogramShell);
  await page.locator('button[aria-label^="Zoom in spectrogram"]').click();
  await waitForRenderAfter(spectrogramShell, renderBefore);
  await page.mouse.move(stageRectangle.x + stageRectangle.width / 2, warmupPoint.y);
  renderBefore = await renderGeneration(spectrogramShell);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(stageRectangle.x + stageRectangle.width / 2 + 3, warmupPoint.y);
  await page.mouse.up({ button: 'middle' });
  await waitForRenderAfter(spectrogramShell, renderBefore);
  renderBefore = await renderGeneration(spectrogramShell);
  await page.getByRole('button', { name: 'Reset and fit spectrogram view' }).click();
  await waitForRenderAfter(spectrogramShell, renderBefore);
  await page.mouse.click(
    stageRectangle.x + stageRectangle.width / 2,
    stageRectangle.y + stageRectangle.height - 2,
  );
  // Do not begin the gate while a preview/refinement is pending. These DOM
  // attributes advance only after pixels have been written to the live canvas,
  // so this replaces the old fixed delay and ARIA-label proxy.
  await waitForExactRender(spectrogramShell);

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
    const timeCell = 5 + (gridIndex % 10) * 24;
    const frequencyCell = 1 + Math.floor(gridIndex / 10) * 2;
    const timeCenter = 0.01 + timeCell * (7.96 / 250) + 0.009;
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
  renderBefore = await renderGeneration(spectrogramShell);
  await page.locator('button[aria-label^="Zoom in spectrogram"]').click();
  await waitForRenderAfter(spectrogramShell, renderBefore);
  const canvasRectangle = await page.locator('canvas.spectrogram-canvas').boundingBox();
  if (!canvasRectangle) throw new Error('Benchmark canvas has no bounding box');
  const centerX = canvasRectangle.x + canvasRectangle.width / 2;
  const centerY = canvasRectangle.y + canvasRectangle.height / 2;
  let panX = centerX;
  await page.mouse.move(panX, centerY);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const delta = index % 2 === 0 ? 3 : -3;
    const started = performance.now();
    const generation = await renderGeneration(spectrogramShell);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(panX + delta, centerY);
    await page.mouse.up({ button: 'middle' });
    await waitForRenderAfter(spectrogramShell, generation);
    panDriverMilliseconds.push(performance.now() - started);
    panX += delta;
  }

  await waitForExactRender(spectrogramShell);
  const rapidNavigation = await exerciseRapidKeyboardNavigation(page, SAMPLE_COUNT);
  expect(rapidNavigation.samples).toBe(SAMPLE_COUNT);
  expect(rapidNavigation.missedSamples).toEqual([]);
  expect(rapidNavigation.missedNextFrameFeedback).toBe(0);
  expect(rapidNavigation.blankFrames).toBe(0);
  expect(rapidNavigation.overlayFrames).toBe(0);
  expect(rapidNavigation.requestGenerationDelta).toBeGreaterThanOrEqual(SAMPLE_COUNT);
  await waitForExactRender(spectrogramShell);
  const newestRequestedGeneration = Number(
    (await spectrogramShell.getAttribute('data-render-request-generation')) ?? 0,
  );
  const newestPaintedGeneration = Number(
    (await spectrogramShell.getAttribute('data-render-painted-request-generation')) ?? 0,
  );
  expect(newestPaintedGeneration).toBe(newestRequestedGeneration);

  const exactRefinementMilliseconds: number[] = [];
  for (let index = 0; index < EXACT_SAMPLE_COUNT; index += 1) {
    exactRefinementMilliseconds.push(
      await measureExactKeyboardRefinement(page, index % 2 === 0 ? 'KeyQ' : 'KeyE'),
    );
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
    firstPreviewAfterDecodedMilliseconds,
    selection: summarize(observed.latency.selection.slice(-SAMPLE_COUNT)),
    drag: summarize(observed.latency.drag),
    pan: summarize(observed.latency.pan),
    automationRoundTrip: {
      selection: summarize(selectionDriverMilliseconds.slice(-SAMPLE_COUNT)),
      drag: summarize(dragDriverMilliseconds),
      pan: summarize(panDriverMilliseconds),
    },
    exactRefinement: summarize(exactRefinementMilliseconds),
    rapidNavigation: {
      ...rapidNavigation,
      newestRequestedGeneration,
      newestPaintedGeneration,
    },
    longTasks: {
      count: observed.longTasks.length,
      maximumMilliseconds: Math.max(0, ...observed.longTasks),
      durationsMilliseconds: observed.longTasks,
    },
    limits: {
      firstPreviewAfterDecodedMilliseconds: MAXIMUM_FIRST_PREVIEW_MILLISECONDS,
      p95Milliseconds: MAXIMUM_P95_MILLISECONDS,
      exactRefinementP95Milliseconds: MAXIMUM_P95_MILLISECONDS,
      individualLongTaskMilliseconds: MAXIMUM_LONG_TASK_MILLISECONDS,
      importedBoxes: BOX_COUNT,
    },
  };

  const evidenceDirectory = path.resolve('test-results/performance');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, 'workspace-5000-boxes.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await testInfo.attach('workspace-5000-boxes.json', {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: 'application/json',
  });

  expect(result.selection.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.drag.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.pan.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.exactRefinement.p95Milliseconds).toBeLessThanOrEqual(MAXIMUM_P95_MILLISECONDS);
  expect(result.firstPreviewAfterDecodedMilliseconds).toBeLessThanOrEqual(
    MAXIMUM_FIRST_PREVIEW_MILLISECONDS,
  );
  expect(result.longTasks.maximumMilliseconds).toBeLessThanOrEqual(MAXIMUM_LONG_TASK_MILLISECONDS);
});

function benchmarkLocalFile() {
  const species = {
    schemaVersion: 2,
    kind: 'froglabel.species',
    speciesId: 'local:benchmark-green-tree-frog',
    code: 'GRE',
    selectionPriority: 0,
    speciesName: 'Green Tree Frog',
    scientificName: 'Ranoidea caerulea',
    addedAfterInitialization: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const boxes = Array.from({ length: BOX_COUNT }, (_, index) => {
    const timeCell = index % 250;
    const frequencyCell = Math.floor(index / 250);
    const startTimeSeconds = 0.01 + timeCell * (7.96 / 250);
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
      endTimeSeconds: startTimeSeconds + 0.018,
      lowFrequencyHz,
      highFrequencyHz: lowFrequencyHz + 700,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      provenance: { source: 'human' },
    };
  });
  return {
    kind: 'froglabel.local-file',
    schemaVersion: 2,
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
      schemaVersion: 2,
      catalogId: 'local:benchmark',
      reviewStatus: 'calls_present',
      boxes,
    },
  };
}

async function exerciseRapidKeyboardNavigation(
  page: Page,
  sampleCount: number,
): Promise<{
  samples: number;
  blankFrames: number;
  overlayFrames: number;
  missedNextFrameFeedback: number;
  maximumFeedbackMilliseconds: number;
  requestGenerationDelta: number;
  missedSamples: Array<{
    index: number;
    code: string;
    priorPaint: number;
    paint: number;
    priorRequest: number;
    requested: number;
    paintedRequest: number;
  }>;
}> {
  return page.evaluate(async (count) => {
    const shell = document.querySelector<HTMLElement>('.spectrogram-shell');
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.spectrogram-canvas');
    if (!shell || !canvas) throw new Error('Rapid-navigation probe cannot find the spectrogram');
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 18;
    const probeContext = probe.getContext('2d', { alpha: false });
    if (!probeContext) throw new Error('Rapid-navigation probe cannot create a 2D context');
    const keys = ['KeyQ', 'KeyD', 'KeyW', 'KeyA', 'KeyS', 'KeyE'] as const;
    let blankFrames = 0;
    let overlayFrames = 0;
    let missedNextFrameFeedback = 0;
    const missedSamples: Array<{
      index: number;
      code: string;
      priorPaint: number;
      paint: number;
      priorRequest: number;
      requested: number;
      paintedRequest: number;
    }> = [];
    let maximumFeedbackMilliseconds = 0;
    // Every later sample starts immediately after the preceding rAF. Align the
    // first sample to that same boundary so an input dispatched just before
    // vsync is not incorrectly judged against a nearly elapsed frame budget.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const initialRequestGeneration = Number(shell.dataset.renderRequestGeneration ?? 0);

    for (let index = 0; index < count; index += 1) {
      const code = keys[index % keys.length];
      const priorPaint = Number(shell.dataset.renderGeneration ?? 0);
      const priorRequest = Number(shell.dataset.renderRequestGeneration ?? 0);
      const started = performance.now();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key: code.at(-1) }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, cancelable: true, code, key: code.at(-1) }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      maximumFeedbackMilliseconds = Math.max(
        maximumFeedbackMilliseconds,
        performance.now() - started,
      );
      const requested = Number(shell.dataset.renderRequestGeneration ?? 0);
      const paintedRequest = Number(shell.dataset.renderPaintedRequestGeneration ?? 0);
      const paint = Number(shell.dataset.renderGeneration ?? 0);
      if (paint <= priorPaint || requested <= priorRequest || paintedRequest !== requested) {
        missedNextFrameFeedback += 1;
        missedSamples.push({
          index,
          code,
          priorPaint,
          paint,
          priorRequest,
          requested,
          paintedRequest,
        });
      }
      probeContext.drawImage(canvas, 0, 0, probe.width, probe.height);
      const pixels = probeContext.getImageData(0, 0, probe.width, probe.height).data;
      let visiblePixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          pixels[offset + 3] > 0 &&
          pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 8
        ) {
          visiblePixels += 1;
        }
      }
      if (visiblePixels === 0) blankFrames += 1;
      if (shell.querySelector('.spectrogram-readiness-overlay')) overlayFrames += 1;
    }
    return {
      samples: count,
      blankFrames,
      overlayFrames,
      missedNextFrameFeedback,
      maximumFeedbackMilliseconds,
      requestGenerationDelta:
        Number(shell.dataset.renderRequestGeneration ?? 0) - initialRequestGeneration,
      missedSamples,
    };
  }, sampleCount);
}

async function measureExactKeyboardRefinement(page: Page, code: 'KeyQ' | 'KeyE'): Promise<number> {
  return page.evaluate(async (keyboardCode) => {
    const shell = document.querySelector<HTMLElement>('.spectrogram-shell');
    if (!shell) throw new Error('Exact-refinement probe cannot find the spectrogram shell');
    const priorRequest = Number(shell.dataset.renderRequestGeneration ?? 0);
    const started = performance.now();
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Exact refinement did not finish after ${keyboardCode}`));
      }, 15_000);
      const check = () => {
        const requested = Number(shell.dataset.renderRequestGeneration ?? 0);
        const painted = Number(shell.dataset.renderPaintedRequestGeneration ?? 0);
        if (
          requested > priorRequest &&
          painted === requested &&
          shell.dataset.renderStatus === 'ready' &&
          shell.dataset.renderQuality === 'exact'
        ) {
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(shell, {
        attributes: true,
        attributeFilter: [
          'data-render-request-generation',
          'data-render-painted-request-generation',
          'data-render-status',
          'data-render-quality',
        ],
      });
      check();
    });
    const key = keyboardCode === 'KeyQ' ? 'q' : 'e';
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: keyboardCode,
        key,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: keyboardCode,
        key,
      }),
    );
    await completed;
    return performance.now() - started;
  }, code);
}

async function installBrowserLatencyObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.spectrogram-stage');
    const shell = document.querySelector<HTMLElement>('.spectrogram-shell');
    if (!stage) throw new Error('Latency observer cannot find the spectrogram stage');
    if (!shell) throw new Error('Latency observer cannot find the spectrogram shell');
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
        } else if (
          event.button === 1 ||
          event.button === 2 ||
          stage.classList.contains('tool-pan')
        ) {
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
      if (latency.phase === 'pan') {
        const painted = records.some(
          (record) =>
            record.type === 'attributes' &&
            record.attributeName === 'data-render-generation' &&
            record.target === shell,
        );
        // The renderer increments this attribute only after writing pixels to
        // the live canvas. Record synchronously so a fast next gesture cannot
        // overwrite the pending phase before an extra animation frame runs.
        if (painted) finish('pan');
      }
    });
    observer.observe(shell, {
      attributes: true,
      attributeFilter: ['class', 'data-render-generation', 'data-selected-box-id', 'style'],
      childList: true,
      subtree: true,
    });
  });
}

async function installFirstFrameObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const timing = { decodedAt: null as number | null, paintedAt: null as number | null };
    Object.defineProperty(globalThis, '__froglabelFirstFrameTiming', {
      configurable: true,
      value: timing,
    });
    const sample = () => {
      const now = performance.now();
      const app = document.querySelector<HTMLElement>('.froglabel-app');
      if (timing.decodedAt === null && app?.dataset.audioPhase === 'ready') {
        timing.decodedAt = now;
      }
      const shell = document.querySelector<HTMLElement>('.spectrogram-shell');
      if (
        timing.decodedAt !== null &&
        timing.paintedAt === null &&
        Number(shell?.dataset.renderGeneration ?? 0) > 0 &&
        shell?.dataset.renderQuality === 'preview'
      ) {
        timing.paintedAt = now;
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      attributeFilter: ['data-audio-phase', 'data-render-generation', 'data-render-quality'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    sample();
  });
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function renderGeneration(shell: import('@playwright/test').Locator): Promise<number> {
  return Number((await shell.getAttribute('data-render-generation')) ?? 0);
}

async function waitForRenderAfter(
  shell: import('@playwright/test').Locator,
  generation: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const paint = await renderGeneration(shell);
        const requested = Number((await shell.getAttribute('data-render-request-generation')) ?? 0);
        const paintedRequest = Number(
          (await shell.getAttribute('data-render-painted-request-generation')) ?? 0,
        );
        return paint > generation && requested > 0 && paintedRequest === requested;
      },
      {
        message: `expected a canvas paint after generation ${generation}`,
        timeout: 5_000,
      },
    )
    .toBe(true);
}

async function waitForExactRender(shell: import('@playwright/test').Locator): Promise<void> {
  await expect(shell).toHaveAttribute('data-render-status', 'ready', { timeout: 15_000 });
  await expect(shell).toHaveAttribute('data-render-quality', 'exact', { timeout: 15_000 });
  await expect
    .poll(async () => {
      const requested = Number((await shell.getAttribute('data-render-request-generation')) ?? 0);
      const painted = Number(
        (await shell.getAttribute('data-render-painted-request-generation')) ?? 0,
      );
      return requested > 0 && painted === requested;
    })
    .toBe(true);
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

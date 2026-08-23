import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

type TutorialSurface = Page | FrameLocator;

interface TutorialWorkflowOptions {
  expectedLiveBoxCount?: number;
  afterExit?: () => Promise<void>;
}

interface GeometryRecord {
  step: number;
  anchor: string;
  target: { x: number; y: number; width: number; height: number } | null;
  coach: { x: number; y: number; width: number; height: number };
  overlapRatio: number;
}

export async function runCompleteTutorialWorkflow(
  page: Page,
  surface: TutorialSurface,
  testInfo: TestInfo,
  options: TutorialWorkflowOptions = {},
): Promise<void> {
  const geometry: GeometryRecord[] = [];
  const expectedLiveBoxCount = options.expectedLiveBoxCount ?? 0;

  await startTutorial(surface);
  await assertStep(surface, 1, geometry);
  const coach = surface.locator('.coachmark');
  await coach.focus();
  await coach.press('Space');
  await expect(coach).toHaveAttribute('data-tutorial-step', '1');
  await coach.press('Enter');
  await assertStep(surface, 2, geometry);
  await surface.getByRole('button', { name: 'Back', exact: true }).click();
  await assertStep(surface, 1, geometry);
  await next(surface);
  await assertStep(surface, 2, geometry);
  await playOnce(surface);
  await next(surface);
  await chooseEtf(page, surface);
  await next(surface);
  await ensureDrawTool(surface, true);
  await next(surface);
  await drawCenteredBox(page, surface);
  await assertPracticeBoxCoversCall(surface);
  await next(surface);
  await ensureDrawTool(surface, false);
  await next(surface);
  const firstResize = await resizeSelectedBox(page, surface);
  await expect(practiceLocator(surface, '.spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    '1',
  );
  await expect(practiceLocator(surface, `[data-box-id="${firstResize.boxId}"]`)).toHaveCount(1);

  await surface.getByRole('button', { name: 'Restart', exact: true }).click();
  await assertStep(surface, 1, geometry);
  await expect(practiceLocator(surface, '.spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    '0',
  );
  await expect(
    surface.getByRole('button', { name: 'Toggle Select and Draw tools (T)' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(practiceRoot(surface).getByLabel('Current species').locator('strong')).toHaveText(
    '—',
  );
  await expect(surface.getByRole('button', { name: 'Play or pause audio (V)' })).toBeVisible();
  await expect(practiceLocator(surface, '.annotation-box.selected')).toHaveCount(0);
  await waitForFirstFrame(surface);

  await next(surface);
  await assertStep(surface, 2, geometry);
  await playOnce(surface);
  await next(surface);
  await assertStep(surface, 3, geometry);
  await chooseEtf(page, surface);
  await next(surface);
  await assertStep(surface, 4, geometry);
  await ensureDrawTool(surface, true);
  await next(surface);
  await assertStep(surface, 5, geometry);
  await drawCenteredBox(page, surface);
  await assertPracticeBoxCoversCall(surface);
  const practiceBox = practiceLocator(surface, '.annotation-box.selected');
  const stableBoxId = await practiceBox.getAttribute('data-box-id');
  expect(stableBoxId).toBeTruthy();
  await next(surface);
  await assertStep(surface, 6, geometry);
  await ensureDrawTool(surface, false);
  await next(surface);
  await assertStep(surface, 7, geometry);
  const resized = await resizeSelectedBox(page, surface);
  expect(resized.boxId).toBe(stableBoxId);
  await expect(practiceLocator(surface, '.spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    '1',
  );
  await expect(practiceLocator(surface, `[data-box-id="${stableBoxId}"]`)).toHaveCount(1);

  // Deliberately hide the next target. The tutorial must restore the panel and
  // re-resolve a live, nonzero anchor instead of retaining a stale rectangle.
  // This is test setup rather than a step-7 user action, so bypass a coachmark
  // that can legitimately cover this unrelated control at narrow placements.
  await surface.getByRole('button', { name: '2 Details' }).click({ force: true });
  await next(surface);
  await assertStep(surface, 8, geometry);
  await expect(practiceRoot(surface).getByLabel('Start (s)')).toHaveValue(/^\d+\.\d{3}$/u);
  await expect(practiceRoot(surface).getByLabel('Low (Hz)')).toHaveValue(/^\d+$/u);

  const datasetBeforeView = await surface
    .getByRole('row', { name: /ETF — Peron's Tree Frog/ })
    .innerText();
  await next(surface);
  await assertStep(surface, 9, geometry);
  await surface.getByRole('button', { name: 'Zoom in spectrogram' }).click();
  await waitForFirstFrame(surface);
  const stage = practiceLocator(surface, '.spectrogram-stage');
  const stageRectangle = await stage.boundingBox();
  if (!stageRectangle) throw new Error('Tutorial spectrogram stage has no bounding box');
  const centerX = stageRectangle.x + stageRectangle.width / 2;
  const centerY = stageRectangle.y + stageRectangle.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(centerX + 45, centerY, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await surface.getByRole('button', { name: 'Reset and fit spectrogram view' }).click();
  await waitForFirstFrame(surface);
  expect(await surface.getByRole('row', { name: /ETF — Peron's Tree Frog/ }).innerText()).toBe(
    datasetBeforeView,
  );

  await next(surface);
  await assertStep(surface, 10, geometry);
  await surface.getByRole('button', { name: /Add missing species/ }).click();
  await expect(practiceRoot(surface).getByLabel('Left-hand code (1–6 letters)')).toBeVisible();
  await surface.getByRole('button', { name: 'Cancel' }).click();
  await expect(practiceRoot(surface).getByLabel('Left-hand code (1–6 letters)')).toHaveCount(0);

  await next(surface);
  await assertStep(surface, 11, geometry);
  await expect(surface.getByRole('button', { name: 'No calls present (Shift+X)' })).toBeVisible();
  await expect(stage).toHaveAttribute('data-box-count', '1');
  await next(surface);
  await assertStep(surface, 12, geometry);
  await expect(stage).toHaveAttribute('data-box-count', '1');
  await surface.getByRole('button', { name: /^Finish/ }).click();

  await expect(surface.getByRole('dialog', { name: /Tutorial step/ })).toHaveCount(0);
  await expect(surface.locator('.live-workspace-layer .spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    String(expectedLiveBoxCount),
  );
  await waitForLiveFirstFrame(surface);
  await expect(surface.getByRole('button', { name: 'Play or pause audio (V)' })).toBeEnabled();
  await options.afterExit?.();

  await startTutorial(surface);
  await surface.locator('.coachmark').focus();
  await surface.locator('.coachmark').press('Escape');
  await expect(surface.getByRole('dialog', { name: /Tutorial step/ })).toHaveCount(0);
  await expect(surface.locator('.live-workspace-layer .spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    String(expectedLiveBoxCount),
  );

  await testInfo.attach('tutorial-target-coach-geometry.json', {
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, geometry }, null, 2)),
    contentType: 'application/json',
  });
}

async function startTutorial(surface: TutorialSurface): Promise<void> {
  await surface.getByRole('button', { name: 'Help and tutorial' }).click();
  await surface.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await expect(surface.getByRole('dialog', { name: /Tutorial step 1/ })).toBeVisible();
}

async function next(surface: TutorialSurface): Promise<void> {
  await surface.getByRole('button', { name: /^Next/ }).click();
}

async function playOnce(surface: TutorialSurface): Promise<void> {
  await waitForFirstFrame(surface);
  const play = surface.getByRole('button', { name: 'Play or pause audio (V)' });
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(play).toContainText('Play');
  await expect(play).not.toContainText('Pause');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
}

async function chooseEtf(page: Page, surface: TutorialSurface): Promise<void> {
  await surface.locator('.coachmark').focus();
  await page.keyboard.down('Space');
  await page.keyboard.press('KeyE');
  await page.keyboard.up('Space');
  await expect(practiceRoot(surface).getByLabel('Current species')).toContainText('ETF');
  await ensureDrawTool(surface, true);
}

async function ensureDrawTool(surface: TutorialSurface, draw: boolean): Promise<void> {
  const tool = surface.getByRole('button', { name: 'Toggle Select and Draw tools (T)' });
  if ((await tool.getAttribute('aria-pressed')) !== String(draw)) await tool.click();
}

async function drawCenteredBox(page: Page, surface: TutorialSurface): Promise<void> {
  await waitForFirstFrame(surface);
  const stage = practiceLocator(surface, '.spectrogram-stage');
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
  await expect(stage).toHaveAttribute('data-box-count', '1');
}

async function assertPracticeBoxCoversCall(surface: TutorialSurface): Promise<void> {
  const dataset = surface.getByRole('button', { name: '4 Dataset' });
  const wasOpen = (await dataset.getAttribute('aria-pressed')) === 'true';
  if (!wasOpen) await dataset.click({ force: true });
  const row = surface.getByRole('row', { name: /ETF — Peron's Tree Frog/ });
  await expect(row).toBeVisible();
  const cells = await row.locator('td').allTextContents();
  if (!wasOpen) await dataset.click({ force: true });
  const [start, end, low, high] = cells.slice(0, 4).map(Number);
  expect(start).toBeLessThanOrEqual(3.6);
  expect(end).toBeGreaterThanOrEqual(4.4);
  expect(low).toBeLessThanOrEqual(1_050);
  expect(high).toBeGreaterThanOrEqual(5_000);
}

async function resizeSelectedBox(page: Page, surface: TutorialSurface): Promise<{ boxId: string }> {
  const selected = practiceLocator(surface, '.annotation-box.selected');
  await expect(selected).toHaveCount(1);
  const boxId = await selected.getAttribute('data-box-id');
  if (!boxId) throw new Error('Tutorial selected box has no immutable ID');
  const handle = await selected.locator('.handle-se').boundingBox();
  if (!handle) throw new Error('Tutorial resize handle is unavailable in Select mode');
  const before = await selected.getAttribute('style');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y + 20, { steps: 6 });
  await page.mouse.up();
  await expect(practiceLocator(surface, `[data-box-id="${boxId}"]`)).toHaveCount(1);
  expect(await practiceLocator(surface, `[data-box-id="${boxId}"]`).getAttribute('style')).not.toBe(
    before,
  );
  return { boxId };
}

async function waitForFirstFrame(surface: TutorialSurface): Promise<void> {
  await expect(practiceLocator(surface, '.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
}

async function waitForLiveFirstFrame(surface: TutorialSurface): Promise<void> {
  await expect(surface.locator('.live-workspace-layer .spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
}

function practiceLocator(surface: TutorialSurface, selector: string): Locator {
  return surface.locator(`.tutorial-practice-layer ${selector}`);
}

function practiceRoot(surface: TutorialSurface): Locator {
  return surface.locator('.tutorial-practice-layer');
}

async function assertStep(
  surface: TutorialSurface,
  step: number,
  geometry: GeometryRecord[],
): Promise<void> {
  const coach = surface.getByRole('dialog', { name: `Tutorial step ${step} of 12` });
  await expect(coach).toBeVisible();
  const anchor = (await coach.getAttribute('data-tutorial-anchor')) ?? 'none';
  const placement = await waitForCoachPlacement(surface, coach, anchor, step);
  const { coachBox, targetBox, overlapRatio } = placement;
  expect(overlapRatio).toBeLessThanOrEqual(0.25);
  geometry.push({ step, anchor, target: targetBox, coach: coachBox, overlapRatio });
}

async function waitForCoachPlacement(
  surface: TutorialSurface,
  coach: Locator,
  anchor: string,
  step: number,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const coachBox = await coach.boundingBox();
    const targetBox =
      anchor === 'none' ? null : await surface.locator('.tutorial-ring').boundingBox();
    if (
      coachBox &&
      coachBox.width > 0 &&
      coachBox.height > 0 &&
      (anchor === 'none' || (targetBox && targetBox.width > 0 && targetBox.height > 0))
    ) {
      const overlap = targetBox ? overlapArea(targetBox, coachBox) : 0;
      const overlapRatio = targetBox ? overlap / (targetBox.width * targetBox.height) : 0;
      if (overlapRatio <= 0.25) return { coachBox, targetBox, overlapRatio };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Tutorial target/coach placement did not settle at step ${step}`);
}

function overlapArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  return (
    Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  );
}

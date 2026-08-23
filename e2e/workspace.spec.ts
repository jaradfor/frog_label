import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixture';

test('selects GRE by chord, draws with the mouse, toggles tools, and deletes by shortcut', async ({
  page,
}) => {
  await page.goto('./');
  const shell = page.locator('.spectrogram-shell');
  await waitForSpectrogramFrame(shell);

  const speciesPanel = page.getByRole('button', { name: '1 Species' });
  const tool = page.getByRole('button', { name: 'Toggle Select and Draw tools (T)' });
  await page.keyboard.down('Space');
  await page.keyboard.press('KeyG');
  await expect(page.locator('.froglabel-app')).toHaveAttribute('data-species-capture', 'active');
  await expect(page.locator('.expert-status-line')).toHaveAttribute('data-species-query', 'G');
  await expect(page.locator('.expert-status-line')).toHaveAttribute(
    'data-species-candidate',
    'GRE',
  );
  await expect(page.locator('.expert-status-line')).toContainText('release Space');
  await page.keyboard.press('Digit1');
  await expect(speciesPanel).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.up('Space');
  await expect(page.getByLabel('Current species')).toContainText('GRE');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('canvas.spectrogram-canvas');
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + rect!.width * 0.42, rect!.y + rect!.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.53, rect!.y + rect!.height * 0.88, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.spectrogram-stage')).toHaveAttribute('data-box-count', '1');
  await page.keyboard.press('Digit4');
  await expect(page.getByRole('row', { name: /GRE — Green Tree Frog/ })).toBeVisible();
  await page.keyboard.press('Digit2');
  await expect(page.getByText('Origin').locator('..')).toContainText('Human');
  const rawReplay = page.getByRole('button', { name: /Replay box raw/i });
  const bandReplay = page.getByRole('button', { name: /Replay box band-pass/i });
  const negativeReplay = page.getByRole('button', { name: /Play negative outside box/i });
  const bandMargin = page.getByRole('spinbutton', { name: 'Band-pass margin' });
  await expect(rawReplay).toBeEnabled();
  await expect(bandReplay).toBeEnabled();
  await expect(negativeReplay).toBeEnabled();
  await expect(bandMargin).toHaveValue('250');
  await expect(page.locator('#audition-band-summary')).toContainText(
    /Band-pass .*Negative removes/,
  );
  await bandReplay.click();
  await expect(bandReplay).toHaveAttribute('aria-pressed', 'true');
  await negativeReplay.click();
  await expect(negativeReplay).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('status').filter({ hasText: 'Negative replay playing' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/playwright/gre-annotation.png' });

  // C is a selection command even when Draw is armed; it must not silently
  // no-op behind the current tool mode.
  await page.keyboard.press('KeyC');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');

  // The Dataset dock deliberately shortens the spectrogram. Close it before
  // targeting the annotation again so the pointer coordinates are current.
  await page.keyboard.press('Digit4');
  await expect(page.getByRole('button', { name: '4 Dataset' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('Digit1');
  const search = page.getByRole('textbox', { name: 'Search' });
  await search.focus();
  const annotation = page.locator('.annotation-box');
  await annotation.click({ position: { x: 12, y: 12 } });
  await expect(page.locator('.spectrogram-stage')).toBeFocused();
  await page.keyboard.press('Digit3');
  await expect(page.getByRole('button', { name: '3 Display' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const viewportBeforeMiddlePan = await readViewport(canvas);
  const boxRectangle = await annotation.boundingBox();
  if (!boxRectangle) throw new Error('Selected annotation box has no bounding box');
  const generationBeforeMiddlePan = Number(
    (await shell.getAttribute('data-render-generation')) ?? 0,
  );
  await page.mouse.move(
    boxRectangle.x + boxRectangle.width / 2,
    boxRectangle.y + boxRectangle.height / 2,
  );
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(
    boxRectangle.x + boxRectangle.width / 2 + 24,
    boxRectangle.y + boxRectangle.height / 2,
  );
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => Number((await shell.getAttribute('data-render-generation')) ?? 0))
    .toBeGreaterThan(generationBeforeMiddlePan);
  expect(await readViewport(canvas)).not.toEqual(viewportBeforeMiddlePan);

  await page.keyboard.press('KeyT');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+KeyD');
  await expect(page.locator('.spectrogram-stage')).toHaveAttribute('data-box-count', '0');
  await expect(page.getByRole('row', { name: /GRE — Green Tree Frog/ })).toHaveCount(0);
});

test('routes expert controls after buttons and the spectrogram, but protects fields and held pointers', async ({
  page,
}) => {
  await page.goto('./');
  await waitForSpectrogramFrame(page.locator('.spectrogram-shell'));

  const panelButtons = ['1 Species', '2 Details', '3 Display', '4 Dataset'].map((name) =>
    page.getByRole('button', { name }),
  );
  for (const button of panelButtons) {
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }

  const play = page.getByRole('button', { name: 'Play or pause audio (V)' });
  await expect(play).toContainText('Play');
  await expect(play).not.toContainText('Pause');
  const playRectangle = await elementRectangle(play);
  await play.focus();
  await page.keyboard.press('Digit1');
  await expect(panelButtons[0]).toHaveAttribute('aria-pressed', 'true');

  const species = page.getByRole('button', { name: '1 Species' });
  const search = page.getByRole('textbox', { name: 'Search' });
  await search.focus();
  await page.keyboard.press('Digit2');
  await expect(panelButtons[1]).toHaveAttribute('aria-pressed', 'false');
  await search.fill('GRE');
  await search.pressSequentially('X');
  await page.keyboard.press('Control+Z');
  await expect(search).toHaveValue('GRE');

  const stage = page.locator('.spectrogram-stage');
  await stage.click({ position: { x: 420, y: 180 } });
  await expect(stage).toBeFocused();
  await page.keyboard.press('Digit2');
  await expect(panelButtons[1]).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Digit3');
  await expect(panelButtons[1]).toHaveAttribute('aria-pressed', 'false');
  await expect(panelButtons[2]).toHaveAttribute('aria-pressed', 'true');

  const stageRectangle = await stage.boundingBox();
  if (!stageRectangle) throw new Error('Spectrogram stage has no bounding box');
  await page.mouse.move(stageRectangle.x + stageRectangle.width / 2, stageRectangle.y + 80);
  await page.mouse.down();
  await page.keyboard.press('Digit4');
  await expect(panelButtons[3]).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.up();
  await page.keyboard.press('Digit4');
  await expect(panelButtons[3]).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('KeyV');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(play).toContainText('Play');
  await expect(play).not.toContainText('Pause');
  expect(await elementRectangle(play)).toEqual(playRectangle);
  await page.keyboard.press('KeyF');
  await expect(page.getByLabel('Playback rate')).toHaveText('1.25×');
  await page.keyboard.press('KeyR');
  await expect(page.getByLabel('Playback rate')).toHaveText('1×');
  await page.keyboard.press('KeyV');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(species).toHaveAttribute('aria-pressed', 'true');
});

test('switches the seven previewed palettes without blanking the retained spectrogram', async ({
  page,
}) => {
  await page.goto('./');
  const shell = page.locator('.spectrogram-shell');
  await waitForSpectrogramFrame(shell);
  await page.getByRole('button', { name: '3 Display' }).click();

  const paletteGroup = page.getByRole('radiogroup', { name: 'Spectrogram palette' });
  const paletteNames = ['Roseus', 'Inferno', 'Inverse gray', 'Gray', 'Viridis', 'Magma', 'Plasma'];
  await expect(paletteGroup.getByRole('radio')).toHaveCount(paletteNames.length);
  for (const name of paletteNames) {
    const choice = paletteGroup.getByRole('radio', { name: `${name} palette`, exact: true });
    await expect(choice).toBeVisible();
    await expect(choice.locator('.palette-swatch')).toHaveCSS(
      'background-image',
      /linear-gradient/,
    );
  }

  const generation = Number((await shell.getAttribute('data-render-generation')) ?? 0);
  await paletteGroup.getByRole('radio', { name: 'Roseus palette' }).click();
  await expect(paletteGroup.getByRole('radio', { name: 'Roseus palette' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect
    .poll(async () => Number(await shell.getAttribute('data-render-generation')))
    .toBeGreaterThan(generation);
  await expect(shell).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.spectrogram-readiness-overlay')).toHaveCount(0);
});

test('fifty view operations cannot mutate canonical geometry', async ({ page }) => {
  await page.goto('./');
  await waitForSpectrogramFrame(page.locator('.spectrogram-shell'));
  await page.keyboard.down('Space');
  await page.keyboard.press('KeyG');
  await page.keyboard.up('Space');
  const rect = await page.locator('canvas.spectrogram-canvas').boundingBox();
  await page.mouse.move(rect!.x + 100, rect!.y + 140);
  await page.mouse.down();
  await page.mouse.move(rect!.x + 190, rect!.y + 240);
  await page.mouse.up();
  await page.keyboard.press('Digit4');
  const before = await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).innerText();
  for (let index = 0; index < 10; index += 1) {
    await page.getByRole('button', { name: 'Zoom in spectrogram' }).click();
    await page.getByRole('button', { name: 'Zoom out spectrogram' }).click();
    await page.getByRole('button', { name: 'Toggle light and dark theme' }).click();
    await page.getByRole('button', { name: '3 Display' }).click();
    await page.getByRole('button', { name: '3 Display' }).click();
  }
  expect(await page.getByRole('row', { name: /GRE — Green Tree Frog/ }).innerText()).toBe(before);
});

test('WASD, Q/E, and X control both camera axes with painted feedback', async ({ page }) => {
  await page.goto('./');
  const shell = page.locator('.spectrogram-shell');
  await waitForSpectrogramFrame(shell);
  const canvas = page.locator('canvas.spectrogram-canvas');
  const initial = await readViewport(canvas);

  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const zoomed = await readViewport(canvas);
  expect(zoomed.timeEnd - zoomed.timeStart).toBeLessThan(initial.timeEnd - initial.timeStart);
  expect(zoomed.highFrequency - zoomed.lowFrequency).toBeLessThan(
    initial.highFrequency - initial.lowFrequency,
  );

  await pressAndWaitForPaint(page, shell, 'KeyD');
  const later = await readViewport(canvas);
  expect(later.timeStart).toBeGreaterThan(zoomed.timeStart);
  await pressAndWaitForPaint(page, shell, 'KeyA');
  const earlier = await readViewport(canvas);
  expect(earlier.timeStart).toBeLessThan(later.timeStart);

  await pressAndWaitForPaint(page, shell, 'KeyW');
  const higher = await readViewport(canvas);
  expect(higher.lowFrequency).toBeGreaterThan(earlier.lowFrequency);
  await pressAndWaitForPaint(page, shell, 'KeyS');
  const lower = await readViewport(canvas);
  expect(lower.lowFrequency).toBeLessThan(higher.lowFrequency);

  await pressAndWaitForPaint(page, shell, 'KeyE');
  const zoomedOut = await readViewport(canvas);
  expect(zoomedOut.timeEnd - zoomedOut.timeStart).toBeGreaterThanOrEqual(
    zoomed.timeEnd - zoomed.timeStart,
  );
  await pressAndWaitForPaint(page, shell, 'KeyX');
  const fitted = await readViewport(canvas);
  expect(fitted.timeStart).toBeCloseTo(initial.timeStart, 2);
  expect(fitted.timeEnd).toBeCloseTo(initial.timeEnd, 2);
  expect(fitted.lowFrequency).toBeCloseTo(initial.lowFrequency, 0);
  expect(fitted.highFrequency).toBeCloseTo(initial.highFrequency, 0);

  await page.keyboard.press('Digit3');
  await page.getByLabel('Frequency scale').selectOption('logarithmic');
  await expect(shell).toHaveAttribute('data-frequency-scale', 'logarithmic');
  await expect.poll(async () => (await readViewport(canvas)).lowFrequency).toBeGreaterThan(0);
  await pressAndWaitForPaint(page, shell, 'KeyQ');
  await pressAndWaitForPaint(page, shell, 'KeyX');
  const logarithmicFit = await readViewport(canvas);
  expect(logarithmicFit.lowFrequency).toBeCloseTo(20, 0);
  expect(logarithmicFit.highFrequency).toBeCloseTo(initial.highFrequency, 0);
  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const logarithmicZoom = await readViewport(canvas);
  await pressAndWaitForPaint(page, shell, 'KeyW');
  const logarithmicPan = await readViewport(canvas);
  expect(logarithmicPan.lowFrequency).toBeGreaterThan(logarithmicZoom.lowFrequency);
  expect(logarithmicPan.highFrequency / logarithmicPan.lowFrequency).toBeCloseTo(
    logarithmicZoom.highFrequency / logarithmicZoom.lowFrequency,
    1,
  );
});

test('Q/E zoom follows the plot, waveform, and frequency-ruler pointer context', async ({
  page,
}) => {
  await page.goto('./');
  const shell = page.locator('.spectrogram-shell');
  const canvas = page.locator('canvas.spectrogram-canvas');
  const zoomStatus = page.locator('.zoom-context-status');
  await waitForSpectrogramFrame(shell);
  const fitted = await readViewport(canvas);
  await expect(zoomStatus).toHaveAttribute('data-zoom-scope', 'both');

  const waveform = await elementRectangle(page.locator('.waveform-strip'));
  await page.mouse.move(waveform.x + waveform.width * 0.25, waveform.y + waveform.height / 2);
  await expect(zoomStatus).toHaveAttribute('data-zoom-scope', 'time');
  const beforeTimeZoom = await readViewport(canvas);
  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const timeZoom = await readViewport(canvas);
  expect(timeZoom.timeEnd - timeZoom.timeStart).toBeLessThan(
    beforeTimeZoom.timeEnd - beforeTimeZoom.timeStart,
  );
  expect(timeZoom.lowFrequency).toBe(beforeTimeZoom.lowFrequency);
  expect(timeZoom.highFrequency).toBe(beforeTimeZoom.highFrequency);
  await pressAndWaitForPaint(page, shell, 'KeyX');

  const zoomButton = page.getByRole('button', { name: 'Zoom in spectrogram' });
  await zoomButton.focus();
  const beforeButtonZoom = await readViewport(canvas);
  await pressAndWaitForPaint(page, shell, 'Enter');
  const buttonZoom = await readViewport(canvas);
  expect(buttonZoom.timeEnd - buttonZoom.timeStart).toBeLessThan(
    beforeButtonZoom.timeEnd - beforeButtonZoom.timeStart,
  );
  expect(buttonZoom.highFrequency - buttonZoom.lowFrequency).toBeLessThan(
    beforeButtonZoom.highFrequency - beforeButtonZoom.lowFrequency,
  );
  await pressAndWaitForPaint(page, shell, 'KeyX');

  const frequencyAxis = await elementRectangle(page.locator('.frequency-axis'));
  await page.mouse.move(
    frequencyAxis.x + frequencyAxis.width / 2,
    frequencyAxis.y + frequencyAxis.height * 0.25,
  );
  await expect(zoomStatus).toHaveAttribute('data-zoom-scope', 'frequency');
  const beforeFrequencyZoom = await readViewport(canvas);
  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const frequencyZoom = await readViewport(canvas);
  expect(frequencyZoom.highFrequency - frequencyZoom.lowFrequency).toBeLessThan(
    beforeFrequencyZoom.highFrequency - beforeFrequencyZoom.lowFrequency,
  );
  expect(frequencyZoom.timeStart).toBe(beforeFrequencyZoom.timeStart);
  expect(frequencyZoom.timeEnd).toBe(beforeFrequencyZoom.timeEnd);
  await pressAndWaitForPaint(page, shell, 'KeyX');

  const plot = await elementRectangle(canvas);
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
  await expect(zoomStatus).toHaveAttribute('data-zoom-scope', 'both');
  const beforeCombinedZoom = await readViewport(canvas);
  await pressAndWaitForPaint(page, shell, 'KeyQ');
  const combinedZoom = await readViewport(canvas);
  expect(combinedZoom.timeEnd - combinedZoom.timeStart).toBeLessThan(
    beforeCombinedZoom.timeEnd - beforeCombinedZoom.timeStart,
  );
  expect(combinedZoom.highFrequency - combinedZoom.lowFrequency).toBeLessThan(
    beforeCombinedZoom.highFrequency - beforeCombinedZoom.lowFrequency,
  );

  await page.mouse.move(1, 1);
  await expect(zoomStatus).toHaveAttribute('data-zoom-scope', 'both');
  await pressAndWaitForPaint(page, shell, 'KeyX');
  expect(await readViewport(canvas)).toEqual(fitted);
});

for (const viewport of [
  { width: 640, height: 700 },
  { width: 844, height: 720 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`keeps a fixed non-scrolling canvas with reflowing docks at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await waitForSpectrogramFrame(page.locator('.spectrogram-shell'));
    const canvas = page.locator('canvas.spectrogram-canvas');
    const initial = await elementRectangle(canvas);

    expect(
      await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0),
    ).toBeLessThanOrEqual(viewport.width);
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0),
    ).toBeLessThanOrEqual(viewport.height);
    await page.evaluate(() => window.scrollTo(10_000, 10_000));
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
      x: 0,
      y: 0,
    });
    await expect(page.locator('.expert-status-meta')).toBeVisible();

    const shortcutBank = page.getByRole('navigation', { name: 'Workspace panels and review' });
    for (const label of ['Species', 'Box details', 'Spectrogram', 'Dataset', 'No calls']) {
      await expect(shortcutBank.getByText(label, { exact: true })).toBeVisible();
    }
    for (const keycap of await shortcutBank.locator('kbd').all()) {
      const keyRectangle = await elementRectangle(keycap);
      expect(keyRectangle.width).toBeGreaterThanOrEqual(24);
      expect(keyRectangle.height).toBeGreaterThanOrEqual(24);
    }

    for (const [index, name] of ['Species', 'Details', 'Display', 'Dataset'].entries()) {
      const button = page.getByRole('button', { name: `${index + 1} ${name}` });
      await page.keyboard.press(`Digit${index + 1}`);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      const pushed = await elementRectangle(canvas);
      if (name === 'Dataset') {
        expect(pushed.height).toBeLessThan(initial.height);
        const dataset = await elementRectangle(page.locator('.dataset-panel'));
        expect(dataset.y).toBeGreaterThanOrEqual(pushed.y + pushed.height);
      } else {
        expect(pushed.width).toBeLessThan(initial.width);
        const panel = await elementRectangle(
          page.locator(name === 'Species' ? '.species-panel' : '.right-panel'),
        );
        if (name === 'Species') expect(panel.x + panel.width).toBeLessThanOrEqual(pushed.x);
        else expect(panel.x).toBeGreaterThanOrEqual(pushed.x + pushed.width);
      }
      await page.keyboard.press(`Digit${index + 1}`);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      const restored = await elementRectangle(canvas);
      expect(restored.width).toBeCloseTo(initial.width, 1);
      expect(restored.height).toBeCloseTo(initial.height, 1);
    }

    await page.keyboard.press('Digit1');
    const panelScrolling = await page.locator('.species-panel').evaluate((panel) => {
      const heading = panel.querySelector<HTMLElement>('.panel-heading');
      const body = panel.querySelector<HTMLElement>('.species-picker');
      if (!heading || !body) throw new Error('Species drawer is missing its fixed heading/body');
      const before = heading.getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      return {
        panelOverflow: getComputedStyle(panel).overflowY,
        bodyOverflow: getComputedStyle(body).overflowY,
        headingBefore: before,
        headingAfter: heading.getBoundingClientRect().top,
      };
    });
    expect(panelScrolling).toEqual({
      panelOverflow: 'hidden',
      bodyOverflow: 'auto',
      headingBefore: panelScrolling.headingBefore,
      headingAfter: panelScrolling.headingBefore,
    });
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
      x: 0,
      y: 0,
    });
  });
}

test('tutorial writes only to memory and closes on an epoch switch', async ({ page }) => {
  await page.goto('./fake-host/index.html');
  const frame = page.frameLocator('#froglabel');
  await frame.getByRole('button', { name: 'Help and tutorial' }).click();
  await frame.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await waitForSpectrogramFrame(frame.locator('.tutorial-practice-layer .spectrogram-shell'));
  await frame.getByRole('button', { name: /^Next/ }).click();
  await frame.getByRole('button', { name: /^Next/ }).click();
  await page.keyboard.down('Space');
  await page.keyboard.press('KeyE');
  await expect(frame.locator('.tutorial-practice-layer .expert-status-line')).toHaveAttribute(
    'data-species-candidate',
    'ETF',
  );
  await page.keyboard.up('Space');
  await expect(
    frame.locator('.tutorial-practice-layer [aria-label="Current species"]'),
  ).toContainText('ETF');
  await frame.getByRole('button', { name: /^Next/ }).click();
  await frame.getByRole('button', { name: /^Next/ }).click();
  const canvas = frame.locator('.tutorial-practice-layer canvas.spectrogram-canvas');
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect!.x + rect!.width * 0.43, rect!.y + rect!.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.57, rect!.y + rect!.height * 0.96, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(frame.locator('.tutorial-practice-layer .spectrogram-stage')).toHaveAttribute(
    'data-box-count',
    '1',
  );
  await expect(page.locator('#count')).toHaveText('0');
  await expect(page.locator('#log')).not.toContainText(/addRegion|updateRegion|deleteRegion/);
  await page.getByRole('button', { name: 'Switch task/epoch' }).click();
  await expect(frame.getByRole('dialog', { name: /Tutorial step/ })).toHaveCount(0);
  await expect(frame.locator('.tutorial-practice-layer')).toHaveCount(0);
  await expect(frame.locator('.live-workspace-layer')).not.toHaveAttribute('aria-hidden', 'true');
  await expect(frame.locator('.live-workspace-layer')).not.toHaveAttribute('inert', '');
});

test('has no serious or critical axe violations', async ({ page }) => {
  await page.goto('./');
  const assertAccessible = async () => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      ),
    ).toEqual([]);
  };
  await assertAccessible();
  await page.getByRole('button', { name: 'Help and tutorial' }).click();
  await assertAccessible();
  await page.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await assertAccessible();
});

async function waitForSpectrogramFrame(shell: Locator): Promise<void> {
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute('data-spectrogram-state', 'firstFrameReady', {
    timeout: 15_000,
  });
  await expect
    .poll(async () => Number((await shell.getAttribute('data-render-generation')) ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect(shell.locator('.spectrogram-readiness-overlay')).toHaveCount(0);
}

async function pressAndWaitForPaint(page: Page, shell: Locator, key: string): Promise<void> {
  const beforePaint = Number((await shell.getAttribute('data-render-generation')) ?? 0);
  const beforeRequest = Number((await shell.getAttribute('data-render-request-generation')) ?? 0);
  await page.keyboard.press(key);
  await expect
    .poll(
      async () => {
        const paint = Number((await shell.getAttribute('data-render-generation')) ?? 0);
        const requested = Number((await shell.getAttribute('data-render-request-generation')) ?? 0);
        const paintedRequest = Number(
          (await shell.getAttribute('data-render-painted-request-generation')) ?? 0,
        );
        return paint > beforePaint && requested > beforeRequest && paintedRequest === requested;
      },
      {
        timeout: 5_000,
      },
    )
    .toBe(true);
}

async function readViewport(canvas: Locator): Promise<{
  timeStart: number;
  timeEnd: number;
  lowFrequency: number;
  highFrequency: number;
}> {
  return canvas.evaluate((element) => {
    const shell = element.closest<HTMLElement>('.spectrogram-shell');
    if (!shell) throw new Error('Spectrogram canvas is missing its diagnostic shell');
    const read = (name: string) => {
      const raw = shell.getAttribute(name);
      const value = Number(raw);
      if (raw === null || !Number.isFinite(value)) {
        throw new Error(`Spectrogram shell has invalid ${name}: ${String(raw)}`);
      }
      return value;
    };
    return {
      timeStart: read('data-view-time-start-seconds'),
      timeEnd: read('data-view-time-end-seconds'),
      lowFrequency: read('data-view-low-frequency-hz'),
      highFrequency: read('data-view-high-frequency-hz'),
    };
  });
}

async function elementRectangle(locator: Locator): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return locator.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    };
  });
}

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixture';

test('draws and inspects a GRE box using real pointer input', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('img', { name: /Spectrogram from/ })).toBeVisible();
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
  );
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).click();
  await page.getByRole('button', { name: /Draw Box/ }).click();
  const canvas = page.locator('canvas.spectrogram-canvas');
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + rect!.width * 0.12, rect!.y + rect!.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.23, rect!.y + rect!.height * 0.88, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('row', { name: /GRE — Green Tree Frog/ })).toBeVisible();
  await expect(page.getByText('Origin').locator('..')).toContainText('Human');
  await page.screenshot({ path: 'test-results/playwright/gre-annotation.png' });
});

test('panel shortcuts work with neutral focus and never hijack inputs', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
  );
  await page.locator('header').click({ position: { x: 160, y: 30 } });
  for (const digit of ['1', '2', '3', '4']) {
    const button = page.getByRole('button', { name: new RegExp(`^${digit} `) });
    const before = await button.getAttribute('aria-pressed');
    await page.keyboard.press(`Digit${digit}`);
    await expect(button).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  }
  const species = page.getByRole('button', { name: '1 Species' });
  if ((await species.getAttribute('aria-pressed')) !== 'true') await species.click();
  const search = page.getByRole('textbox', { name: 'Search' });
  await search.focus();
  const details = page.getByRole('button', { name: '2 Details' });
  const detailsState = await details.getAttribute('aria-pressed');
  await page.keyboard.press('Digit2');
  await expect(details).toHaveAttribute('aria-pressed', detailsState!);
  await search.fill('GRE');
  await search.pressSequentially('X');
  await page.keyboard.press('Control+Z');
  await expect(search).toHaveValue('GRE');
});

test('fifty view operations cannot mutate canonical geometry', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
    { timeout: 15_000 },
  );
  await page.getByRole('option', { name: 'GRE Green Tree Frog' }).click();
  await page.getByRole('button', { name: /Draw Box/ }).click();
  const rect = await page.locator('canvas.spectrogram-canvas').boundingBox();
  await page.mouse.move(rect!.x + 100, rect!.y + 140);
  await page.mouse.down();
  await page.mouse.move(rect!.x + 190, rect!.y + 240);
  await page.mouse.up();
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

test('tutorial writes only to memory and closes on an epoch switch', async ({ page }) => {
  await page.goto('./fake-host/index.html');
  const frame = page.frameLocator('#froglabel');
  await frame.getByRole('button', { name: 'Help and tutorial' }).click();
  await frame.getByRole('button', { name: /Start 2-minute tutorial/ }).click();
  await expect(frame.locator('.tutorial-practice-layer .spectrogram-shell')).toHaveAttribute(
    'data-spectrogram-state',
    'firstFrameReady',
  );
  await frame.getByRole('button', { name: /^Next/ }).click();
  await frame.getByRole('button', { name: /^Next/ }).click();
  await frame.getByRole('option', { name: "PER Peron's Tree Frog" }).click();
  await frame.getByRole('button', { name: /^Next/ }).click();
  await frame.getByRole('button', { name: /Draw Box/ }).click();
  await frame.getByRole('button', { name: /^Next/ }).click();
  const canvas = frame.locator('.tutorial-practice-layer canvas.spectrogram-canvas');
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect!.x + rect!.width * 0.43, rect!.y + rect!.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * 0.57, rect!.y + rect!.height * 0.96, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(frame.getByRole('row', { name: /PER — Peron's Tree Frog/ })).toBeVisible();
  await expect(page.locator('#count')).toHaveText('0');
  await expect(page.locator('#log')).not.toContainText(/addRegion|updateRegion|deleteRegion/);
  await page.getByRole('button', { name: 'Switch task/epoch' }).click();
  await expect(frame.getByRole('dialog', { name: /Tutorial step/ })).toHaveCount(0);
  await expect(frame.getByText('Label Studio workspace')).toBeVisible();
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

import { test } from '@playwright/test';
import { runSeededStandaloneExplorer } from '../e2e-support/seededExplorer';

test.setTimeout(90_000);

test('runs the seeded replayable Pages artifact explorer', async ({ page }, testInfo) => {
  await runSeededStandaloneExplorer(page, testInfo, { localUrl: './?mode=local' });
});

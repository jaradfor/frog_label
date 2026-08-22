import { test } from './fixture';
import { runSeededStandaloneExplorer } from '../e2e-support/seededExplorer';

test.setTimeout(90_000);

test('runs the seeded replayable standalone state/action explorer', async ({ page }, testInfo) => {
  await runSeededStandaloneExplorer(page, testInfo);
});

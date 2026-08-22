import { defineConfig, devices } from '@playwright/test';

const inProcess = process.env.FROGLABEL_E2E_IN_PROCESS === '1';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: inProcess ? 'http://localhost/frog_label/' : 'http://127.0.0.1:4175/frog_label/',
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: inProcess ? 'off' : 'retain-on-failure',
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: inProcess
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4175',
        url: 'http://127.0.0.1:4175/frog_label/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});

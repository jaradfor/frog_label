import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e-pages',
  outputDir: './test-results/playwright-github-pages-static',
  fullyParallel: false,
  retries: 0,
  reporter: [['line'], ['html', { outputFolder: 'playwright-report-pages', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4180/frog_label/',
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve-static.mjs build/pages /frog_label/ 4180',
    url: 'http://127.0.0.1:4180/frog_label/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

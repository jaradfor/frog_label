import { defineConfig } from 'vitest/config';

import { spectrogramWorkerSource } from './scripts/vite-spectrogram-worker-plugin.mjs';

export default defineConfig({
  plugins: [spectrogramWorkerSource()],
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['vendor/**', 'integration/**', 'dist/**'],
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
    restoreMocks: true,
    clearMocks: true,
  },
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/smoke',
  testIgnore: [
    '**/sorting-reasons.spec.ts',
    '**/desktop-layout.spec.ts',
    '**/desktop-table-density.spec.ts',
    '**/transfer-recovery.spec.ts',
    '**/desktop-zoom.spec.ts',
  ],
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['github'], ['json', { outputFile: 'test-results/smoke-results.json' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-390',
      use: {
        browserName: 'chromium',
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: 'npm run build:e2e && npm run preview -- --host 127.0.0.1',
    env: { VITE_ENABLE_MOCK_FALLBACK: 'true' },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

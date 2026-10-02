import { defineConfig } from '@playwright/test';

import smokeConfig from './playwright.config';

const webOrigin = 'http://127.0.0.1:4175';

export default defineConfig({
  ...smokeConfig,
  outputDir: './test-results/production',
  reporter: process.env.CI
    ? [['github'], ['json', { outputFile: 'test-results/production-results.json' }]]
    : 'list',
  testIgnore: [],
  testMatch: [
    '**/sorting-reasons.spec.ts',
    '**/desktop-layout.spec.ts',
    '**/desktop-table-density.spec.ts',
    '**/transfer-recovery.spec.ts',
    '**/desktop-zoom.spec.ts',
    '**/responsive-table-layout.spec.ts',
    // Store-detail regression must also pass against the production bundle (no mock fallback).
    '**/inbound-statistics.spec.ts',
    // Desktop login/shell typography, gutters and sign-out states with route-mocked API.
    '**/desktop-login-shell.spec.ts',
  ],
  use: { ...smokeConfig.use, baseURL: webOrigin },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4175',
    env: { VITE_ENABLE_MOCK_FALLBACK: 'false' },
    url: webOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

import { defineConfig } from '@playwright/test';

import smokeConfig from './playwright.config';

const webOrigin = 'http://127.0.0.1:4175';

export default defineConfig({
  ...smokeConfig,
  testIgnore: [],
  testMatch: '**/sorting-reasons.spec.ts',
  use: { ...smokeConfig.use, baseURL: webOrigin },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4175',
    env: { VITE_ENABLE_MOCK_FALLBACK: 'false' },
    url: webOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

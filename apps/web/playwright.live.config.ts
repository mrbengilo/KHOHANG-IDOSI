import { defineConfig } from '@playwright/test';

const apiPort = 3100;
const webPort = 4174;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  // These workflows share the reference catalog, allocation calendar and admin
  // account. Independent concurrency behavior is covered by PostgreSQL tests.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    viewport: { height: 900, width: 1440 },
  },
  webServer: [
    {
      command: 'npm run start -w @idosi/api',
      env: {
        API_HOST: '127.0.0.1',
        API_PORT: String(apiPort),
        API_STORAGE: process.env.LIVE_E2E_API_STORAGE ?? 'postgres',
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        LOG_LEVEL: 'warn',
        MEMORY_BOOTSTRAP_PASSWORD:
          process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
        NODE_ENV: 'test',
        WEB_ORIGIN: webOrigin,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: `${apiOrigin}/ready`,
    },
    {
      command:
        'npm run build -w @idosi/web && npm run preview -w @idosi/web -- --host 127.0.0.1 --port 4174',
      env: {
        VITE_API_BASE_URL: `${apiOrigin}/api/v1`,
        VITE_ENABLE_MOCK_FALLBACK: 'false',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: webOrigin,
    },
  ],
});

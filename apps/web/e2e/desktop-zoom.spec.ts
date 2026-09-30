import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mockLayoutAdmin } from './layout-fixtures';

test('real browser zoom keeps inventory and merged inbound documents usable', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.skip(
    testInfo.project.name !== 'desktop-1440',
    'Browser zoom applies to the desktop browser only.',
  );
  const temporary = await mkdtemp(join(tmpdir(), 'idosi-zoom-'));
  // Only remove a unique test-owned directory, never a browser's normal profile.
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Unexpected temporary path');
  const extension = join(temporary, 'extension');
  await mkdir(extension);
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Local IDOSI zoom verification',
      version: '1.0',
      permissions: ['tabs'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'worker.js' },
    }),
  );
  await writeFile(
    join(extension, 'worker.js'),
    'chrome.runtime.onInstalled.addListener(() => {});',
  );
  const context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: process.platform === 'win32' ? 'msedge' : 'chromium',
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--window-size=1920,1080',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? (await context.newPage());
    await mockLayoutAdmin(page);
    const measurements = [];
    for (const route of ['/inventory', '/warehouse-inbound']) {
      await page.goto(`http://127.0.0.1:4175${route}`);
      await expect(
        page.locator(
          route === '/inventory' ? '.warehouse-stock-table tbody tr' : '.document-history tbody tr',
        ),
      ).toHaveCount(route === '/inventory' ? 24 : 4);
      for (const factor of [1, 1.25, 1.5]) {
        const actual = await worker.evaluate(async (factor) => {
          const tabs = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(query: { url: string }): Promise<{ id: number }[]>;
                  setZoom(id: number, factor: number): Promise<void>;
                  getZoom(id: number): Promise<number>;
                };
              };
            }
          ).chrome.tabs;
          const [tab] = await tabs.query({ url: 'http://127.0.0.1/*' });
          if (!tab) throw new Error('Local test tab not found');
          await tabs.setZoom(tab.id, factor);
          return tabs.getZoom(tab.id);
        }, factor);
        expect(actual).toBe(factor);
        await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(factor, 2);
        const metrics = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
        measurements.push({ route, zoom: actual, ...metrics });
        await page.screenshot({
          path: testInfo.outputPath(`${route.slice(1)}-zoom-${factor}.png`),
          animations: 'disabled',
        });
      }
    }
    await testInfo.attach('actual-browser-zoom', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await context.close();
    await rm(temporary, { recursive: true });
  }
});

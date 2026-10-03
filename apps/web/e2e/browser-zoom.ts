import { chromium, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Real browser zoom (chrome.tabs.setZoom through a throwaway extension), not a viewport change or
 * CSS transform: the page sees devicePixelRatio and CSS-pixel widths exactly as a user zooming.
 */
export async function withBrowserZoom(
  testInfo: TestInfo,
  run: (page: Page, setZoom: (factor: number) => Promise<number>) => Promise<void>,
) {
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
    ...testInfo.project.use.launchOptions,
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
    const setZoom = async (factor: number) => {
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
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(factor, 2);
      return actual;
    };
    await run(page, setZoom);
  } finally {
    await context.close();
    await rm(temporary, { recursive: true });
  }
}

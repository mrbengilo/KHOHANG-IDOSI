import { expect, test } from '@playwright/test';
import { withBrowserZoom } from './browser-zoom';
import { mockLayoutAdmin } from './layout-fixtures';
import { measureTableLayout, tableLayoutViolations } from './table-layout-metrics';

test('real browser zoom keeps inventory and merged inbound documents usable', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.skip(
    testInfo.project.name !== 'desktop-1440',
    'Browser zoom applies to the desktop browser only.',
  );
  await withBrowserZoom(testInfo, async (page, setZoom) => {
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
        const actual = await setZoom(factor);
        expect(actual).toBe(factor);
        const metrics = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
        // Tables stay centred, left aligned and scrollable to the last column at real zoom.
        const tables = await measureTableLayout(page);
        expect(tableLayoutViolations(tables), `${route} zoom ${factor}`).toEqual([]);
        measurements.push({ route, zoom: actual, ...metrics, tables: tables.tables });
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
  });
});

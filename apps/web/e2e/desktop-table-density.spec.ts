import { expect, test } from '@playwright/test';
import { mockLayoutAdmin } from './layout-fixtures';

for (const route of ['/inventory', '/warehouse-inbound']) {
  test(`table content measurements ${route}`, async ({ page }, testInfo) => {
    await mockLayoutAdmin(page);
    await page.goto(route);
    const table = page.locator(
      route === '/inventory' ? '.warehouse-stock-panel table' : '.document-history table',
    );
    await expect(table.locator('tbody tr')).toHaveCount(route === '/inventory' ? 24 : 4);
    const measurements = [];
    const widths =
      testInfo.project.name === 'desktop-1440'
        ? [821, 1024, 1366, 1440, 1920, 2560]
        : [360, 390, 412, 768, 819, 820];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const measurement = await table.evaluate((element) => {
        const cells = Array.from(element.querySelectorAll('tbody tr:first-child td'));
        return {
          viewport: innerWidth,
          dpr: devicePixelRatio,
          tableWidth: element.getBoundingClientRect().width,
          firstRowHeight: element.querySelector('tbody tr')!.getBoundingClientRect().height,
          visibleRows: Array.from(element.querySelectorAll('tbody tr')).filter((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= innerHeight;
          }).length,
          rows: element.querySelectorAll('tbody tr').length,
          cells: cells.map((cell) => {
            const box = cell.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const content = range.getBoundingClientRect();
            const style = getComputedStyle(cell);
            return {
              x: box.x,
              width: box.width,
              contentX: content.x,
              contentRight: content.right,
              font: style.fontSize,
              text: cell.textContent,
              align: style.textAlign,
            };
          }),
        };
      });
      measurements.push(measurement);
      if (width >= 1366) {
        const numeric =
          route === '/inventory' ? measurement.cells.slice(1) : measurement.cells.slice(4, 6);
        for (const cell of numeric) {
          // Numbers align left like every other column (docs/responsive-table-layout-audit.md).
          expect(cell.align).toBe('left');
          expect(cell.width).toBeLessThanOrEqual(route === '/inventory' ? 150 : 110);
        }
        expect(measurement.firstRowHeight).toBeLessThanOrEqual(route === '/inventory' ? 65 : 130);
        expect(measurement.rows).toBe(route === '/inventory' ? 24 : 4);
        expect(parseFloat(measurement.cells[0].font)).toBeGreaterThanOrEqual(
          route === '/inventory' ? 14 : 13,
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      if ([390, 1920, 2560].includes(width))
        await page.screenshot({
          path: testInfo.outputPath(`table-${width}.png`),
          fullPage: true,
          animations: 'disabled',
        });
    }
    if (testInfo.project.name === 'desktop-1440') {
      for (const [width, height] of [
        [1366, 768],
        [1920, 1080],
        [2560, 1440],
      ] as const) {
        await page.setViewportSize({ width, height });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width + 1,
        );
        await page.screenshot({
          path: testInfo.outputPath(`exact-${width}-${height}.png`),
          animations: 'disabled',
        });
      }
    }
    await testInfo.attach('table-measurements', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  });
}

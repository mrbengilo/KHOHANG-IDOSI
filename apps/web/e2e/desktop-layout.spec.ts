import { expect, test, type Page } from '@playwright/test';
import { expectedGutter } from './desktop-gutter';
import { layoutProducts, mockLayoutAdmin } from './layout-fixtures';

const desktop = [
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [1281, 800],
  [1280, 800],
  [1279, 800],
  [1100, 800],
  [1024, 768],
  [821, 900],
];
const mobile = [
  [360, 800],
  [390, 844],
  [412, 915],
  [768, 1024],
  [819, 900],
  [820, 900],
];

async function expectContained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    (page.viewportSize()?.width ?? 0) + 1,
  );
  // Check actual boxes as well: overflow:hidden could otherwise hide a regression.
  const escaped = await page
    .locator('.page-header, .panel, .bag-picker__row, .bag-picker__stepper')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
        })
        .map((element) => element.className),
    );
  expect(escaped).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await mockLayoutAdmin(page);
});

for (const route of ['/warehouse-inbound', '/inventory']) {
  test(`fluid production workspace ${route}`, async ({ page }, testInfo) => {
    const inbound = route === '/warehouse-inbound';
    await page.goto(route);
    const panel = page.locator(inbound ? '.warehouse-inbound-form' : '.warehouse-stock-panel');
    await expect(panel).toBeVisible();
    const rows = page.locator(inbound ? '.bag-picker__item' : '.warehouse-stock-panel tbody tr');
    await expect(rows).toHaveCount(24);
    if (inbound) {
      await page.getByRole('checkbox').first().check();
      await page.getByLabel('Nhà cung cấp', { exact: true }).fill('Nhà cung cấp kiểm thử bố cục');
    }
    const measurements = [];
    const sizes = testInfo.project.name === 'desktop-1440' ? desktop : mobile;
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await expectContained(page);
      const main = await page.locator('.app-main').boundingBox();
      const box = (await panel.boundingBox())!;
      const header = (await page.locator('.page-header').boundingBox())!;
      if (width > 820) {
        const sidebar = (await page.locator('.sidebar').boundingBox())!;
        expect(main!.x).toBe(sidebar.width);
        // Gutters are measured after the sidebar and against the real client width.
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
        const leftGap = box.x - sidebar.width;
        const rightGap = clientWidth - box.x - box.width;
        const gutter = expectedGutter(width)!;
        expect(Math.abs(leftGap - gutter), `left gutter @${width}`).toBeLessThanOrEqual(2);
        expect(Math.abs(rightGap - gutter), `right gutter @${width}`).toBeLessThanOrEqual(2);
        expect(Math.abs(leftGap - rightGap), `symmetric gutters @${width}`).toBeLessThanOrEqual(2);
        if (width >= 1280) expect(leftGap).toBeCloseTo(54, 0);
        // 1440 → 1108px, 1920 → 1588px: full-width panels fill the space between gutters.
        expect(
          Math.abs(box.width - (clientWidth - sidebar.width - 2 * gutter)),
        ).toBeLessThanOrEqual(2);
        expect(box.x).toBe(header.x);
        expect(box.width).toBe(header.width);
      } else {
        expect(main!.x).toBe(0);
        const menu = page.getByRole('button', { name: 'Mở menu' });
        await menu.click();
        await expect(page.locator('.sidebar')).toHaveClass(/sidebar--open/);
        await page.locator('.sidebar-backdrop').click({ position: { x: width - 10, y: 300 } });
        await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar--open/);
      }
      if (inbound) {
        const row = rows.first();
        const choice = (await row.getByRole('checkbox').boundingBox())!;
        const stepper = (await row.getByRole('spinbutton').boundingBox())!;
        expect(stepper.x - choice.x).toBeLessThan(360);
        expect(
          Math.abs(choice.y + choice.height / 2 - stepper.y - stepper.height / 2),
        ).toBeLessThan(2);
        const submit = page.getByRole('button', { name: 'Xác nhận nhập kho tổng', exact: true });
        await submit.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(submit).toBeFocused();
        await expect(submit).toBeInViewport();
        if (width <= 820) expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.evaluate(() => scrollTo(0, 0));
      measurements.push({
        width,
        height,
        gutter: expectedGutter(width),
        panelWidth: box.width,
        pageHeight: await page.evaluate(() => document.documentElement.scrollHeight),
        rows: await rows.count(),
      });
      if ([390, 1920].includes(width))
        await page.screenshot({
          path: testInfo.outputPath(`${inbound ? 'inbound' : 'inventory'}-${width}.png`),
          animations: 'disabled',
          fullPage: true,
        });
    }
    await testInfo.attach('layout-measurements', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  });
}

test('inbound loading, empty and error states preserve the workspace', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/products?*', async (route) => {
    await pending;
    await route.fulfill({
      json: { data: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } },
    });
  });
  await page.goto('/warehouse-inbound');
  await expect(page.getByText('Đang tải mặt hàng…', { exact: true })).toBeVisible();
  await expectContained(page);
  release();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.route('**/api/v1/products?*', (route) =>
    route.fulfill({ status: 500, json: { message: 'Fixture failure' } }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Thử lại danh mục' })).toBeVisible();
  await expectContained(page);
  await page.route('**/api/v1/products?*', (route) =>
    route.fulfill({
      json: {
        data: layoutProducts,
        pagination: { page: 1, pageSize: 50, totalItems: 24, totalPages: 1 },
      },
    }),
  );
  await page.getByRole('button', { name: 'Thử lại danh mục' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(24);
});

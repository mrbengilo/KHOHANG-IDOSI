import { expect, test, type Page } from '@playwright/test';
import { mockLayoutAdmin } from './layout-fixtures';
import {
  measureTableLayout,
  tableLayoutViewports,
  tableLayoutViolations,
} from './table-layout-metrics';

test.beforeEach(async ({ page }) => {
  await mockLayoutAdmin(page);
});

/**
 * Synthetic primitive inside the real workspace: the shared wrapper class with a table whose
 * column count grows. Budgets were fixed before the fix: a short table equals its max-content
 * width (±1px) at every desktop width, and adding columns never shrinks the table.
 */
async function mountSyntheticTable(page: Page, columns: number, rows = 3) {
  await page.evaluate(
    ({ columns, rows }) => {
      document.querySelector('#table-layout-probe')?.remove();
      const host = document.querySelector('.app-main .panel')!;
      const wrapper = document.createElement('div');
      wrapper.id = 'table-layout-probe';
      wrapper.className = 'responsive-table';
      const header = Array.from({ length: columns }, (_, index) => `<th>Cột ${index + 1}</th>`);
      const body = Array.from(
        { length: rows },
        (_, row) =>
          `<tr>${Array.from(
            { length: columns },
            (_, index) =>
              `<td data-label="Cột ${index + 1}">${index === 0 ? `Mặt hàng ${row + 1}` : `${(row + 1) * (index + 1) * 1000} kg`}</td>`,
          ).join('')}</tr>`,
      );
      wrapper.innerHTML = `<table><thead><tr>${header.join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`;
      host.prepend(wrapper);
    },
    { columns, rows },
  );
  return page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('#table-layout-probe')!;
    const table = wrapper.querySelector('table')!;
    const clone = table.cloneNode(true) as HTMLTableElement;
    // Same container and inherited font as the real table, sized to its max-content width.
    clone.style.cssText = 'position:absolute;visibility:hidden;width:max-content';
    wrapper.parentElement!.append(clone);
    const natural = clone.getBoundingClientRect().width;
    clone.remove();
    return {
      natural,
      width: table.getBoundingClientRect().width,
      wrapper: wrapper.getBoundingClientRect().width,
      overflowing: wrapper.scrollWidth > wrapper.clientWidth + 1,
    };
  });
}

test('short tables keep their content width; wide tables grow then scroll locally', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop sizing primitive');
  await page.goto('/inventory');
  await expect(page.locator('.warehouse-stock-panel tbody tr')).toHaveCount(24);
  const compact = [];
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
  ] as const) {
    await page.setViewportSize({ width, height });
    const probe = await mountSyntheticTable(page, 3);
    compact.push(probe);
    expect(Math.abs(probe.width - probe.natural)).toBeLessThanOrEqual(1);
    expect(probe.wrapper).toBeLessThan(width / 2);
  }
  expect(Math.max(...compact.map((probe) => probe.width))).toBeLessThanOrEqual(
    Math.min(...compact.map((probe) => probe.width)) + 1,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const growth = [];
  for (let columns = 2; columns <= 40; columns += 2) {
    const probe = await mountSyntheticTable(page, columns);
    const layout = await measureTableLayout(page);
    expect(tableLayoutViolations(layout), `${columns} columns`).toEqual([]);
    growth.push({ columns, ...probe });
  }
  for (const [index, probe] of growth.entries())
    if (index) expect(probe.width).toBeGreaterThanOrEqual(growth[index - 1]!.width);
  const fitting = growth.filter((probe) => !probe.overflowing);
  const scrolling = growth.filter((probe) => probe.overflowing);
  expect(fitting.length).toBeGreaterThan(3);
  expect(scrolling.length).toBeGreaterThan(0);
  // Before the wrapper limit the table grows with its columns; after it the scrollport stays put.
  expect(fitting.at(-1)!.width).toBeGreaterThan(fitting[0]!.width * 3);
  for (const probe of scrolling) expect(probe.wrapper).toBe(scrolling[0]!.wrapper);
  await testInfo.attach('table-growth', {
    body: JSON.stringify({ compact, growth }, null, 2),
    contentType: 'application/json',
  });
});

for (const route of ['/inventory', '/warehouse-inbound']) {
  test(`fixture tables are centred and left aligned at every viewport ${route}`, async ({
    page,
  }, testInfo) => {
    await page.goto(route);
    const rows = route === '/inventory' ? 24 : 4;
    const table = page.locator(
      route === '/inventory' ? '.warehouse-stock-panel table' : '.document-history table',
    );
    await expect(table.locator('tbody tr')).toHaveCount(rows);
    const reference = await table.textContent();
    const measurements = [];
    const sizes = tableLayoutViewports.filter(([width]) =>
      testInfo.project.name === 'desktop-1440' ? width > 820 : width <= 820,
    );
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      const layout = await measureTableLayout(page);
      expect(tableLayoutViolations(layout), `${route} ${width}`).toEqual([]);
      expect(await table.textContent()).toBe(reference);
      await expect(table.locator('tbody tr')).toHaveCount(rows);
      measurements.push({ width, height, ...layout });
      if ([390, 1920].includes(width))
        await page.screenshot({
          path: testInfo.outputPath(`${route.slice(1)}-${width}.png`),
          animations: 'disabled',
          fullPage: true,
        });
    }
    await testInfo.attach('fixture-table-layout', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  });
}

test('wide history scrolls inside its region by keyboard and keeps the page still', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'needs a viewport narrower than the table');
  await page.goto('/warehouse-inbound');
  const region = page.getByRole('region', { name: 'Lịch sử nhập kho tổng' });
  await expect(region.locator('tbody tr')).toHaveCount(4);
  const before = await region.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    overflowing: element.scrollWidth > element.clientWidth + 1,
  }));
  expect(before.overflowing).toBe(true);
  await region.focus();
  await page.keyboard.press('End');
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowRight');
  const after = await region.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    max: element.scrollWidth - element.clientWidth,
  }));
  expect(after.scrollLeft).toBeGreaterThan(0);
  expect(after.scrollLeft).toBeGreaterThanOrEqual(after.max - 1);
  const last = await region.locator('thead th').last().boundingBox();
  const port = await region.boundingBox();
  expect(last!.x + last!.width).toBeLessThanOrEqual(port!.x + port!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test('lazy feature CSS order and the mobile menu do not move the tables', async ({
  page,
}, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-390';
  const snapshot = async () =>
    (await measureTableLayout(page)).tables.map(({ id, gapLeft, gapRight, visibleWidth }) => ({
      id,
      gapLeft,
      gapRight,
      visibleWidth,
    }));
  await page.goto('/inventory');
  await expect(page.locator('.warehouse-stock-panel tbody tr')).toHaveCount(24);
  const direct = await snapshot();
  // Visit routes whose feature stylesheets load later, then come back through the menu.
  for (const name of ['Nhập kho tổng', 'Tồn kho / Lịch sử']) {
    if (mobile) await page.getByRole('button', { name: 'Mở menu' }).click();
    await page.locator('.sidebar').getByRole('link', { name, exact: true }).click();
    await page.waitForLoadState('networkidle');
  }
  await expect(page.locator('.warehouse-stock-panel tbody tr')).toHaveCount(24);
  expect(await snapshot()).toEqual(direct);
  expect(tableLayoutViolations(await measureTableLayout(page))).toEqual([]);
});

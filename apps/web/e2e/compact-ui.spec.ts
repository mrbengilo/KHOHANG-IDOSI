import { test, expect } from '@playwright/test';

test('admin menu and branding match the warehouse role', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
  for (const name of ['Đặt hàng', 'Nhận hàng', 'Khui kiện']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await expect(nav.getByRole('link', { name: 'Nhập kho tổng' })).toHaveCount(1);
  const adminGroup = nav.getByRole('group', { name: 'Quản trị' });
  await expect(adminGroup.getByRole('link').last()).toHaveText('Nhật ký hệ thống');
  await expect(nav.getByRole('link', { name: 'Audit', exact: true })).toHaveCount(0);
  const selected = nav.getByRole('link', { name: 'Tổng quan', exact: true });
  await expect(selected).toHaveAttribute('aria-current', 'page');
  const selectedStyle = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, color: style.borderTopColor };
  });
  expect(selectedStyle.border).toBe('1px');
  expect(selectedStyle.color).not.toBe('rgba(0, 0, 0, 0)');
  const iconColors = await nav
    .locator('a svg')
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
  expect(new Set(iconColors).size).toBeGreaterThanOrEqual(3);
  const logo = page.locator('.sidebar .app-logo');
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
  expect((await page.request.get(favicon!)).ok()).toBe(true);
});

test('product checkbox, name and quantity remain compact on the same row', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('idosi-demo-role:v2', 'HTKD'));
  await page.goto('/requests');
  await page.getByRole('checkbox').first().check();
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator('.bag-picker__row').first();
    const checkbox = (await row.getByRole('checkbox').boundingBox())!;
    const quantity = (await row.getByRole('spinbutton').boundingBox())!;
    expect(
      Math.abs(checkbox.y + checkbox.height / 2 - quantity.y - quantity.height / 2),
    ).toBeLessThan(2);
    expect(quantity.x - checkbox.x).toBeLessThan(310);
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(72);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const overflow = await page
      .locator('.panel, .bag-picker__item')
      .evaluateAll(
        (elements) => elements.filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      );
    expect(overflow).toBe(0);
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: testInfo.outputPath(`compact-orders-${width}.png`),
        fullPage: true,
      });
  }
  await page.getByRole('button', { name: /^Tăng số bao/ }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
});

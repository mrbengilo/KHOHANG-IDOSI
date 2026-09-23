import { expect, test } from '@playwright/test';

test('store selects a product and short bag code before opening one bag', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('idosi-demo-role:v2', 'STORE_RETAIL'));
  await page.goto('/open-bag');
  if (testInfo.project.name === 'mobile-390') {
    const title = (await page.getByRole('heading', { name: 'Khui kiện' }).boundingBox())!;
    const menu = (await page.locator('.mobile-menu-trigger').boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(menu.x + menu.width);
  }

  const product = page.getByLabel('Mặt hàng');
  const bag = page.getByLabel('Bao khả dụng');
  await expect(bag).toBeDisabled();
  await product.selectOption('dam');
  await bag.selectOption('MB-00001');
  await expect(page.getByText('Thao tác áp dụng cho bao MB-00001.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('open-bag-selected.png'), fullPage: true });
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const fields = page.locator('.open-bag-fields');
    expect(await fields.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Khui 1 bao' }).click();
  await expect(page.getByText('2 bao chưa khui trong phạm vi đang xem')).toBeVisible();
  await expect(bag.locator('option[value="MB-00001"]')).toHaveCount(0);
});

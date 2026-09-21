import { expect, test } from '@playwright/test';

test('admin warehouse inventory reconciles with PostgreSQL balances and remains responsive', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  const inventoryResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/warehouse-inventory'),
  );
  await page.getByRole('link', { name: 'Tồn kho / Lịch sử', exact: true }).click();
  const response = await inventoryResponse;
  expect(response.ok()).toBe(true);
  const inventory = await response.json();
  const balancesResponse = await page.request.get(
    'http://127.0.0.1:3100/api/v1/warehouse-balances',
  );
  expect(balancesResponse.ok()).toBe(true);
  const balances = (await balancesResponse.json()).data;
  for (const row of inventory.data) {
    const balance = balances.find(
      (entry: { productId: string }) => entry.productId === row.productId,
    );
    expect(row.availableBags).toBe(balance.available.quantity);
    expect(row.reservedBags).toBe(balance.reserved.quantity);
    expect(row.onHandBags).toBe(row.availableBags + row.reservedBags);
    expect(row.dispatchedBags).toBeGreaterThanOrEqual(0);
  }
  await expect(page.getByRole('heading', { name: 'Tồn kho tổng & lịch sử xuất' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lịch sử phiếu xuất kho tổng' })).toBeVisible();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`warehouse-inventory-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.getByLabel('Tìm mặt hàng kho tổng').fill('nonexistent-product-xyz');
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(page.getByText('Không có mặt hàng phù hợp.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

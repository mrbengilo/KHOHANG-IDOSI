import { expect, test } from '@playwright/test';
import { tabApi } from './tab-api';

test('admin warehouse inventory reconciles with PostgreSQL balances and remains responsive', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu', { exact: true })
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  const requested: string[] = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  const inventoryResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/warehouse-inventory'),
  );
  await page.getByRole('link', { name: 'Tồn kho / Lịch sử', exact: true }).click();
  const response = await inventoryResponse;
  expect(response.ok()).toBe(true);
  const inventory = await response.json();
  const balancesResponse = await tabApi(page).get(
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
  await expect(page.getByRole('heading', { name: 'Tồn kho & lịch sử', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('tablist', { name: 'Phạm vi tồn kho' }).getByRole('tab', { name: 'Kho tổng' }),
  ).toHaveAttribute('aria-selected', 'true');
  // Sub-tabs mount one at a time: the dispatch history and shortage checks load on demand.
  await expect(page.getByRole('region', { name: 'Lịch sử phiếu xuất kho tổng' })).toHaveCount(0);
  expect(requested.some((path) => path.endsWith('/warehouse-outbound-history'))).toBe(false);
  expect(requested.some((path) => path.includes('/warehouse-shortage-checks'))).toBe(false);
  const subTabs = page.getByRole('tablist', { name: 'Nội dung kho tổng' });
  await subTabs.getByRole('tab', { name: 'Lịch sử xuất' }).click();
  await expect(page.getByRole('region', { name: 'Lịch sử phiếu xuất kho tổng' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' })).toHaveCount(0);
  await expect(page).toHaveURL(/kt=history/);
  await subTabs.getByRole('tab', { name: 'Kiểm hàng thiếu' }).click();
  await expect(page.getByRole('region', { name: 'Hàng thiếu chờ kho xác nhận' })).toBeVisible();
  // Keyboard: arrows move between tabs and the URL follows.
  await subTabs.getByRole('tab', { name: 'Kiểm hàng thiếu' }).press('ArrowLeft');
  await expect(subTabs.getByRole('tab', { name: 'Tồn hiện tại' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' })).toBeVisible();
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

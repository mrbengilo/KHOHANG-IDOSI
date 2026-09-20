import { expect, test } from '@playwright/test';

test('IDOSI month changes replace summary and detail instead of retaining duplicate siblings', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('link', { name: 'Bán & đồng bộ', exact: true }).click();
  const store = page.getByRole('combobox', { name: 'Cửa hàng thống kê IDOSI', exact: true });
  await expect.poll(() => store.locator('option').count()).toBeGreaterThan(1);
  await store.selectOption({ index: 1 });
  const month = page.getByLabel('Kỳ thống kê IDOSI', { exact: true });
  const initialPeriod = await month.inputValue();
  const [year, numericMonth] = initialPeriod.split('-').map(Number);
  const previousPeriod = `${numericMonth === 1 ? year! - 1 : year}-${String(numericMonth === 1 ? 12 : numericMonth! - 1).padStart(2, '0')}`;
  for (const period of [previousPeriod, initialPeriod, previousPeriod, initialPeriod]) {
    await month.fill(period);
    const summary = page.getByRole('region', {
      name: 'Doanh thu & hàng đã bán · IDOSI',
      exact: true,
    });
    const detail = page.getByRole('region', { name: 'Thống kê đơn hàng IDOSI', exact: true });
    await expect(summary).toHaveCount(1);
    await expect(detail).toHaveCount(1);
    await expect(summary).toContainText(`Kỳ ${period}`);
    await expect(detail).toContainText(`Kỳ thống kê: ${period}`);
  }
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
});

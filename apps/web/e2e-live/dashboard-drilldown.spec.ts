import { expect, test } from '@playwright/test';

test('default reporting periods stay stable across the Vietnam month boundary', async ({
  page,
}) => {
  await page.clock.setSystemTime(new Date('2026-08-31T16:59:00Z'));
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByLabel('Kỳ báo cáo dashboard')).toHaveValue('2026-08');
  const dashboardScope = page.getByLabel('Phạm vi cửa hàng dashboard');
  await expect.poll(() => dashboardScope.locator('option').count()).toBeGreaterThan(1);
  await page.clock.setSystemTime(new Date('2026-08-31T17:01:00Z'));
  await dashboardScope.selectOption({ index: 1 });
  await expect(page).toHaveURL(/scope=/);
  await expect(page.getByLabel('Kỳ báo cáo dashboard')).toHaveValue('2026-08');

  await page.goto('/reports');
  await expect(page.getByLabel('Kỳ báo cáo', { exact: true })).toHaveValue('2026-09');
  const reportScope = page.getByLabel('Phạm vi báo cáo', { exact: true });
  await expect.poll(() => reportScope.locator('option').count()).toBeGreaterThan(1);
  await page.clock.setSystemTime(new Date('2026-09-30T17:01:00Z'));
  await reportScope.selectOption({ index: 1 });
  await expect(page).toHaveURL(/scope=/);
  await expect(page.getByLabel('Kỳ báo cáo', { exact: true })).toHaveValue('2026-09');
});

test('dashboard report drill-down preserves month and store across reload and Back', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  const scope = page.getByLabel('Phạm vi cửa hàng dashboard');
  await expect.poll(() => scope.locator('option').count()).toBeGreaterThan(1);
  const [storeId] = await scope.selectOption({ index: 1 });
  expect(storeId).toBeTruthy();
  await expect(scope).toHaveValue(storeId!);
  await expect(page).toHaveURL(new RegExp(`scope=${storeId}`));
  await page.getByLabel('Kỳ báo cáo dashboard').fill('2024-02');
  await expect(page).toHaveURL(/period=2024-02/);
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith('/reports/monthly') &&
      url.searchParams.get('scopeId') === storeId &&
      url.searchParams.get('year') === '2024'
    );
  });
  await page.getByRole('button', { name: 'Xem báo cáo', exact: true }).click();
  await expect(page.getByLabel('Kỳ báo cáo', { exact: true })).toHaveValue('2024-02');
  await expect(page.getByLabel('Phạm vi báo cáo', { exact: true })).toHaveValue(storeId!);
  expect((await response).ok()).toBe(true);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const heading = await page.locator('.page-header h1').boundingBox();
    const actions = await page.locator('.page-header__actions').boundingBox();
    expect(heading!.x + heading!.width).toBeLessThanOrEqual(actions!.x);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`report-drilldown-${width}.png`),
    });
  }
  await page.reload();
  await expect(page.getByLabel('Kỳ báo cáo', { exact: true })).toHaveValue('2024-02');
  await expect(page.getByLabel('Phạm vi báo cáo', { exact: true })).toHaveValue(storeId!);
  await page.goBack();
  await expect(page.getByLabel('Kỳ báo cáo dashboard')).toHaveValue('2024-02');
  await expect(page.getByLabel('Phạm vi cửa hàng dashboard')).toHaveValue(storeId!);
});

import { expect, test } from '@playwright/test';
import { createDatabase } from '@idosi/database';
import { createInboundStatisticsFixture } from '../../../packages/database/tests/fixtures/inbound-statistics';
import { tabApi } from './tab-api';

test('Admin browser to API to PostgreSQL reconciles original warehouse and partner receipts', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires dedicated live test PostgreSQL');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  try {
    const fixture = await createInboundStatisticsFixture(client.db);
    await page.goto('/');
    await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
    await page
      .getByLabel('Mật khẩu', { exact: true })
      .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Đăng xuất', exact: true })).toBeVisible();
    await page.goto('/inbound-statistics');
    await expect(
      page.getByRole('heading', { name: 'Thống kê nhập hàng', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Tháng', { exact: true }).fill('2026-09');
    await page
      .getByRole('combobox', { name: 'Cửa hàng', exact: true })
      .selectOption(fixture.stores[0]!.id);
    await expect(page.locator('.inbound-overview')).toContainText('58 bao · 700 kg');
    await expect(page.locator('.inbound-overview')).toContainText('50 bao · 600 kg');
    await expect(page.locator('.inbound-overview')).toContainText('8 bao · 100 kg');
    await page
      .getByRole('combobox', { name: 'Chi tiết theo nguồn', exact: true })
      .selectOption('PARTNER');
    await expect(page.locator('.inbound-overview')).toContainText('58 bao · 700 kg');
    await expect(page.getByLabel('Bảng mặt hàng').locator('tfoot')).toContainText('8');
    const api = tabApi(page);
    const response = await api.get(
      `http://127.0.0.1:3100/api/v1/reports/inbound-statistics?month=2026-09&storeId=${fixture.stores[0]!.id}`,
    );
    expect(response.status()).toBe(200);
    const { data } = await response.json();
    expect(data.overviewAllSources.total.weightGrams).toBe('700000');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`inbound-live-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page
      .getByRole('combobox', { name: 'Loại cửa hàng', exact: true })
      .selectOption('WHOLESALE');
    await page
      .getByRole('combobox', { name: 'Cửa hàng', exact: true })
      .selectOption(fixture.stores[2]!.id);
    await expect(page.locator('.inbound-overview')).toContainText('30 bao · 500 kg');
    await expect(page.locator('.inbound-overview')).toContainText('0 bao · 0 kg');
    await page.getByRole('combobox', { name: 'Kỳ thống kê', exact: true }).selectOption('DAY');
    await page.getByLabel('Ngày', { exact: true }).fill('2026-09-15');
    await expect(page.locator('.inbound-overview')).toContainText('30 bao · 500 kg');
  } finally {
    await client.close();
  }
});

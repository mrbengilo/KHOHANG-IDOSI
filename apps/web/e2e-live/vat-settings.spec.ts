import { expect, test } from '@playwright/test';
import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';
test('Admin persists VAT, sees its audit history and a responsive configuration form', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu', { exact: true })
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const initial = (await (await tabApi(page).get(`${api}/admin/operational-settings`)).json()).data
    .current;
  const update = async (rate: number) => {
    const current = (await (await tabApi(page).get(`${api}/admin/operational-settings`)).json())
      .data.current;
    const {
      timezone,
      snapshotTime,
      cutoffTime,
      maxRequestsPerStore,
      policyVersion,
      idosiSyncIntervalMinutes,
    } = current;
    return tabApi(page).put(`${api}/admin/operational-settings`, {
      data: {
        timezone,
        snapshotTime,
        cutoffTime,
        maxRequestsPerStore,
        policyVersion,
        idosiSyncIntervalMinutes,
        expectedVersion: current.version,
        vatRatePercent: rate,
      },
    });
  };
  try {
    await page.goto('/settings');
    const rate = page.getByLabel('Thuế suất (%)');
    await expect(rate).toHaveValue(String(initial.vatRatePercent));
    await rate.fill('10');
    await page.getByRole('button', { name: 'Lưu phiên bản mới' }).click();
    await expect(page.getByText(/Đã lưu cấu hình phiên bản/)).toBeVisible();
    await page.reload();
    await expect(rate).toHaveValue('10');
    await expect(page.getByRole('region', { name: 'Lịch sử phiên bản' })).toContainText('10%');
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 390 || width === 1440) {
        await rate.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`vat-settings-${width}.png`),
          fullPage: false,
        });
      }
    }
    expect((await update(0)).status()).toBe(200);
    await page.reload();
    await expect(rate).toHaveValue('0');
  } finally {
    expect((await update(initial.vatRatePercent)).status()).toBe(200);
  }
});

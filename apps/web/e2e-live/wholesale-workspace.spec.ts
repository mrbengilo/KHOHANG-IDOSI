import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { tabApi } from './tab-api';

const apiOrigin = 'http://127.0.0.1:3100';
const adminUsername = process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin';
const adminPassword =
  process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production';

test('wholesale desk can load its overview, order form and receiving workspace', async ({
  page,
  context,
}) => {
  const adminPage = await context.newPage();
  await adminPage.goto('/login');
  await adminPage.getByLabel('Tên đăng nhập').fill(adminUsername);
  await adminPage.getByLabel('Mật khẩu', { exact: true }).fill(adminPassword);
  await adminPage.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(adminPage.getByRole('heading', { name: 'Tổng quan điều hành' })).toBeVisible();

  const username = `wholesale.e2e.${randomUUID()}@example.test`;
  const password = 'wholesale-e2e-password-2026!';
  const created = await tabApi(adminPage).post(`${apiOrigin}/api/v1/admin/accounts`, {
    data: { username, displayName: 'Wholesale E2E', password, role: 'WHOLESALE' },
  });
  expect(created.status()).toBe(201);
  const account = (await created.json()) as { data: { id: string; sessionVersion: number } };
  try {
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(username);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.getByRole('heading', { name: 'Tổng quan cửa hàng sỉ' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Đặt hàng và thực nhận theo mặt hàng' }),
    ).toBeVisible();
    await expect(page.getByText('Không thể tải dashboard')).toHaveCount(0);

    // Wholesale stores order on the same screen as retail stores.
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'Đặt hàng & kết quả' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Phiếu chờ và lượt ưu tiên' })).toBeVisible();

    await page.goto('/receive');
    await expect(page.getByRole('heading', { name: 'Xác nhận nhận hàng' })).toBeVisible();
    await expect(page.getByText('Bạn không có quyền thực hiện thao tác này')).toHaveCount(0);
    await expect(page.locator('.receipt-scope select')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Khai phiếu nhận hàng' })).toBeVisible();
    await expect(page.locator('.receipt-source-count')).toContainText('phiếu chờ nhận hàng');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tổng quan cửa hàng sỉ' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await tabApi(adminPage).patch(`${apiOrigin}/api/v1/admin/accounts/${account.data.id}`, {
      data: { status: 'DISABLED', expectedSessionVersion: account.data.sessionVersion },
    });
    await adminPage.close();
  }
});

import { expect, test } from '@playwright/test';

test('admin can review the dashboard and updated product catalog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Tổng quan/i })).toBeVisible();

  await page.getByRole('link', { name: 'Danh mục & quy đổi' }).click();
  await expect(page.getByRole('heading', { name: 'Danh mục & quy đổi bán hàng' })).toBeVisible();
  await expect(page.getByText('25/25 mặt hàng')).toBeVisible();
  await expect(page.getByText('1 cái × 3 = 3,000 kg')).toBeVisible();
});

test('mobile navigation remains usable at 390px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await page.goto('/');
  await page.getByRole('button', { name: 'Mở menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
  await page.getByRole('link', { name: 'Đặt hàng' }).click();
  await expect(page.getByRole('heading', { name: /Yêu cầu|Đặt hàng/i })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);

  const undersizedTargets = await page
    .locator('button:visible, a:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width < 44 || box.height < 44),
    );
  expect(undersizedTargets).toEqual([]);
});

test('wholesale routes fail closed for retail-only operations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/');
  await page.getByLabel('Chế độ kiểm thử vai trò').selectOption('STORE_WHOLESALE');
  await expect(page.getByRole('heading', { name: 'Tổng quan khách sỉ' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nhận hàng' })).toHaveCount(0);

  await page.goto('/receive');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Tổng quan khách sỉ' })).toBeVisible();
});

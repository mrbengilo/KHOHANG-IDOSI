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

test('catalog dialog traps focus, closes with Escape, and restores its trigger', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/catalog');
  const trigger = page.getByRole('button', { exact: true, name: 'Thêm mặt hàng' }).first();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Thêm mặt hàng và hệ số' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Mã SKU')).toBeFocused();

  const closeButton = dialog.getByRole('button', { name: 'Đóng' });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: /Lưu phiên bản/ })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('mobile navigation remains usable at 390px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await page.goto('/');
  await page.getByRole('button', { name: 'Mở menu' }).click();
  const primaryNavigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
  await expect(primaryNavigation).toBeVisible();
  await primaryNavigation.getByRole('link', { name: 'Đặt hàng' }).click();
  await expect(
    page.getByRole('heading', { exact: true, name: 'Đặt hàng & kết quả' }),
  ).toBeVisible();
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

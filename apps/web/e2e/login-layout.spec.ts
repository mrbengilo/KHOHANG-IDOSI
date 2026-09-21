import { expect, test } from '@playwright/test';

test('login is single-column with the requested slogan and required fields', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Đăng nhập Kho hàng IDOSI' })).toBeVisible();
  await expect(
    page.getByText('QUẢN LÝ & PHÂN BỔ HÀNG HÓA HỆ THỐNG IDOSI', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.login-visual')).toHaveCount(0);
  for (const label of ['Tên đăng nhập', 'Mật khẩu']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('required', '');
  }
  await expect(page.locator('.required-mark')).toHaveCount(2);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const form = (await page.locator('form').boundingBox())!;
    expect(Math.abs(form.x + form.width / 2 - width / 2)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  }
  await page.getByLabel('Tên đăng nhập', { exact: true }).focus();
  await expect(page.getByLabel('Tên đăng nhập', { exact: true })).toBeFocused();
  expect(
    await page.locator('.app-logo').evaluate((image: HTMLImageElement) => image.naturalWidth > 0),
  ).toBe(true);
});

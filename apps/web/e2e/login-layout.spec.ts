import { expect, test } from '@playwright/test';

test('login shows the brand panel on desktop and stacks on narrow screens', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Đăng nhập Kho hàng IDOSI' })).toBeVisible();
  await expect(
    page.getByText('QUẢN LÝ & PHÂN BỔ HÀNG HÓA HỆ THỐNG IDOSI', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.login-visual')).toHaveCount(1);
  for (const label of ['Tên đăng nhập', 'Mật khẩu']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('required', '');
  }
  await expect(page.locator('.required-mark')).toHaveCount(2);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const visual = (await page.locator('.login-visual').boundingBox())!;
    const form = (await page.locator('form').boundingBox())!;
    if (width <= 900) {
      // Một cột: dải thương hiệu nằm trên biểu mẫu, biểu mẫu căn giữa màn hình.
      expect(visual.y + visual.height).toBeLessThanOrEqual(form.y + 1);
      expect(Math.abs(form.x + form.width / 2 - width / 2)).toBeLessThan(2);
    } else {
      // Hai cột: dải thương hiệu bên trái, biểu mẫu nằm hẳn bên phải nó.
      expect(form.x).toBeGreaterThan(visual.x + visual.width - 1);
      expect(visual.height).toBeGreaterThan(400);
    }
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  }

  await page.getByLabel('Tên đăng nhập', { exact: true }).focus();
  await expect(page.getByLabel('Tên đăng nhập', { exact: true })).toBeFocused();
  expect(
    await page.locator('.app-logo').evaluate((image: HTMLImageElement) => image.naturalWidth > 0),
  ).toBe(true);
});

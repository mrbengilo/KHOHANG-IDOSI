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

  for (const [width, height] of [
    [375, 667],
    [768, 900],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const form = (await page.locator('form').boundingBox())!;
    if (width <= 620) {
      // Điện thoại: vừa một màn hình, không cuộn; thẻ đăng nhập nằm giữa theo cả hai chiều.
      await expect(page.locator('.login-visual')).toBeHidden();
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(pageHeight).toBeLessThanOrEqual(height);
      const panel = (await page.locator('.login-panel').boundingBox())!;
      expect(Math.abs(panel.x + panel.width / 2 - width / 2)).toBeLessThan(2);
      expect(Math.abs(panel.y + panel.height / 2 - height / 2)).toBeLessThan(2);
    } else if (width <= 900) {
      // Một cột: dải thương hiệu nằm trên biểu mẫu, biểu mẫu căn giữa màn hình.
      const visual = (await page.locator('.login-visual').boundingBox())!;
      expect(visual.y + visual.height).toBeLessThanOrEqual(form.y + 1);
      expect(Math.abs(form.x + form.width / 2 - width / 2)).toBeLessThan(2);
    } else {
      // Hai cột: dải thương hiệu bên trái, biểu mẫu nằm hẳn bên phải nó.
      const visual = (await page.locator('.login-visual').boundingBox())!;
      expect(form.x).toBeGreaterThan(visual.x + visual.width - 1);
      expect(visual.height).toBeGreaterThan(400);
    }
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`), fullPage: true });
  }

  await page.getByLabel('Tên đăng nhập', { exact: true }).focus();
  await expect(page.getByLabel('Tên đăng nhập', { exact: true })).toBeFocused();
  // Client-side login may mount after navigation's load event; wait for image decoding.
  await expect
    .poll(() =>
      page
        .locator('.app-logo')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
});

import { test, expect } from '@playwright/test';

test('Admin selects products and persists exactly the selected bags in the warehouse', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.getByRole('link', { name: 'Nhập kho tổng' }).click();
  const reference = `UI-IN-${Date.now()}-${testInfo.retry}`;
  await page.getByLabel('Mã phiếu nhập').fill(reference);
  await page.getByLabel('Nhà cung cấp').fill('Nhà cung cấp kiểm thử');
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /^Tăng số bao/ }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  await page.getByRole('button', { name: /^Giảm số bao/ }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('1');
  await page.getByRole('button', { name: /^Tăng số bao/ }).click();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('checkbox').nth(1).uncheck();
  await expect(page.getByRole('spinbutton')).toHaveCount(1);
  await page.getByLabel(/^Khối lượng bao 1/).fill('80.500');
  await page.getByLabel(/^Khối lượng bao 2/).fill('79.250');
  for (const width of [360, 390, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    const plus = await page.getByRole('button', { name: /^Tăng số bao/ }).boundingBox();
    expect(plus?.width).toBeGreaterThanOrEqual(44);
    expect(plus?.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath('warehouse-inbound-desktop.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('warehouse-inbound-selected-mobile.png'),
    animations: 'disabled',
    fullPage: true,
  });
  let failedInput: unknown;
  let failedKey: string | undefined;
  await page.route('**/api/v1/inbound-receipts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    failedInput = route.request().postDataJSON();
    failedKey = route.request().headers()['idempotency-key'];
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Xác nhận nhập kho tổng' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  await page.unroute('**/api/v1/inbound-receipts');
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/inbound-receipts' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Xác nhận nhập kho tổng' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual(failedInput);
  expect(response.request().headers()['idempotency-key']).toBe(failedKey);
  const receipt = (await response.json()).data;
  expect(receipt.bags).toHaveLength(2);
  expect(receipt.totalWeightKg).toBe('159.750');
  await expect(page.getByRole('status')).toContainText(`Đã nhập phiếu ${reference}`);
  await expect(page.getByRole('checkbox').first()).not.toBeChecked();
  const api = new URL(response.url()).origin;
  const stored = await page.request.get(`${api}/api/v1/inbound-receipts/${receipt.id}`);
  expect(stored.status()).toBe(200);
  expect((await stored.json()).data.bags).toEqual(receipt.bags);
  const replay = await page.request.post(response.url(), {
    data: response.request().postDataJSON(),
    headers: { 'idempotency-key': response.request().headers()['idempotency-key']! },
  });
  expect(replay.status()).toBe(201);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  expect((await replay.json()).data.id).toBe(receipt.id);
  await page.screenshot({
    path: testInfo.outputPath('warehouse-inbound-mobile.png'),
    fullPage: true,
  });
});

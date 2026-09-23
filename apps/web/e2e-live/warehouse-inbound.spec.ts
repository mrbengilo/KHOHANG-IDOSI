import { test, expect } from '@playwright/test';
import { tabApi } from './tab-api';

test('Admin selects products and persists exactly the selected bags in the warehouse', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu', { exact: true })
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.getByRole('link', { name: 'Nhập kho tổng' }).click();
  await expect(page.getByLabel('Mã phiếu nhập')).toHaveAttribute('readonly', '');
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
  await expect(page.getByLabel(/^Khối lượng bao/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Nhập VAT · 8%' }).click();
  await page.getByLabel('Số tiền VAT (VND)').fill('1000000');
  await expect(page.getByLabel('Thuế suất mặc định')).toHaveValue('8%');
  await page.getByRole('button', { name: 'Mặt hàng', exact: true }).click();
  for (const width of [360, 390, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    const plus = await page.getByRole('button', { name: /^Tăng số bao/ }).boundingBox();
    expect(plus?.width).toBeGreaterThanOrEqual(44);
    expect(plus?.height).toBeGreaterThanOrEqual(44);
    const checkbox = (await page.getByRole('checkbox').first().boundingBox())!;
    const quantity = (await page.getByRole('spinbutton').boundingBox())!;
    expect(
      Math.abs(checkbox.y + checkbox.height / 2 - quantity.y - quantity.height / 2),
    ).toBeLessThan(2);
    expect(quantity.x).toBeGreaterThan(checkbox.x + checkbox.width);
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
  const reference = receipt.referenceCode;
  expect(reference).toMatch(/^PN\d{5,}-\d{2}\/\d{2}\/\d{4}$/);
  expect(receipt.bags).toHaveLength(2);
  expect(receipt.totalWeightKg).toBeNull();
  expect(receipt.vat).toEqual({ amountVnd: 1000000, ratePercent: 8 });
  await expect(page.getByRole('status')).toContainText(`Đã nhập phiếu ${reference}`);
  await expect(page.getByRole('checkbox').first()).not.toBeChecked();
  const api = new URL(response.url()).origin;
  const stored = await tabApi(page).get(`${api}/api/v1/inbound-receipts/${receipt.id}`);
  expect(stored.status()).toBe(200);
  const storedReceipt = (await stored.json()).data;
  expect(storedReceipt.bags).toEqual(receipt.bags);
  expect(storedReceipt.vat).toEqual(receipt.vat);
  const replay = await tabApi(page).post(response.url(), {
    data: response.request().postDataJSON(),
    headers: { 'idempotency-key': response.request().headers()['idempotency-key']! },
  });
  expect(replay.status()).toBe(201);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  expect((await replay.json()).data.id).toBe(receipt.id);
  const historyRow = page.locator('article').filter({ hasText: reference });
  await historyRow.getByText('Cập nhật VAT · 8%', { exact: true }).click();
  // Refetch while a local edit exists must not silently adopt a newer version.
  await historyRow.getByLabel(`Số tiền VAT cho ${reference}`, { exact: true }).fill('999999');
  const external = await tabApi(page).patch(`${api}/api/v1/inbound-receipts/${receipt.id}/vat`, {
    headers: { 'idempotency-key': `external-vat-${receipt.id}` },
    data: {
      vat: { amountVnd: 1050000, ratePercent: 8 },
      expectedVersion: receipt.version,
      reason: 'Admin khác cập nhật hóa đơn',
    },
  });
  expect(external.status(), await external.text()).toBe(200);
  await page.getByRole('button', { name: 'Làm mới phiếu nhập' }).click();
  await expect(historyRow.getByRole('button', { name: 'Tải bản VAT mới' })).toBeVisible();
  await expect(historyRow.getByRole('button', { name: 'Lưu VAT', exact: true })).toBeDisabled();
  await expect(historyRow.getByLabel(`Số tiền VAT cho ${reference}`, { exact: true })).toHaveValue(
    '999999',
  );
  await historyRow.getByRole('button', { name: 'Tải bản VAT mới' }).click();
  await expect(historyRow.getByLabel(`Số tiền VAT cho ${reference}`, { exact: true })).toHaveValue(
    '1050000',
  );
  await historyRow.getByLabel(`Số tiền VAT cho ${reference}`, { exact: true }).fill('1100000');
  await historyRow
    .getByLabel(`Lý do cập nhật VAT cho ${reference}`, { exact: true })
    .fill('Điều chỉnh theo hóa đơn thuế');
  await historyRow.getByRole('button', { name: 'Lưu VAT', exact: true }).click();
  await expect(historyRow.getByRole('status')).toContainText('Đã lưu VAT 8%');
  const corrected = await tabApi(page).get(`${api}/api/v1/inbound-receipts/${receipt.id}`);
  expect((await corrected.json()).data.vat).toEqual({ amountVnd: 1100000, ratePercent: 8 });
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('warehouse-inbound-mobile.png'),
    fullPage: true,
  });
  // The PostgreSQL DTO must distinguish unknown tax from an explicitly entered zero.
  const deferred = await tabApi(page).post(`${api}/api/v1/inbound-receipts`, {
    headers: { 'idempotency-key': `deferred-${receipt.id}` },
    data: {
      referenceCode: `DEFERRED-${reference}`,
      supplierName: 'Kiểm thử VAT chưa có',
      receivedAt: new Date().toISOString(),
      bags: [
        { productId: receipt.bags[0].productId, bagCode: `D-${reference}`, weightKg: '2.000' },
      ],
    },
  });
  expect(deferred.status()).toBe(201);
  const deferredReceipt = (await deferred.json()).data;
  const confirmed = await tabApi(page).post(
    `${api}/api/v1/inbound-receipts/${deferredReceipt.id}/confirm-costs`,
    {
      headers: { 'idempotency-key': `confirm-deferred-${receipt.id}` },
      data: {
        expectedVersion: 0,
        productCosts: [{ productId: receipt.bags[0].productId, priceVndPerKg: 1000 }],
        transportationFeeVnd: 0,
        handlingFeeVnd: 0,
      },
    },
  );
  expect(confirmed.status()).toBe(200);
  expect((await confirmed.json()).data.cost).toMatchObject({
    goodsCostVnd: 2000,
    vatAmountVnd: null,
    totalCostVnd: null,
  });
  const zeroTax = await tabApi(page).patch(
    `${api}/api/v1/inbound-receipts/${deferredReceipt.id}/vat`,
    {
      headers: { 'idempotency-key': `zero-vat-${receipt.id}` },
      data: {
        expectedVersion: 1,
        vat: { amountVnd: 0, ratePercent: 8 },
        reason: 'Xác nhận tiền VAT bằng không',
      },
    },
  );
  expect(zeroTax.status()).toBe(200);
  expect((await zeroTax.json()).data.cost).toMatchObject({ vatAmountVnd: 0, totalCostVnd: 2000 });
});

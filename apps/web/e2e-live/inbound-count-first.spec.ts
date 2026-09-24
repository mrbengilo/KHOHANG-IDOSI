import { expect, test } from '@playwright/test';

test('warehouse accepts three bags without a weight field and generates its receipt number', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu', { exact: true })
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('link', { name: 'Nhập kho tổng', exact: true }).click();
  await page.getByLabel('Nhà cung cấp', { exact: true }).fill('CI count-first supplier');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('spinbutton', { name: /Số bao/ }).fill('3');
  await expect(page.getByLabel(/Khối lượng bao/)).toHaveCount(0);
  await expect(page.getByLabel('Mã phiếu nhập')).toHaveAttribute('readonly', '');
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/inbound-receipts'),
  );
  await page.getByRole('button', { name: 'Xác nhận nhập kho tổng', exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  const { data } = await saved.json();
  expect(data.referenceCode).toMatch(/^PN\d{5,}-\d{2}\/\d{2}\/\d{4}$/);
  expect(data.bags).toHaveLength(3);
  expect(data.totalWeightKg).toBeNull();
  expect(data.bags.every((bag: { weightKg: unknown }) => bag.weightKg === null)).toBe(true);
  await expect(
    page.getByText(`Đã nhập phiếu ${data.referenceCode} vào kho tổng.`, { exact: true }),
  ).toBeVisible();
  const row = page.locator('article').filter({ hasText: data.referenceCode });
  await expect(row.locator('.inbound-receipt__products tbody tr')).toHaveCount(1);
  await expect(row.locator('.inbound-receipt__products tbody td')).toHaveText('3 bao');
  await expect(row.locator('time')).toHaveAttribute('datetime', data.receivedAt);
  await expect(row.locator('.inbound-receipt__products tbody th')).not.toContainText('Chưa tải');
  await row.getByText('Chốt chi phí theo hóa đơn', { exact: true }).click();
  await row.getByLabel('Tổng tiền hàng theo hóa đơn (VND)').fill('1234567');
  await row.getByLabel('Phí vận chuyển (VND)').fill('10000');
  await row.getByLabel('Phí bốc vác (VND)').fill('5000');
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  const costResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/inbound-receipts/${data.id}/confirm-costs`) &&
      response.request().method() === 'POST',
  );
  await row.getByRole('button', { name: 'Xác nhận chi phí hóa đơn' }).click();
  const confirmed = await costResponse;
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  expect((await confirmed.json()).data.cost).toMatchObject({
    productCosts: [],
    goodsCostVnd: 1234567,
    totalCostVnd: 1249567,
  });
  await expect(row).toContainText('Đã xác nhận chi phí');
  // VAT now comes from the store's delivery note, so the warehouse total no longer waits for it.
  await expect(row).toContainText(/Tổng chi phí:\s*1\.249\.567/);
  await expect(row).not.toContainText('VAT:');
});

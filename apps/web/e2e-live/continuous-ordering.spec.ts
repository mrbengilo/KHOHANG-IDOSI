import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('HTKD sees assigned stores, selects bags inline and persists two ordinary requests', async ({
  page,
}, testInfo) => {
  const api = 'http://127.0.0.1:3100/api/v1';
  const admin = await page.request.post(`${api}/auth/login`, {
    data: {
      username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
      password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
    },
  });
  expect(admin.status()).toBe(200);
  const groups = await page.request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
  const groupId = (await groups.json()).data[0].id;
  const token = randomUUID().slice(0, 8);
  const stores: { id: string; code: string }[] = [];
  for (const index of [1, 2]) {
    const created = await page.request.post(`${api}/stores`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        code: `UI_24H_${token}_${index}`,
        name: `Cửa hàng kiểm thử ${index}`,
        kind: 'RETAIL',
        groupId,
      },
    });
    expect(created.status()).toBe(201);
    stores.push((await created.json()).data);
  }
  const username = `htkd.24h.${token}`;
  const password = `Test-only-${randomUUID()}!`;
  const account = await page.request.post(`${api}/admin/accounts`, {
    data: { username, password, displayName: 'HTKD kiểm thử 24/7', role: 'HTKD' },
  });
  expect(account.status()).toBe(201);
  const assigned = await page.request.put(
    `${api}/admin/accounts/${(await account.json()).data.id}/assignments`,
    {
      data: {
        expectedSessionVersion: 0,
        storeIds: stores.map((store) => store.id),
        reason: 'Phân công kiểm thử đặt hàng 24/7',
      },
    },
  );
  expect(assigned.status()).toBe(200);
  await page.request.post(`${api}/auth/logout`);
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.getByRole('link', { name: 'Đặt hàng', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Cửa hàng', exact: true });
  await expect(selector.locator('option')).toHaveCount(2);
  await selector.selectOption(stores[1]!.id);
  const first = page.getByRole('checkbox').first();
  await expect(first).toBeEnabled();
  await first.check();
  await page.getByRole('button', { name: /^Tăng số bao/ }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    const checkbox = (await first.boundingBox())!;
    const quantity = (await page.getByRole('spinbutton').boundingBox())!;
    expect(
      Math.abs(checkbox.y + checkbox.height / 2 - quantity.y - quantity.height / 2),
    ).toBeLessThan(2);
    expect(quantity.x - checkbox.x).toBeLessThan(350);
  }
  await page.screenshot({
    path: testInfo.outputPath('htkd-order-desktop.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.getByRole('checkbox').nth(1).check();
  const send = page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng' });
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/order-requests' &&
      response.request().method() === 'POST',
  );
  await send.click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const order = (await response.json()).data;
  expect(order.storeId).toBe(stores[1]!.id);
  expect(order.lines).toHaveLength(2);
  const history = page.getByRole('region', { name: 'Lịch sử đặt hàng', exact: true });
  const document = history.locator('tbody').filter({ hasText: order.code });
  await expect(history.locator('thead th')).toHaveCount(7);
  await expect(document.locator('tr')).toHaveCount(2);
  await expect(document.locator('[rowspan="2"]')).toHaveCount(5);
  await expect(document.getByRole('button', { name: 'Hủy yêu cầu', exact: true })).toHaveCount(1);
  expect(
    order.lines.map((line: { requested: { quantity: number } }) => line.requested.quantity).sort(),
  ).toEqual([1, 2]);
  await expect(page.getByText('1 / 2 phiếu', { exact: true })).toBeVisible();
  await first.check();
  await send.click();
  await expect(page.getByText('2 / 2 phiếu', { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  await page.reload();
  await selector.selectOption(stores[1]!.id);
  await expect(page.getByText('2 / 2 phiếu', { exact: true })).toBeVisible();
  await document.getByRole('button', { name: 'Hủy yêu cầu', exact: true }).click();
  await expect(document.getByLabel('Lý do hủy')).toBeFocused();
  await document.getByLabel('Lý do hủy').fill('Hủy toàn bộ phiếu nhiều mặt hàng');
  await document.getByRole('button', { name: 'Xác nhận hủy', exact: true }).click();
  await expect(document.getByText('Đã hủy', { exact: true })).toBeVisible();
  await expect(document.locator('tr')).toHaveCount(2);
  await expect(page.getByText('1 / 2 phiếu', { exact: true })).toBeVisible();
  await selector.selectOption(stores[0]!.id);
  await expect(page.getByText('0 / 2 phiếu', { exact: true })).toBeVisible();
  await expect(first).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await first.check();
  await page.screenshot({
    path: testInfo.outputPath('htkd-order-mobile.png'),
    animations: 'disabled',
    fullPage: true,
  });
});

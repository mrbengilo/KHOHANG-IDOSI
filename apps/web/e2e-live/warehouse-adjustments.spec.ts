import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  applyWarehouseMovement,
  createDatabase,
  products,
  warehouseBalances,
  warehouseStockAdjustments,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/u);
}

test('Admin adjusts central stock with preview, conflict reload, safe retry and history', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  const db = client.db;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const token = randomUUID().replaceAll('-', '').slice(0, 10);
    const name = `Hàng điều chỉnh ${token}`;
    const [product] = await db
      .insert(products)
      .values({ sku: `ADJ-UI-${token}`, slug: `adj-ui-${token}`, name })
      .returning();
    await db.transaction(async (tx) => {
      await applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: 10,
        reservedDelta: 0,
        sourceType: 'live_e2e_adjustment',
        sourceId: randomUUID(),
      });
      await applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: 4,
        sourceType: 'live_e2e_adjustment_hold',
        sourceId: randomUUID(),
      });
    });
    await login(
      page,
      process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
      process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
    );
    await page.goto(`/inventory?kt.q=${encodeURIComponent(product!.sku)}`);
    const stock = page.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' });
    const row = stock.locator('tbody tr').filter({ hasText: name });
    await expect(row).toContainText('10 bao');
    const open = () => row.getByRole('button', { name: `Điều chỉnh tồn ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Điều chỉnh tồn kho tổng' });
    const submitResponse = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/warehouse-adjustments' &&
          response.request().method() === 'POST',
      );

    // 1. Increase by 3 with a preview of before → change → after.
    await open();
    const position = dialog.getByLabel('Tồn hiện tại');
    await expect(position).toContainText('10 bao');
    await expect(position).toContainText('4 bao');
    await expect(position).toContainText('6 bao');
    await dialog.getByLabel('Số bao tăng').fill('3');
    await dialog.getByLabel('Lý do chi tiết (bắt buộc)').fill('Kiểm kê dư 3 bao trên kệ');
    await expect(dialog.getByRole('region', { name: 'Xem trước điều chỉnh' })).toContainText(
      'Tồn sau 13 bao',
    );
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      const confirmBox = await dialog
        .getByRole('button', { name: 'Xác nhận tăng 3 bao' })
        .boundingBox();
      expect(confirmBox!.height).toBeGreaterThanOrEqual(40);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`adjustment-dialog-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    let response = submitResponse();
    await dialog.getByRole('button', { name: 'Xác nhận tăng 3 bao' }).click();
    expect((await response).status()).toBe(201);
    await expect(page.getByRole('status').filter({ hasText: 'Đã ghi phiếu DCK-' })).toContainText(
      '10 → 13 bao',
    );
    await expect(row).toContainText('13 bao');

    // 2. A decrease may not reach into the 4 held bags.
    await open();
    await dialog.getByLabel('Giảm tồn').check();
    await dialog.getByLabel('Số bao giảm').fill('10');
    await dialog.getByLabel('Lý do chi tiết (bắt buộc)').fill('Bao rách');
    await expect(dialog).toContainText('tối đa 9 bao');
    await expect(dialog.getByRole('button', { name: /^Xác nhận giảm/u })).toBeDisabled();
    await dialog.getByLabel('Số bao giảm').fill('2');
    response = submitResponse();
    await dialog.getByRole('button', { name: 'Xác nhận giảm 2 bao' }).click();
    expect((await response).status()).toBe(201);
    await expect(row).toContainText('11 bao');

    // 3. Someone else changes the balance meanwhile: refused, reloaded, then confirmed.
    await open();
    const [balance] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, product!.id));
    const concurrent = await tabApi(page).post(`${api}/warehouse-adjustments`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        productId: product!.id,
        direction: 'INCREASE',
        quantity: 1,
        reasonCode: 'RETURN',
        reason: 'Hàng trả về kho',
        expectedVersion: balance!.version,
      },
    });
    expect(concurrent.status()).toBe(201);
    await dialog.getByLabel('Giảm tồn').check();
    await dialog.getByLabel('Số bao giảm').fill('1');
    await dialog.getByLabel('Lý do chi tiết (bắt buộc)').fill('Kiểm kê thiếu 1 bao');
    response = submitResponse();
    await dialog.getByRole('button', { name: 'Xác nhận giảm 1 bao' }).click();
    expect((await response).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('Tồn kho vừa thay đổi');
    await dialog.getByRole('button', { name: 'Tải lại số liệu tồn' }).click();
    await expect(position).toContainText('12 bao');
    response = submitResponse();
    await dialog.getByRole('button', { name: 'Xác nhận giảm 1 bao' }).click();
    expect((await response).status()).toBe(201);
    await expect(row).toContainText('11 bao');

    // 4. The response is lost after the server committed: the retry replays the same key.
    await open();
    await dialog.getByLabel('Số bao tăng').fill('5');
    await dialog.getByLabel('Lý do chi tiết (bắt buộc)').fill('Nhập bổ sung sau kiểm kê');
    let dropped = false;
    await page.route('**/api/v1/warehouse-adjustments', async (route) => {
      if (route.request().method() !== 'POST' || dropped) return route.fallback();
      dropped = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await dialog.getByRole('button', { name: 'Xác nhận tăng 5 bao' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Chưa xác định được kết quả');
    await page.unroute('**/api/v1/warehouse-adjustments');
    response = submitResponse();
    await dialog.getByRole('button', { name: 'Gửi lại đúng thao tác này' }).click();
    const replay = await response;
    expect(replay.status()).toBe(201);
    expect(replay.headers()['idempotency-replayed']).toBe('true');
    await expect(row).toContainText('16 bao');
    const documents = await db
      .select()
      .from(warehouseStockAdjustments)
      .where(eq(warehouseStockAdjustments.productId, product!.id));
    expect(documents).toHaveLength(5);

    // 5. History: immutable documents, newest first, filtered by product.
    await page
      .getByRole('tablist', { name: 'Nội dung kho tổng' })
      .getByRole('tab', { name: 'Lịch sử điều chỉnh' })
      .click();
    const history = page.getByRole('region', { name: 'Lịch sử điều chỉnh tồn kho tổng' });
    await history.getByLabel('Mặt hàng').selectOption(product!.id);
    const historyRows = history.locator('tbody tr');
    await expect(historyRows).toHaveCount(5);
    await expect(historyRows.first()).toContainText('+5 bao');
    await expect(historyRows.first()).toContainText('11 → 16 bao');
    await expect(historyRows.first()).toContainText('Nhập bổ sung sau kiểm kê');
    await expect(historyRows.last()).toContainText('+3 bao');
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`adjustment-history-${width}.png`) });
      }
    }

    // 6. Only Admin can write: HTKD is refused by the server.
    const htkdUsername = `htkd.adj.${token}`;
    const htkdPassword = `Test-only-${randomUUID()}!`;
    expect(
      (
        await tabApi(page).post(`${api}/admin/accounts`, {
          data: {
            username: htkdUsername,
            password: htkdPassword,
            displayName: 'HTKD điều chỉnh',
            role: 'HTKD',
          },
        })
      ).status(),
    ).toBe(201);
    await tabApi(page).post(`${api}/auth/logout`);
    await login(page, htkdUsername, htkdPassword);
    const refused = await tabApi(page).post(`${api}/warehouse-adjustments`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        productId: product!.id,
        direction: 'INCREASE',
        quantity: 1,
        reasonCode: 'OTHER',
        reason: 'Không có quyền',
        expectedVersion: 0,
      },
    });
    expect(refused.status()).toBe(403);
    expect((await tabApi(page).get(`${api}/warehouse-adjustments`)).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});

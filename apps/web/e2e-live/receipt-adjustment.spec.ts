import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  createDatabase,
  products,
  storeInventoryBags,
  storeReceiptAdjustments,
  users,
  waitTickets,
  warehouseBalances,
} from '@idosi/database';
import { finalizedReceipt } from './receipt-fixture';
import { and, eq } from 'drizzle-orm';

import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';
const adminUsername = process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin';
const adminPassword =
  process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production';
const widths = [360, 390, 412, 768, 1366, 1440];

test('store reports a mixed-up bag, HTKD verifies, admin applies: money, stock and P0B right', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  try {
    const token = randomUUID().slice(0, 8);
    const dressName = `Đầm kiểm thử ${token}`;
    const jeansName = `Jeans kiểm thử ${token}`;

    // Accounts through the admin API so logins use real password hashes and assignments.
    expect(
      (
        await page.request.post(`${api}/auth/login`, {
          data: { username: adminUsername, password: adminPassword },
        })
      ).status(),
    ).toBe(200);
    const groups = await page.request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const store = (
      await (
        await page.request.post(`${api}/stores`, {
          headers: { 'idempotency-key': randomUUID() },
          data: {
            code: `UI_ADJ_${token}`,
            name: `Cửa hàng sai lệch ${token}`,
            kind: 'RETAIL',
            groupId: (await groups.json()).data[0].id,
          },
        })
      ).json()
    ).data as { id: string };
    const storeLogin = { username: `store.adj.${token}`, password: `Test-only-${randomUUID()}!` };
    const htkdLogin = { username: `htkd.adj.${token}`, password: `Test-only-${randomUUID()}!` };
    const storeAccount = await page.request.post(`${api}/admin/accounts`, {
      data: { ...storeLogin, displayName: 'Cửa hàng sai lệch', role: 'STORE', storeId: store.id },
    });
    expect(storeAccount.status()).toBe(201);
    const htkdAccount = await page.request.post(`${api}/admin/accounts`, {
      data: { ...htkdLogin, displayName: 'HTKD sai lệch', role: 'HTKD' },
    });
    expect(htkdAccount.status()).toBe(201);
    const htkdId = (await htkdAccount.json()).data.id as string;
    expect(
      (
        await page.request.put(`${api}/admin/accounts/${htkdId}/assignments`, {
          data: {
            expectedSessionVersion: 0,
            storeIds: [store.id],
            reason: 'Phân công kiểm thử sai lệch',
          },
        })
      ).status(),
    ).toBe(200);
    await page.request.post(`${api}/auth/logout`);
    const storeUserId = (await storeAccount.json()).data.id as string;
    const [adminRow] = await client.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);

    // A finalized receipt of 3 dress bags, 20 kg × 50.000 đ/kg each = 3.000.000 đ.
    const [dress] = await client.db
      .insert(products)
      .values({ sku: `E2E-DAM-${token}`, slug: `e2e-dam-${token}`, name: dressName })
      .returning();
    const [jeans] = await client.db
      .insert(products)
      .values({ sku: `E2E-JEANS-${token}`, slug: `e2e-jeans-${token}`, name: jeansName })
      .returning();
    await finalizedReceipt(client, {
      adminId: adminRow!.id,
      storeId: store.id,
      storeUserId,
      htkdId,
      productId: dress!.id,
    });

    // 1. The store reports bag 1 as jeans and keeps it.
    await login(page, storeLogin);
    await page.goto('/receive');
    const section = page.locator('.adjustment-section');
    await expect(section.getByRole('heading', { name: /Sai lệch sau khui bao/ })).toBeVisible();
    await section.getByRole('button', { name: 'Báo sai lệch sau khui bao' }).click();
    await section.getByRole('checkbox', { name: /Bao 1/ }).check();
    await section.getByLabel('Mặt hàng thực tế').selectOption({ label: jeansName });
    await expect(section.getByRole('note')).toContainText(`1 bao ${dressName}`);
    await section.getByLabel('Lý do').fill('Khui bao 1 thấy toàn quần jeans');
    await section.getByLabel(/Bằng chứng/).fill('Ảnh gửi nhóm HTKD lúc khui');
    await assertNoOverflow(page, testInfo.outputPath('store-report-form'));
    await section.getByRole('button', { name: 'Gửi HTKD xác minh' }).click();
    await expect(section.locator('.receipt-notice')).toContainText('PSL-');
    await expect(section.locator('.adjustment-detail')).toContainText('Chờ HTKD xác minh');
    expect(
      (
        await client.db
          .select({ status: storeInventoryBags.status })
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.storeId, store.id))
      ).filter((bag) => bag.status === 'quarantined'),
    ).toHaveLength(1);

    // 2. The assigned HTKD verifies the price of the jeans bag.
    await relogin(page, htkdLogin);
    await page.goto('/receive');
    const queue = page.locator('.adjustment-queue');
    await queue.getByRole('button').filter({ hasText: 'Chờ HTKD xác minh' }).first().click();
    const detail = page.locator('.adjustment-detail');
    await detail.getByLabel('Giá / kg mặt hàng thực tế (VND)').fill('40000');
    await detail.getByLabel('Nguyên nhân').selectOption('SOURCE_MISCLASSIFICATION');
    await detail.getByLabel('Ghi chú xác minh').fill('Đã xem ảnh, cân lại đúng 20 kg');
    await expect(detail).toContainText('−200.000 ₫');
    await assertNoOverflow(page, testInfo.outputPath('htkd-verify'));
    await detail.getByRole('button', { name: 'Xác minh, gửi Admin duyệt' }).click();
    await expect(detail).toContainText('Chờ Admin duyệt');
    await expect(detail).toContainText('Sau điều chỉnh (tạm tính, chưa hiệu lực)');

    // 3. The admin applies it: money, stock and the dress right take effect together.
    await relogin(page, { username: adminUsername, password: adminPassword });
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ Admin duyệt' })
      .filter({ hasText: `Cửa hàng sai lệch ${token}` })
      .first()
      .click();
    const adminDetail = page.locator('.adjustment-detail');
    await adminDetail.getByRole('button', { name: 'Duyệt và áp dụng' }).click();
    await expect(adminDetail).toContainText('Đã áp dụng');
    await expect(adminDetail).toContainText('Sau điều chỉnh (đã có hiệu lực)');
    await expect(adminDetail).toContainText('Chờ cấp (ưu tiên P0B)');
    await expect(page.locator('.adjustment-money__effective')).toContainText('2.800.000');
    await assertNoOverflow(page, testInfo.outputPath('admin-applied'));

    const bags = await client.db
      .select({ productId: storeInventoryBags.productId, status: storeInventoryBags.status })
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store.id));
    expect(bags.filter((bag) => bag.productId === dress!.id)).toHaveLength(2);
    expect(bags.filter((bag) => bag.productId === jeans!.id)).toEqual([
      { productId: jeans!.id, status: 'available' },
    ]);
    expect(
      await client.db
        .select({ priority: waitTickets.priorityLevel, remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(and(eq(waitTickets.storeId, store.id), eq(waitTickets.status, 'active'))),
    ).toEqual([{ priority: 'P0B', remaining: 1 }]);

    // 4. Return branch: bag 2 is jeans too and goes back to the warehouse.
    await relogin(page, storeLogin);
    await page.goto('/receive');
    await section.getByRole('button', { name: 'Báo sai lệch sau khui bao' }).click();
    await section.getByRole('checkbox', { name: /Bao 2/ }).check();
    await section.getByLabel('Mặt hàng thực tế').selectOption({ label: jeansName });
    await section.getByRole('radio', { name: 'Trả về kho tổng' }).check();
    await section.getByLabel('Lý do').fill('Bao 2 cũng là jeans, trả kho');
    await section.getByRole('button', { name: 'Gửi HTKD xác minh' }).click();
    await expect(section.locator('.receipt-notice')).toContainText('PSL-');
    const [pending] = await client.db
      .select({ id: storeReceiptAdjustments.id })
      .from(storeReceiptAdjustments)
      .where(
        and(
          eq(storeReceiptAdjustments.storeId, store.id),
          eq(storeReceiptAdjustments.status, 'pending_htkd'),
        ),
      );
    await relogin(page, { username: adminUsername, password: adminPassword });
    const adminApi = tabApi(page);
    const adjustment = (
      await (await adminApi.get(`${api}/receipt-adjustments/${pending!.id}`)).json()
    ).data;
    const verified = await adminApi.post(`${api}/receipt-adjustments/${pending!.id}/actions`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        action: 'VERIFY',
        expectedVersion: 0,
        cause: 'SOURCE_MISCLASSIFICATION',
        note: 'Admin xác minh nhánh trả',
        lines: adjustment.lines.map((line: { receiptBagId: string; recordedWeightKg: string }) => ({
          receiptBagId: line.receiptBagId,
          actualProductId: jeans!.id,
          weightKg: line.recordedWeightKg,
          pricePerKgVnd: 40_000,
          weightChangeNote: null,
        })),
      },
    });
    expect(verified.status()).toBe(200);
    const applied = await adminApi.post(`${api}/receipt-adjustments/${pending!.id}/actions`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { action: 'APPLY', expectedVersion: 1, note: null },
    });
    expect(applied.status()).toBe(200);
    expect(
      await client.db
        .select({ remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(and(eq(waitTickets.storeId, store.id), eq(waitTickets.status, 'active'))),
    ).toEqual([{ remaining: 2 }]);

    await relogin(page, storeLogin);
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ bàn giao trả' })
      .first()
      .click();
    const returns = page.locator('.adjustment-returns');
    await expect(returns).toContainText('Chờ bàn giao trả');
    await returns.getByRole('button', { name: 'Bàn giao trả kho' }).click();
    await expect(returns).toContainText('Đang vận chuyển về kho');
    await assertNoOverflow(page, testInfo.outputPath('store-return-handover'));

    await relogin(page, { username: adminUsername, password: adminPassword });
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Đang vận chuyển về kho' })
      .filter({ hasText: `Cửa hàng sai lệch ${token}` })
      .first()
      .click();
    await page.locator('.adjustment-returns').getByRole('button', { name: 'Kho nhận đủ' }).click();
    await expect(page.locator('.adjustment-returns')).toContainText('Kho đã nhận');
    const [balance] = await client.db
      .select({ onHand: warehouseBalances.onHandQuantity })
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, jeans!.id));
    expect(balance).toEqual({ onHand: 1 });
  } finally {
    await client.close();
  }
});

async function login(page: Page, credentials: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function relogin(page: Page, credentials: { username: string; password: string }) {
  await page.context().clearCookies();
  await page.evaluate(() => window.sessionStorage.clear());
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, credentials);
}

async function assertNoOverflow(page: Page, screenshotPrefix: string) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    // Buttons keep their labels inside their box at every width.
    const clipped = await page.evaluate(
      () =>
        [...document.querySelectorAll('.adjustment-section .button')].filter(
          (button) => button.scrollWidth > button.clientWidth + 1,
        ).length,
    );
    expect(clipped).toBe(0);
    if (width === 390 || width === 1440) {
      await page.locator('.adjustment-section').screenshot({
        path: `${screenshotPrefix}-${width}.png`,
        animations: 'disabled',
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

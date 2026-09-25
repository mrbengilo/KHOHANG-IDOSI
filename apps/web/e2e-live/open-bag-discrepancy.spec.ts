import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createDatabase,
  products,
  users,
  storeInventoryBags,
  storeReceiptAdjustments,
  storeReceiptBags,
  storeReceiptLines,
} from '@idosi/database';
import { and, eq } from 'drizzle-orm';
import { finalizedReceipt } from './receipt-fixture';
import { tabApi } from './tab-api';
const api = 'http://127.0.0.1:3100/api/v1';
const adminUsername = process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin';
const adminPassword =
  process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production';
test('production opening locks a stale discrepancy form and retains opening history', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires isolated PostgreSQL');
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

    await login(page, storeLogin);
    await page.goto('/receive');
    const section = page.locator('.adjustment-section');
    await section.getByRole('button', { name: 'Báo sai lệch sau khui bao' }).click();
    await section.getByRole('checkbox', { name: /Bao 1/ }).check();
    await section.getByLabel('Mặt hàng thực tế').selectOption({ label: jeansName });
    await section.getByLabel('Lý do').fill('Nội dung phải giữ khi bao đã khui ở tab khác');
    const [target] = await client.db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store.id))
      .orderBy(storeInventoryBags.displayCode);
    const tab = await page.context().newPage();
    await login(tab, storeLogin);
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    await tab.goto('/open-bag');
    await expect(tab.getByRole('heading', { name: /Bao chưa khui/ })).toBeVisible();
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await tab.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => tab.evaluate(() => document.body.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 390 || width === 1440)
        await tab.screenshot({
          path: testInfo.outputPath('opening-' + width + '.png'),
          fullPage: true,
          animations: 'disabled',
        });
    }
    await tab.getByRole('button', { name: 'Khui bao ' + target!.displayCode, exact: true }).click();
    await tab.getByRole('button', { name: 'Khui 1 bao', exact: true }).click();
    await expect(tab.locator('.operation-notice--success')).toBeVisible();
    await expect(tab.getByRole('heading', { name: /Lịch sử khui/ })).toBeVisible();
    await expect(tab.getByText('Xác nhận khui bán', { exact: true })).toBeVisible();
    const submit = section.getByRole('button', { name: 'Gửi HTKD xác minh' });
    if (await submit.isEnabled()) {
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/receipt-adjustments') && r.request().method() === 'POST',
      );
      await submit.click();
      expect((await response).status()).toBe(409);
    }
    await expect(section.getByLabel('Lý do')).toHaveValue(
      'Nội dung phải giữ khi bao đã khui ở tab khác',
    );
    await expect(section.getByRole('checkbox', { name: /Bao 1/ })).toBeDisabled();
    await expect(submit).toBeDisabled();
    const records = await client.db
      .select()
      .from(storeReceiptAdjustments)
      .where(eq(storeReceiptAdjustments.storeId, store.id));
    expect(records).toHaveLength(0);
    // Direct stale POST remains forbidden even if client-side selection is bypassed.
    const receiptBagId = target!.sourceStoreReceiptBagId!;
    const [receiptBag] = await client.db
      .select()
      .from(storeReceiptBags)
      .where(eq(storeReceiptBags.id, receiptBagId));
    const [receiptLine] = await client.db
      .select()
      .from(storeReceiptLines)
      .where(eq(storeReceiptLines.id, receiptBag!.storeReceiptLineId));
    const direct = await tabApi(page).post(api + '/receipt-adjustments', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        receiptId: receiptLine!.storeReceiptId,
        reason: 'Thử báo trực tiếp',
        evidenceNote: null,
        discoveredAt: new Date().toISOString(),
        lines: [{ receiptBagId, actualProductId: jeans!.id, disposition: 'KEEP' }],
      },
    });
    expect(direct.status()).toBe(409);
    expect((await direct.json()).error.details.blockers[receiptBagId]).toContain(
      'BAG_ALREADY_OPENED',
    );
    const remaining = await client.db
      .select()
      .from(storeInventoryBags)
      .where(
        and(eq(storeInventoryBags.storeId, store.id), eq(storeInventoryBags.status, 'available')),
      );
    for (const bag of remaining) {
      await tab.getByRole('button', { name: 'Khui bao ' + bag.displayCode, exact: true }).click();
      await tab.getByRole('button', { name: 'Khui 1 bao', exact: true }).click();
      await expect(
        tab.getByRole('button', { name: 'Khui bao ' + bag.displayCode, exact: true }),
      ).toHaveCount(0);
    }
    await expect(tab.getByText('Không có bao chờ khui', { exact: true })).toBeVisible();
    await expect(tab.getByText('Xác nhận khui bán', { exact: true })).toHaveCount(3);
    for (const width of [390, 1440]) {
      await tab.setViewportSize({ width, height: 900 });
      await tab.screenshot({
        path: testInfo.outputPath('history-' + width + '.png'),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await tab.close();
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

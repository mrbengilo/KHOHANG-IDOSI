import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  createDatabase,
  products,
  storeInventoryBags,
  storeReceiptAdjustments,
  storeReceipts,
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

test('store reports a mixed-up bag, HTKD approves once: money, stock and P0B right', async ({
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
    await page.locator('.receipt-card').first().click();
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
    await detail.getByRole('button', { name: 'Duyệt và áp dụng' }).click();
    await expect(detail).toContainText('Đã xử lý');
    await expect(detail).toContainText('Sau điều chỉnh (đã có hiệu lực)');
    await expect(detail).toContainText('Chờ cấp (ưu tiên P0B)');
    await expect(page.locator('.adjustment-money__effective')).toContainText('2.800.000');
    await expect(page.locator('.adjustment-money__effective')).toContainText('224.000');
    await expect(page.locator('.adjustment-money__effective')).toContainText('3.024.000');
    await expect(page.locator('.adjustment-money')).toContainText('−216.000');
    await assertNoOverflow(page, testInfo.outputPath('htkd-applied'));

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
    await page.locator('.receipt-card').first().click();
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
    await relogin(page, htkdLogin);
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ HTKD xác minh' })
      .first()
      .click();
    await expect(detail.getByLabel('Giá / kg mặt hàng thực tế (VND)')).toHaveCount(0);
    await detail.getByLabel('Nguyên nhân').selectOption('SOURCE_MISCLASSIFICATION');
    await detail.getByLabel('Ghi chú xác minh').fill('HTKD xác minh trả ngay đúng bao nguồn');
    await expect(detail).toContainText('nhập ngay về kho tổng');
    await assertNoOverflow(page, testInfo.outputPath('htkd-return-before'));
    await detail.getByRole('button', { name: 'Duyệt và áp dụng' }).click();
    await expect(detail).toContainText('Đã xử lý');
    await expect(detail.locator('.adjustment-returns')).toContainText('Kho đã nhận');
    await expect(page.locator('.adjustment-money__effective')).toContainText('1.800.000');
    await expect(page.locator('.adjustment-money__effective')).toContainText('144.000');
    await expect(page.locator('.adjustment-money__effective')).toContainText('1.944.000');
    await expect(page.locator('.adjustment-money')).toContainText('−1.296.000');
    await expect(page.getByRole('button', { name: 'Bàn giao trả kho', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Kho nhận đủ', exact: true })).toHaveCount(0);
    await assertNoOverflow(page, testInfo.outputPath('htkd-return-after'));
    expect(
      (
        await client.db
          .select()
          .from(storeReceiptAdjustments)
          .where(eq(storeReceiptAdjustments.id, pending!.id))
      )[0]!.status,
    ).toBe('applied');
    expect(
      await client.db
        .select({ remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(and(eq(waitTickets.storeId, store.id), eq(waitTickets.status, 'active'))),
    ).toEqual([{ remaining: 2 }]);
    const remaining = await client.db
      .select({ productId: storeInventoryBags.productId, status: storeInventoryBags.status })
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store.id));
    expect(
      remaining
        .filter((bag) => bag.status === 'available')
        .map((bag) => bag.productId)
        .sort(),
    ).toEqual([dress!.id, jeans!.id].sort());
    expect(remaining.filter((bag) => bag.status === 'returned')).toHaveLength(1);
    await relogin(page, storeLogin);
    await page.goto('/receive');
    await page.locator('.receipt-card').first().click();
    await expect(page.locator('.adjustment-money__effective')).toContainText('1.800.000');
    await expect(page.getByRole('button', { name: 'Bàn giao trả kho', exact: true })).toHaveCount(
      0,
    );
    await page.reload();
    await page.locator('.receipt-card').first().click();
    await expect(page.locator('.adjustment-money__effective')).toContainText('1.800.000');
    const [balance] = await client.db
      .select({ onHand: warehouseBalances.onHandQuantity })
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, jeans!.id));
    expect(balance).toEqual({ onHand: 1 });
  } finally {
    await client.close();
  }
});

test('admin tab lists every store document; applying shows "Đã xử lý" to HTKD and store without reload', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  // Three independent browsers: nothing is shared between the sessions but the server.
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [adminPage, htkdPage, storePage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const token = randomUUID().slice(0, 8);
    const storeName = `Cửa hàng đồng bộ ${token}`;

    await login(adminPage, { username: adminUsername, password: adminPassword });
    const adminApi = tabApi(adminPage);
    const groups = await adminApi.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const store = (
      await (
        await adminApi.post(`${api}/stores`, {
          headers: { 'idempotency-key': randomUUID() },
          data: {
            code: `UI_SYNC_${token}`,
            name: storeName,
            kind: 'RETAIL',
            groupId: (await groups.json()).data[0].id,
          },
        })
      ).json()
    ).data as { id: string };
    const storeLogin = { username: `store.sync.${token}`, password: `Test-only-${randomUUID()}!` };
    const htkdLogin = { username: `htkd.sync.${token}`, password: `Test-only-${randomUUID()}!` };
    const storeAccount = await adminApi.post(`${api}/admin/accounts`, {
      data: { ...storeLogin, displayName: `Cửa hàng ${token}`, role: 'STORE', storeId: store.id },
    });
    expect(storeAccount.status()).toBe(201);
    const htkdAccount = await adminApi.post(`${api}/admin/accounts`, {
      data: { ...htkdLogin, displayName: `HTKD ${token}`, role: 'HTKD' },
    });
    expect(htkdAccount.status()).toBe(201);
    const htkdId = (await htkdAccount.json()).data.id as string;
    expect(
      (
        await adminApi.put(`${api}/admin/accounts/${htkdId}/assignments`, {
          data: { expectedSessionVersion: 0, storeIds: [store.id], reason: 'Kiểm thử đồng bộ' },
        })
      ).status(),
    ).toBe(200);
    const [adminRow] = await client.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);
    const [dress] = await client.db
      .insert(products)
      .values({ sku: `E2E-SDAM-${token}`, slug: `e2e-sdam-${token}`, name: `Đầm ${token}` })
      .returning();
    const [jeans] = await client.db
      .insert(products)
      .values({ sku: `E2E-SJEANS-${token}`, slug: `e2e-sjeans-${token}`, name: `Jeans ${token}` })
      .returning();
    await finalizedReceipt(client, {
      adminId: adminRow!.id,
      storeId: store.id,
      storeUserId: (await storeAccount.json()).data.id as string,
      htkdId,
      productId: dress!.id,
    });
    const [receipt] = await client.db
      .select({ id: storeReceipts.id, receiptNumber: storeReceipts.receiptNumber })
      .from(storeReceipts)
      .where(eq(storeReceipts.storeId, store.id));

    // Store reports and HTKD verifies through the API; the UI of those steps is covered above.
    await login(storePage, storeLogin);
    const storeApi = tabApi(storePage);
    const contextView = (
      await (await storeApi.get(`${api}/store-receipts/${receipt!.id}/adjustment-context`)).json()
    ).data;
    const created = (
      await (
        await storeApi.post(`${api}/receipt-adjustments`, {
          headers: { 'idempotency-key': randomUUID() },
          data: {
            receiptId: receipt!.id,
            reason: 'Khui bao thấy jeans',
            evidenceNote: null,
            discoveredAt: new Date().toISOString(),
            lines: [
              {
                receiptBagId: contextView.bags[0].receiptBagId,
                actualProductId: jeans!.id,
                disposition: 'KEEP',
              },
            ],
          },
        })
      ).json()
    ).data as { id: string; code: string };
    await login(htkdPage, htkdLogin);
    // HTKD and store keep the receipt open; they will not reload.
    for (const page of [storePage, htkdPage]) {
      await page.goto('/receive');
      await page.locator('.receipt-card').filter({ hasText: receipt!.receiptNumber }).click();
      await expect(page.locator('.adjustment-section')).toContainText(created.code);
      await expect(page.locator('.adjustment-section')).toContainText('Chờ HTKD xác minh');
    }

    // Admin: only the open tab loads. The discrepancy tab never downloads warehouse data.
    const requested: string[] = [];
    adminPage.on('request', (request) => requested.push(new URL(request.url()).pathname));
    await adminPage.goto(`/inventory?tab=adjustments&psl.store=${store.id}`);
    const tabs = adminPage.getByRole('tablist', { name: 'Phạm vi tồn kho' });
    await expect(tabs.getByRole('tab', { name: 'Phiếu sai lệch' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const list = adminPage.getByRole('region', { name: 'Danh sách phiếu sai lệch' });
    await expect(list).toContainText(created.code);
    await expect(list).toContainText('Chờ HTKD xác minh');
    await expect(list).toContainText('Chờ HTKD xác minh giá');
    await expect(adminPage.getByText(/Đang xem: Chờ HTKD xác minh/)).toBeVisible();
    expect(requested.filter((path) => path.includes('/warehouse-'))).toEqual([]);
    expect(requested.filter((path) => path.endsWith('/store-inventory-bags'))).toEqual([]);
    expect(
      requested.filter((path) => new RegExp(`/receipt-adjustments/${created.id}$`).test(path)),
    ).toEqual([]);

    await list.getByRole('button', { name: `Xem chi tiết ${created.code}` }).click();
    const detail = adminPage.getByRole('region', { name: 'Chi tiết hồ sơ sai lệch' });
    await expect(detail).toContainText('Duyệt và áp dụng');
    await assertWorkspaceFits(adminPage, testInfo.outputPath('admin-adjustments-pending'));
    // Changing store also closes the document: guard the draft on this navigation path.
    const note = detail.getByRole('textbox', { name: 'Nội dung/lý do' });
    await note.fill('Đang đối chiếu chứng từ');
    const storeFilter = adminPage.getByRole('combobox', { name: 'Cửa hàng', exact: true });
    const otherStoreId = await storeFilter
      .locator('option')
      .evaluateAll(
        (options, currentId) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .find((id) => id !== '' && id !== currentId),
        store.id,
      );
    expect(otherStoreId).toBeTruthy();
    await storeFilter.selectOption(otherStoreId!);
    const draftDialog = adminPage.getByRole('alertdialog', { name: 'Bản nháp chưa gửi' });
    await expect(draftDialog).toBeVisible();
    await draftDialog.getByRole('button', { name: 'Ở lại' }).click();
    await expect(note).toHaveValue('Đang đối chiếu chứng từ');
    await expect(storeFilter).toHaveValue(store.id);
    await storeFilter.selectOption(otherStoreId!);
    await draftDialog.getByRole('button', { name: 'Bỏ nháp và chuyển' }).click();
    await expect(detail).toHaveCount(0);
    await expect(storeFilter).toHaveValue(otherStoreId!);
    await storeFilter.selectOption(store.id);
    await list.getByRole('button', { name: `Xem chi tiết ${created.code}` }).click();
    await expect(note).toHaveValue('');
    const verified = await tabApi(htkdPage).post(
      `${api}/receipt-adjustments/${created.id}/actions`,
      {
        headers: { 'idempotency-key': randomUUID() },
        data: {
          action: 'VERIFY',
          expectedVersion: 0,
          cause: 'SOURCE_MISCLASSIFICATION',
          note: 'HTKD đã đối chiếu ảnh',
          lines: [
            {
              receiptBagId: contextView.bags[0].receiptBagId,
              actualProductId: jeans!.id,
              weightKg: '20.000',
              pricePerKgVnd: 40_000,
              weightChangeNote: null,
            },
          ],
        },
      },
    );
    expect(verified.status()).toBe(200);

    // Approval happens in another session; the existing sync contract polls every 15 seconds.
    await expect(detail.locator('.adjustment-detail__header')).toContainText('Đã xử lý', {
      timeout: 25_000,
    });
    await expect(detail.locator('.adjustment-timeline')).toContainText('Duyệt và áp dụng');

    // The other two sessions show the same tag by themselves within one poll interval.
    for (const page of [storePage, htkdPage]) {
      await expect(page.locator('.adjustment-section')).toContainText('Đã xử lý', {
        timeout: 25_000,
      });
      await expect(page.locator('.adjustment-section')).not.toContainText('Chờ HTKD xác minh');
    }

    // The processed document leaves the pending slice but stays in the history.
    await expect(list).not.toContainText(created.code);
    await adminPage
      .getByRole('combobox', { name: 'Trạng thái' })
      .selectOption({ label: 'Đã xử lý (lịch sử)' });
    await expect(list).toContainText(created.code);
    await expect(list).toContainText('Đã có hiệu lực');

    // The URL restores the tab, filters and the opened document after a reload.
    await adminPage.reload();
    await expect(adminPage.getByRole('region', { name: 'Chi tiết hồ sơ sai lệch' })).toContainText(
      created.code,
    );
    await assertWorkspaceFits(adminPage, testInfo.outputPath('admin-adjustments-applied'));

    // Switching tab loads that tab's data only now.
    await tabs.getByRole('tab', { name: 'Kho tổng' }).click();
    await expect(
      adminPage.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' }),
    ).toBeVisible();
    expect(requested.some((path) => path.endsWith('/warehouse-inventory'))).toBe(true);
    expect(requested.some((path) => path.endsWith('/warehouse-outbound-history'))).toBe(false);
    await adminPage.goBack();
    await expect(tabs.getByRole('tab', { name: 'Phiếu sai lệch' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await client.close();
  }
});

async function assertWorkspaceFits(page: Page, screenshotPrefix: string) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const clipped = await page.evaluate(
      () =>
        [...document.querySelectorAll('.adjustment-workspace .button, .tabs__tab')].filter(
          (element) => element.scrollWidth > element.clientWidth + 1,
        ).length,
    );
    expect(clipped).toBe(0);
    if (width === 390 || width === 1440) {
      await page.screenshot({
        path: `${screenshotPrefix}-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

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

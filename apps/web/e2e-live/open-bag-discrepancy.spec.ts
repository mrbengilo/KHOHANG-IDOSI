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
    const table = tab.getByRole('table', { name: 'Lịch sử khui kiện', exact: true });
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.getByRole('columnheader')).toHaveText([
      'Thời gian khui',
      'Mã bao',
      'Mặt hàng',
      'Khối lượng',
      'Người thực hiện',
      'Trạng thái',
    ]);
    await expect(table.locator('tbody tr td').nth(3)).toHaveText('20 kg');
    await expect(table.locator('tbody tr td').nth(4)).toContainText('Cửa hàng sai lệch');
    await table.getByRole('button', { name: target!.displayCode!, exact: true }).click();
    await expect(
      tab.getByRole('dialog').getByText('Xác nhận khui bán', { exact: true }),
    ).toBeVisible();
    await tab.keyboard.press('Escape');
    await expect(tab.getByRole('dialog')).toHaveCount(0);
    await expect(
      table.getByRole('button', { name: target!.displayCode!, exact: true }),
    ).toBeFocused();
    await tab.getByRole('button', { name: 'Làm mới lịch sử' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
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
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await tab.reload();
    await expect(table.locator('tbody tr')).toHaveCount(3);
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await tab.setViewportSize({ width, height: 900 });
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(table.locator('thead')).toBeVisible();
      expect(
        await table
          .locator('tbody tr')
          .first()
          .evaluate((el) => getComputedStyle(el).display),
      ).toBe('table-row');
      const cells = await table
        .locator('tbody tr')
        .first()
        .locator('td')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
      expect(new Set(cells).size).toBe(1);
      const scroll = tab.locator('.bag-opening-history__scroll');
      if (width <= 768) {
        expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await scroll.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        expect(await scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await scroll.evaluate((el) => {
          el.scrollLeft = 0;
        });
      }
      await tab.screenshot({
        path: testInfo.outputPath('history-' + width + '.png'),
        fullPage: true,
        animations: 'disabled',
      });
    }

    // The supervisor sees the store actor, never their own account.
    await tab.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await expect(tab).toHaveURL(/\/login/);
    await login(tab, htkdLogin);
    await tab.goto('/open-bag');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(table.locator('tbody tr').first()).toContainText('Cửa hàng sai lệch');
    await expect(table.locator('tbody tr').first()).not.toContainText('HTKD sai lệch');
    await tab.getByRole('combobox', { name: 'Mặt hàng', exact: true }).selectOption(jeans!.id);
    await expect(tab.getByText('Chưa có lịch sử khui', { exact: true })).toBeVisible();
    await tab.getByRole('combobox', { name: 'Mặt hàng', exact: true }).selectOption(dress!.id);
    await expect(table.locator('tbody tr')).toHaveCount(3);
    // Control just the history response to exercise otherwise rare server states and pagination.
    const response = await tabApi(tab).get(api + '/store-bag-openings?storeId=' + store.id);
    const sample = (await response.json()).data[0];
    const samples = Array.from({ length: 21 }, (_, i) => ({
      ...sample,
      id: randomUUID(),
      bagId: randomUUID(),
      bagCode: 'MB-TEST-' + i,
      actorDisplayName: 'NGUYỄN DUY THÀNH VỚI TÊN RẤT DÀI KHÔNG ĐƯỢC CẮT MẤT THÔNG TIN',
      actorRole: 'HTKD',
      openedAt: '2026-09-25T09:00:23Z',
    }));
    let mode = 'rows';
    let lastQuery = new URLSearchParams();
    await tab.route('**/api/v1/store-bag-openings?**', async (route) => {
      lastQuery = new URL(route.request().url()).searchParams;
      if (mode === 'error' || mode === 'forbidden') {
        await route.fulfill({
          status: mode === 'forbidden' ? 403 : 500,
          json: {
            error: {
              code: mode === 'forbidden' ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: 'Không tải được lịch sử',
              requestId: 'history-e2e-error',
            },
          },
        });
      } else {
        const pageNumber = Number(lastQuery.get('page') ?? 1);
        await route.fulfill({
          json: {
            data: samples.slice((pageNumber - 1) * 20, pageNumber * 20),
            pagination: { page: pageNumber, pageSize: 20, totalItems: 21, totalPages: 2 },
          },
        });
      }
    });
    await tab.getByRole('button', { name: 'Làm mới lịch sử' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(20);
    const historySection = tab
      .locator('section.panel')
      .filter({ has: tab.getByRole('heading', { name: 'Lịch sử khui', exact: true }) });
    await historySection.getByRole('button', { name: 'Trang sau' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    expect(lastQuery.get('page')).toBe('2');
    await tab.getByLabel('Từ ngày (Việt Nam)').fill('2026-09-25');
    await tab.getByLabel('Đến hết ngày (Việt Nam)').fill('2026-09-25');
    await expect.poll(() => lastQuery.get('from')).toBe('2026-09-24T17:00:00.000Z');
    await expect.poll(() => lastQuery.get('to')).toBe('2026-09-25T17:00:00.000Z');
    expect(lastQuery.get('page')).toBe('1');
    await expect(table.locator('tbody tr').first()).toContainText('16:00:23 25/09/2026');
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await tab.setViewportSize({ width, height: 900 });
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const actor = table.locator('tbody tr').first().locator('.bag-opening-history__actor');
      expect(await actor.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const name = (await actor.locator('span').first().boundingBox())!;
      const badge = (await actor.locator('.badge').boundingBox())!;
      expect(name.y + name.height <= badge.y || name.x + name.width <= badge.x).toBe(true);
    }
    mode = 'error';
    await tab.getByRole('button', { name: 'Làm mới lịch sử' }).click();
    await expect(historySection.getByRole('alert')).toContainText('Không tải được lịch sử');
    mode = 'rows';
    await tab.getByRole('button', { name: 'Thử lại lịch sử' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(20);
    mode = 'forbidden';
    await tab.getByRole('button', { name: 'Làm mới lịch sử' }).click();
    await expect(historySection.getByRole('alert')).toContainText(
      'Bạn không có quyền xem lịch sử khui',
    );
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

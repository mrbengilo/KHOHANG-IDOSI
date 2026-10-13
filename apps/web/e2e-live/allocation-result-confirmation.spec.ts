import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  applyWarehouseMovement,
  createDatabase,
  products,
  respondAllocationDecision,
  users,
  withSerializableTransaction,
  type Database,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

import { balance, publishResult, signIn } from './allocation-result-fixture';
import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';
const VIEWPORTS = [360, 390, 412, 768, 1366, 1440] as const;

test('a store accepts and rejects allocation results; state survives reload, conflicts and lost responses', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 3 });
  const db = client.db;
  const adminLogin = {
    username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
    password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
  };
  try {
    const token = randomUUID().slice(0, 8);
    const productName = `Hàng xác nhận ${token}`;
    const carriedName = `Hàng giữ phiên trước ${token}`;
    const [product] = await db
      .insert(products)
      .values({ sku: `E2E-DEC-${token}`, slug: `e2e-dec-${token}`, name: productName })
      .returning();
    const [carriedProduct] = await db
      .insert(products)
      .values({ sku: `E2E-DEC-C-${token}`, slug: `e2e-dec-c-${token}`, name: carriedName })
      .returning();
    for (const productId of [product!.id, carriedProduct!.id]) {
      await withSerializableTransaction(db, (tx) =>
        applyWarehouseMovement(tx, {
          productId,
          eventType: 'opening_balance',
          onHandDelta: 50,
          reservedDelta: 0,
          sourceType: 'live_e2e_opening',
          sourceId: randomUUID(),
        }),
      );
    }

    expect((await page.request.post(`${api}/auth/login`, { data: adminLogin })).status()).toBe(200);
    const groups = await page.request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const created = await page.request.post(`${api}/stores`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        code: `UI_DEC_${token}`,
        name: `Cửa hàng xác nhận ${token}`,
        kind: 'RETAIL',
        groupId: (await groups.json()).data[0].id,
      },
    });
    expect(created.status()).toBe(201);
    const store = (await created.json()).data as { id: string; name: string };
    const storeLogin = { username: `store.dec.${token}`, password: `Test-only-${randomUUID()}!` };
    const account = await page.request.post(`${api}/admin/accounts`, {
      data: {
        ...storeLogin,
        displayName: 'Cửa hàng kiểm thử xác nhận',
        role: 'STORE',
        storeId: store.id,
      },
    });
    expect(account.status()).toBe(201);
    const storeUserId = (await account.json()).data.id as string;
    await page.request.post(`${api}/auth/logout`);
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);

    // Earlier session: priority goods only, accepted, so they are held for the next shipment.
    const earlier = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [{ productId: carriedProduct!.id, quantity: 2 }],
      shipment: false,
    });
    await respondAllocationDecision(db, {
      decisionId: earlier.decisionId,
      action: 'ACCEPT',
      expectedVersion: 1,
      actorUserId: storeUserId,
      idempotencyKey: randomUUID(),
      requestHash: 'live-e2e-earlier',
    });
    const toAccept = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [{ productId: product!.id, quantity: 3 }],
      shipment: true,
    });
    const toReject = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [{ productId: product!.id, quantity: 4 }],
      shipment: true,
      carry: earlier.reservationIds,
    });
    expect(await balance(db, product!.id)).toEqual({ onHand: 50, reserved: 7 });

    // 1. The persistent notice lists both results after login and links the exact document.
    await signIn(page, storeLogin);
    const notice = page.getByRole('complementary', { name: 'Kết quả phân bổ cần xác nhận' });
    await expect(notice).toContainText('Có kết quả phân bổ cần xác nhận (2)');
    await expect(notice.getByRole('listitem')).toHaveCount(2);
    await page.reload();
    await expect(notice).toContainText('(2)');
    await page.goto(`/allocations?decision=${toAccept.decisionId}`);
    const panel = page.locator('.allocation-decision');
    await expect(panel).toContainText('Chờ xác nhận');
    // Opening the document is not an answer.
    expect(await decisionStatus(db, toAccept.decisionId)).toBe('pending');

    // 2. Responsive: buttons, tag and table stay inside the screen at every reference width.
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await expect(panel.getByRole('button', { name: 'Chấp nhận' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await assertNoOverlap(page, [
        panel.getByRole('button', { name: 'Từ chối' }),
        panel.getByRole('button', { name: 'Chấp nhận' }),
      ]);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`decision-pending-${width}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // 3. A lost response: the outcome is unknown, so the retry reuses the same key and the
    //    server records the acceptance exactly once.
    const keys: string[] = [];
    let dropped = false;
    await page.route('**/allocation-decisions/*/respond?**', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!dropped) {
        dropped = true;
        // The request reaches the server; only the response is lost.
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });
    await panel.getByRole('button', { name: 'Chấp nhận' }).click();
    await expect(panel.locator('.form-error')).toContainText('Chưa rõ máy chủ đã ghi nhận');
    await panel.getByRole('button', { name: 'Chấp nhận' }).click();
    await expect(panel.locator('.allocation-decision__status > .badge')).toHaveText('Đã chấp nhận');
    await page.unroute('**/allocation-decisions/*/respond?**');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(panel).toContainText('Đã giao đi, chờ cửa hàng khai nhận');
    // Accepting created the RE order and issued its 3 bags (on-hand and reserved drop together).
    await expect(
      panel.getByRole('link', { name: /Đã đặt Reshare, mở đơn RE-\d{6}/u }),
    ).toBeVisible();
    await expect(panel).toContainText('Đã xuất 3 bao khỏi kho tổng theo đơn RE-');
    expect(await balance(db, product!.id)).toEqual({ onHand: 47, reserved: 4 });
    await page.screenshot({
      path: testInfo.outputPath('decision-accepted-1440.png'),
      fullPage: true,
    });
    await panel.getByRole('link', { name: 'Khai nhận thực tế' }).click();
    await page
      .locator('.receipt-create')
      .getByRole('button', { name: 'Nhận hàng', exact: true })
      .click();
    await page.locator('.receipt-source-card').first().click();
    const resultLink = page.getByRole('link', { name: /Phiếu kết quả/ });
    await expect(resultLink).toHaveAttribute(
      'href',
      `/allocations?decision=${toAccept.decisionId}`,
    );

    // 4. Rejection with an explicit confirmation naming the document and the quantity.
    await page.goto(`/allocations?decision=${toReject.decisionId}`);
    await expect(panel).toContainText('Hàng đã giữ từ phiên trước · 2 bao');
    await panel.getByRole('button', { name: 'Từ chối' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Từ chối nhận phiếu');
    await expect(dialog).toContainText('4 bao của phiếu này sẽ trả lại kho tổng');
    await expect(dialog).toContainText('2 bao hàng đã giữ từ phiên trước không bị hủy');
    await page.setViewportSize({ width: 360, height: 760 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath('decision-reject-dialog-360.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByLabel('Lý do (không bắt buộc)').fill('Cửa hàng đã đủ hàng');
    await dialog.getByRole('button', { name: 'Xác nhận từ chối' }).click();
    await expect(panel.locator('.allocation-decision__status > .badge')).toHaveText(
      'đã từ chối nhận',
    );
    await expect(panel).toContainText('Lý do: Cửa hàng đã đủ hàng');
    await page.reload();
    await expect(page.locator('.allocation-decision__status > .badge')).toHaveText(
      'đã từ chối nhận',
    );
    // Only the rejected grant went back; the carried goods stay issued with their own RE order
    // for the store (rejecting this result created no RE order and issued nothing).
    expect(await balance(db, product!.id)).toEqual({ onHand: 47, reserved: 0 });
    expect(await balance(db, carriedProduct!.id)).toEqual({ onHand: 48, reserved: 0 });
    await page.screenshot({
      path: testInfo.outputPath('decision-rejected-1440.png'),
      fullPage: true,
    });

    // 5. Another tab answered first: the stale screen never wins over the server.
    const raced = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [{ productId: product!.id, quantity: 1 }],
      shipment: true,
    });
    await page.goto(`/allocations?decision=${raced.decisionId}`);
    await expect(panel).toContainText('Chờ xác nhận');
    const otherTab = await tabApi(page).post(
      `${api}/allocation-decisions/${raced.decisionId}/respond`,
      {
        headers: { 'idempotency-key': randomUUID() },
        data: { action: 'ACCEPT', expectedVersion: 1 },
      },
    );
    expect(otherTab.status()).toBe(200);
    await panel.getByRole('button', { name: 'Từ chối' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận từ chối' }).click();
    await expect(page.getByRole('dialog').locator('.form-error')).toContainText(
      'đã được chấp nhận trước đó',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Quay lại' }).click();
    await expect(page.locator('.allocation-decision__status > .badge')).toHaveText('Đã chấp nhận');
    expect(await decisionStatus(db, raced.decisionId)).toBe('accepted');

    // 6. The notice is gone once nothing waits; the history still has the rejection tag.
    await page.goto('/allocations?decisionStatus=REJECTED');
    await expect(notice).toHaveCount(0);
    await expect(page.locator('.session-document')).toHaveCount(1);
    await expect(page.locator('.session-document')).toContainText('đã từ chối nhận');

    // 7. Admin reads every result but never answers for a store.
    await tabApi(page).post(`${api}/auth/logout`);
    await signIn(page, adminLogin);
    await page.goto(`/allocations?decision=${toReject.decisionId}`);
    await expect(page.locator('.allocation-decision__status > .badge')).toHaveText(
      'đã từ chối nhận',
    );
    await expect(
      page.locator('.allocation-decision').getByRole('button', { name: 'Chấp nhận' }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('decision-admin-390.png'), fullPage: true });
  } finally {
    await client.close();
  }
});

async function assertNoOverlap(page: Page, locators: ReturnType<Page['locator']>[]) {
  const boxes = [];
  for (const locator of locators) boxes.push(await locator.boundingBox());
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap).toBe(false);
    }
  }
  const width = page.viewportSize()!.width;
  for (const box of boxes) expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

async function decisionStatus(db: Database, decisionId: string) {
  const { allocationResultDecisions } = await import('@idosi/database');
  const [row] = await db
    .select({ status: allocationResultDecisions.status })
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, decisionId));
  return row?.status;
}

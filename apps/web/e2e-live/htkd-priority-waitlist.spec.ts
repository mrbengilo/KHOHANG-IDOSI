import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createDatabase,
  products,
  orderSessions,
  orderRequests,
  orderRequestItems,
  waitTickets,
  dailyPriorityOffers,
  applyWarehouseMovement,
  warehouseBalances,
} from '@idosi/database';
import { eq } from 'drizzle-orm';
import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';
async function login(page: Page, credentials: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('HTKD sees all assigned priority offers, reads central stock and cancels the shared wait with real audit', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!process.env.DATABASE_URL, 'Requires isolated PostgreSQL');
  const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
  const db = client.db;
  const token = randomUUID().slice(0, 8);
  const admin = {
    username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
    password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
  };
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [htkdPage, storePage, adminPage] = await Promise.all(contexts.map((c) => c.newPage()));
  let sessionId: string | undefined;
  try {
    expect((await request.post(`${api}/auth/login`, { data: admin })).status()).toBe(200);
    const groupId = (await (await request.get(`${api}/store-groups?pageSize=100`)).json()).data[0]
      .id;
    const stores: { id: string; name: string }[] = [];
    for (const label of ['A', 'B', 'C']) {
      const r = await request.post(`${api}/stores`, {
        headers: { 'idempotency-key': randomUUID() },
        data: {
          code: `HWT_${label}_${token}`,
          name: `HTKD wait ${label} ${token}`,
          kind: 'RETAIL',
          groupId,
        },
      });
      expect(r.status()).toBe(201);
      stores.push((await r.json()).data);
    }
    const createAccount = async (role: 'HTKD' | 'STORE', label: string, storeId?: string) => {
      const credentials = { username: `hwt.${label}.${token}`, password: `Test-${randomUUID()}!` };
      const r = await request.post(`${api}/admin/accounts`, {
        data: { ...credentials, displayName: label, role, ...(storeId ? { storeId } : {}) },
      });
      expect(r.status()).toBe(201);
      return { ...credentials, id: (await r.json()).data.id as string };
    };
    const htkd = await createAccount('HTKD', 'htkd');
    const owner = await createAccount('STORE', 'owner', stores[0]!.id);
    const noScope = await createAccount('HTKD', 'unassigned');
    const foreign = await createAccount('STORE', 'foreign', stores[2]!.id);
    const assignment = await request.put(`${api}/admin/accounts/${htkd.id}/assignments`, {
      data: {
        expectedSessionVersion: 0,
        storeIds: stores.slice(0, 2).map((s) => s.id),
        reason: 'Phạm vi kiểm thử HTKD',
      },
    });
    expect(assignment.status()).toBe(200);
    await login(htkdPage!, htkd);
    await login(storePage!, owner);
    await login(adminPage!, admin);
    await htkdPage!.goto('/');
    const [product] = await db
      .insert(products)
      .values({ sku: `HWT-${token}`, slug: `hwt-${token}`, name: `Hàng phiếu chờ ${token}` })
      .returning();
    const now = Date.now();
    const [session] = await db
      .insert(orderSessions)
      .values({
        code: '',
        kind: 'manual',
        businessDate: '2098-10-06',
        status: 'open',
        requestOpensAt: new Date(now - 7_200_000),
        inventorySnapshotDueAt: new Date(now - 60_000),
        requestDeadlineAt: new Date(now + 3_600_000),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning();
    sessionId = session!.id;
    const tickets: { id: string; code: string; offerId: string; offerCode: string }[] = [];
    await db.transaction(async (tx) => {
      await applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: 20,
        reservedDelta: 0,
        sourceType: 'live_htkd_fixture',
        sourceId: randomUUID(),
      });
      for (const [index, store] of stores.entries()) {
        const [order] = await tx
          .insert(orderRequests)
          .values({
            orderSessionId: session!.id,
            storeId: store.id,
            requestNumber: 1,
            status: 'allocated',
            requestedByUserId: index === 2 ? foreign.id : owner.id,
            submittedAt: new Date(now - 120_000),
          })
          .returning();
        const [line] = await tx
          .insert(orderRequestItems)
          .values({ orderRequestId: order!.id, productId: product!.id, requestedQuantity: 3 })
          .returning();
        const [ticket] = await tx
          .insert(waitTickets)
          .values({
            storeId: store.id,
            productId: product!.id,
            sourceOrderRequestItemId: line!.id,
            originalQuantity: 3,
            remainingQuantity: 3,
          })
          .returning();
        const [offer] = await tx
          .insert(dailyPriorityOffers)
          .values({
            businessDate: session!.businessDate,
            orderSessionId: session!.id,
            storeId: store.id,
            productId: product!.id,
            waitTicketId: ticket!.id,
            priorityLevel: 'P0B',
            offeredQuantity: 2,
            eligibleQuantityAtOffer: 3,
            stockHeldQuantity: 2,
            responseDeadlineAt: session!.requestDeadlineAt,
          })
          .returning();
        await applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: 2,
          sourceType: 'priority_offer',
          sourceId: offer!.id,
          eventSequence: 1,
        });
        tickets.push({
          id: ticket!.id,
          code: ticket!.code,
          offerId: offer!.id,
          offerCode: offer!.code,
        });
      }
    });
    const notices = htkdPage!.getByRole('complementary', {
      name: 'Thông báo xác nhận hàng ưu tiên',
    });
    await expect(notices).toContainText(stores[0]!.name, { timeout: 20_000 });
    await expect(notices).toContainText(stores[1]!.name);
    await expect(notices).not.toContainText(stores[2]!.name);
    await expect(notices).toContainText(tickets[0]!.offerCode);
    await expect(notices).toContainText(tickets[1]!.offerCode);
    const storeNotices = storePage!.getByRole('complementary', {
      name: 'Thông báo xác nhận hàng ưu tiên',
    });
    await expect(storeNotices).toContainText(tickets[0]!.offerCode, { timeout: 20_000 });
    await storeNotices.getByRole('button', { name: 'Nhận hàng', exact: true }).click();
    await expect(notices).not.toContainText(tickets[0]!.offerCode, { timeout: 20_000 });
    await htkdPage!.goto(`/inventory?kt.q=${product!.sku}&kt=history`);
    const stock = htkdPage!.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' });
    await expect(stock).toContainText(product!.name);
    await expect(stock.getByRole('button', { name: /Điều chỉnh tồn/ })).toHaveCount(0);
    const balances = (
      await db.select().from(warehouseBalances).where(eq(warehouseBalances.productId, product!.id))
    )[0]!;
    const apiStock = await tabApi(htkdPage!).get(
      `${api}/warehouse-inventory?search=${product!.sku}`,
    );
    expect(apiStock.status()).toBe(200);
    expect((await apiStock.json()).data[0].reservedBags).toBe(balances.reservedQuantity);
    expect(
      (
        await tabApi(htkdPage!).post(`${api}/warehouse-adjustments`, {
          data: {},
          headers: { 'idempotency-key': randomUUID() },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await tabApi(htkdPage!).get(`${api}/wait-tickets/${tickets[2]!.id}/history`)).status(),
    ).toBe(404);
    await htkdPage!.goto('/allocations');
    const row = htkdPage!.locator('.waitlist-panel article').filter({ hasText: tickets[1]!.code });
    await row.getByRole('button', { name: 'Hủy phiếu chờ', exact: true }).click();
    const dialog = htkdPage!.getByRole('dialog');
    await dialog.getByLabel('Lý do hủy').fill('HTKD hủy theo yêu cầu cửa hàng');
    await dialog.getByRole('button', { name: 'Hủy phiếu chờ', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('Đã bị hủy');
    const history = await tabApi(htkdPage!).get(`${api}/wait-tickets/${tickets[1]!.id}/history`);
    expect(
      (await history.json()).data.audit.some(
        (a: { action: string; actorRole: string }) =>
          a.action === 'WAIT_TICKET_HTKD_CANCELLED' && a.actorRole === 'HTKD',
      ),
    ).toBe(true);
    await adminPage!.goto(`/allocations?tab=wait-tickets&wt.q=${tickets[1]!.code}`);
    const table = adminPage!.locator('.wait-ticket-table');
    await expect(table.locator('th')).toHaveCount(9);
    await expect(table).toContainText('Đã bị hủy');
    await expect(table).toContainText('HTKD hủy theo yêu cầu cửa hàng');
    await adminPage!.reload();
    await expect(table).toContainText(tickets[1]!.code);
    for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
      await adminPage!.setViewportSize({ width, height: 900 });
      expect(
        await adminPage!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await adminPage!.screenshot({
        path: testInfo.outputPath(`htkd-wait-live-${width}.png`),
        fullPage: true,
      });
    }
    const revoked = await request.put(`${api}/admin/accounts/${htkd.id}/assignments`, {
      data: {
        expectedSessionVersion: (await assignment.json()).data.sessionVersion,
        storeIds: [],
        reason: 'Thu hồi để kiểm tra quyền hiện tại',
      },
    });
    expect(revoked.status()).toBe(200);
    expect([401, 403]).toContain(
      (await tabApi(htkdPage!).get(`${api}/wait-tickets/${tickets[1]!.id}/history`)).status(),
    );
    await login(htkdPage!, noScope);
    const empty = await tabApi(htkdPage!).get(`${api}/priority-offers?status=PENDING`);
    expect((await empty.json()).data).toEqual([]);
    expect((await tabApi(storePage!).get(`${api}/warehouse-inventory`)).status()).toBe(403);
  } finally {
    if (sessionId)
      await db
        .update(orderSessions)
        .set({ deletedAt: new Date() })
        .where(eq(orderSessions.id, sessionId));
    await Promise.all(contexts.map((context) => context.close()));
    await client.pool.end();
  }
});

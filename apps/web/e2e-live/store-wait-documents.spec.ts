import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  dailyPriorityOffers,
  inventorySnapshots,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  publishAllocationDecisionsInTransaction,
  reconcileStoreWaitDocumentsInTransaction,
  reservations,
  users,
  waitTickets,
  withSerializableTransaction,
  type Database,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

import { signIn } from './allocation-result-fixture';

const api = 'http://127.0.0.1:3100/api/v1';
const VIEWPORTS = [360, 390, 412, 768, 1366, 1440] as const;

/**
 * The store's three views and one store wait document per store (docs/store-active-wait-document.md):
 * B (2 nam + 2 nữ) merges with new demand into C (3 nam + 2 nữ + 3 trẻ em); 1 nam + 2 nữ granted
 * from C wait for the answer on the same C; confirming them in the result rolls the rest (2 nam +
 * 3 trẻ em) over to D; cancelling D closes it without an empty successor.
 */
test('a store reads its wait document, history and results; B → C → D through the real answer', async ({
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
    const names = { nam: `Nam ${token}`, nu: `Nữ ${token}`, tre: `Trẻ em ${token}` };
    const product: Record<keyof typeof names, string> = { nam: '', nu: '', tre: '' };
    for (const key of Object.keys(names) as (keyof typeof names)[]) {
      const [row] = await db
        .insert(products)
        .values({ sku: `E2E-WD-${key}-${token}`, slug: `e2e-wd-${key}-${token}`, name: names[key] })
        .returning();
      product[key] = row!.id;
      await withSerializableTransaction(db, (tx) =>
        applyWarehouseMovement(tx, {
          productId: row!.id,
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
        code: `UI_WD_${token}`,
        name: `Cửa hàng phiếu chờ ${token}`,
        kind: 'RETAIL',
        groupId: (await groups.json()).data[0].id,
      },
    });
    expect(created.status()).toBe(201);
    const store = (await created.json()).data as { id: string; name: string };
    const storeLogin = { username: `store.wd.${token}`, password: `Test-only-${randomUUID()}!` };
    const account = await page.request.post(`${api}/admin/accounts`, {
      data: { ...storeLogin, displayName: 'Cửa hàng phiếu chờ', role: 'STORE', storeId: store.id },
    });
    expect(account.status()).toBe(201);
    await page.request.post(`${api}/auth/logout`);
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const fixture = liveFixture(db, store.id, admin!.id);

    // Day 1: B waits for 2 nam + 2 nữ (the 09:00 run queues them and records B).
    const nam = await fixture.ticket(product.nam, 2);
    const nu = await fixture.ticket(product.nu, 2);
    await fixture.runEvent();
    // Day 2: 1 more nam on the same ticket and 3 trẻ em: C replaces B.
    await db
      .update(waitTickets)
      .set({ originalQuantity: 3, remainingQuantity: 3 })
      .where(eq(waitTickets.id, nam.id));
    const tre = await fixture.ticket(product.tre, 3);
    await fixture.runEvent();
    // The next run grants 1 nam + 2 nữ from C; the store has not answered yet.
    const pending = await fixture.ticketResult([
      { ticket: nam, quantity: 1 },
      { ticket: nu, quantity: 2 },
    ]);
    await fixture.runEvent();

    // 1. The store sees three clear views of its own store.
    await signIn(page, storeLogin);
    await page.goto('/allocations');
    const tabs = page.getByRole('tablist', { name: 'Nội dung phân bổ hàng hóa' });
    await expect(tabs.getByRole('tab')).toHaveText([
      'Kết quả phân bổ',
      'Lịch sử đặt hàng',
      'Phiếu chờ',
    ]);
    await tabs.getByRole('tab', { name: 'Phiếu chờ' }).click();
    const cards = page.locator('.wait-document-card');
    await expect(cards).toHaveCount(1);
    const current = cards.first();
    await expect(current).toContainText(/Phiếu chờ PCT-\d{6}/u);
    await expect(current).toContainText('Đang hoạt động');
    await expect(current).toContainText('Còn chờ phân bổ · có hàng chờ xác nhận');
    await expect(current).toContainText('còn chờ 5 bao · chờ xác nhận 3 bao');
    await expect(current.locator('tbody tr', { hasText: names.nam })).toContainText('2');
    await expect(current.locator('tbody tr', { hasText: names.tre })).toContainText('3');
    const codeC = (await current.locator('h3').innerText()).match(/PCT-\d{6}/u)![0];
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`wait-document-current-${width}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // 2. History keeps B with the exact tag and what it handed over; the link opens C.
    await page.getByRole('button', { name: 'Lịch sử đã xử lý' }).click();
    const merged = page.locator('.wait-document-card').first();
    await expect(merged).toContainText(`Đã xử lý · Gộp vào phiếu ${codeC}`);
    await expect(merged.locator('tbody tr', { hasText: names.nu })).toContainText('2');
    await merged.getByRole('button', { name: /Xem chi tiết phiếu chờ/u }).click();
    const detail = page.locator('.wait-document-detail');
    await expect(detail).toContainText('Phần còn chờ của cửa hàng nằm ở phiếu hiện hành');
    await expect(detail).toContainText('Dòng thời gian phiếu');
    await page.reload();
    await expect(detail).toContainText(`Gộp vào phiếu ${codeC}`);
    await detail.getByRole('button', { name: codeC }).first().click();
    await expect(detail.locator('h3')).toHaveText(`Phiếu chờ ${codeC}`);
    await expect(detail).toContainText('Hàng đã cấp đang chờ xác nhận');
    await page.screenshot({
      path: testInfo.outputPath('wait-document-detail-1440.png'),
      fullPage: true,
    });

    // 3. From C, open the PENDING result and confirm it: D keeps only 2 nam + 3 trẻ em.
    await detail.getByRole('button', { name: 'Mở kết quả' }).first().click();
    await expect(page).toHaveURL(new RegExp(`decision=${pending.decisionId}`, 'u'));
    const panel = page.locator('.allocation-decision');
    await panel.getByRole('button', { name: 'Xác nhận phân bổ' }).click();
    await expect(panel.locator('.allocation-decision__status > .badge')).toHaveText(
      'Đã xác nhận phân bổ',
    );
    await page.goto('/allocations?tab=wait-tickets');
    const next = page.locator('.wait-document-card').first();
    await expect(next.locator('h3')).not.toContainText(codeC);
    await expect(next).toContainText(`Từ phiếu ${codeC}`);
    await expect(next.locator('tbody tr')).toHaveCount(2);
    await expect(next).not.toContainText(names.nu);
    await page.goto(`/allocations?tab=wait-tickets&wdView=HISTORY&wdQ=${codeC}`);
    const rolled = page.locator('.wait-document-card').first();
    await expect(rolled).toContainText('Đã xử lý · Chuyển phần còn lại sang phiếu PCT-');
    await expect(rolled.locator('tbody tr', { hasText: names.nu })).toContainText('2');

    // 4. Order history of the store's own requests, and the results view.
    await page.goto('/allocations?tab=history');
    await expect(page.locator('.order-history')).toContainText(names.nam);
    await page.screenshot({
      path: testInfo.outputPath('store-order-history-1440.png'),
      fullPage: true,
    });

    // 5. Cancelling D with its preview closes it; nothing current is left, no empty successor.
    await page.goto('/allocations?tab=wait-tickets');
    await page
      .locator('.wait-document-card')
      .first()
      .getByRole('button', { name: /Xem chi tiết/u })
      .click();
    await page
      .locator('.wait-document-detail')
      .getByRole('button', { name: 'Hủy phiếu chờ' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`hủy 2 bao`);
    await expect(dialog).toContainText(`hủy 3 bao`);
    await page.setViewportSize({ width: 360, height: 760 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath('wait-document-cancel-360.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByLabel('Lý do hủy').fill('Cửa hàng không cần nữa');
    await dialog.getByRole('button', { name: 'Xác nhận hủy phiếu chờ' }).click();
    await expect(page.getByRole('status')).toContainText('Đã hủy phiếu');
    await page.goto('/allocations?tab=wait-tickets');
    await expect(page.getByText('Không có phiếu chờ đang hoạt động')).toBeVisible();
    expect(tre.id).toBeTruthy();
  } finally {
    await client.close();
  }
});

function liveFixture(db: Database, storeId: string, adminId: string) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  );
  const session = async () => {
    const token = randomUUID().replaceAll('-', '');
    const [row] = await db
      .insert(orderSessions)
      .values({
        code: `E2E-WD-${token}`,
        kind: 'manual',
        businessDate: date,
        status: 'completed',
        openedAt: new Date(`${date}T00:00:00+07:00`),
        inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
        requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning();
    return row!;
  };
  return {
    /** An active ticket queued from an order of its own session, as the run leaves it. */
    async ticket(productId: string, quantity: number) {
      const owner = await session();
      const [order] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: owner.id,
          storeId,
          requestNumber: 1,
          status: 'waitlisted',
          submittedAt: new Date(),
          requestedByUserId: adminId,
        })
        .returning();
      const [item] = await db
        .insert(orderRequestItems)
        .values({ orderRequestId: order!.id, productId, requestedQuantity: quantity })
        .returning();
      const [ticket] = await db
        .insert(waitTickets)
        .values({
          storeId,
          productId,
          sourceOrderRequestItemId: item!.id,
          status: 'active',
          priorityLevel: 'P0B',
          originalQuantity: quantity,
          remainingQuantity: quantity,
          fulfilledQuantity: 0,
        })
        .returning();
      return ticket!;
    },
    /** The run's last write: the store's document follows its waiting demand. */
    async runEvent() {
      await withSerializableTransaction(db, (tx) =>
        reconcileStoreWaitDocumentsInTransaction(tx, [
          {
            storeId,
            event: {
              kind: 'allocation_run',
              sourceKey: `live-e2e:${randomUUID()}`,
              actorUserId: null,
              occurredAt: new Date(),
            },
          },
        ]),
      );
    },
    /** P0A lines granted from tickets and held for a PENDING result (no shipment yet). */
    async ticketResult(
      grants: readonly { ticket: typeof waitTickets.$inferSelect; quantity: number }[],
    ) {
      const owner = await session();
      const [snapshot] = await db
        .insert(inventorySnapshots)
        .values({
          orderSessionId: owner.id,
          businessDate: date,
          snapshotType: 'manual',
          status: 'completed',
          capturedAt: new Date(),
          completedAt: new Date(),
          balanceVersion: 0,
        })
        .returning();
      const [run] = await db
        .insert(allocationRuns)
        .values({
          orderSessionId: owner.id,
          inventorySnapshotId: snapshot!.id,
          runNumber: 1,
          status: 'running',
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
          idempotencyKey: randomUUID(),
        })
        .returning();
      for (const [index, grant] of grants.entries()) {
        const [ticket] = await db
          .select()
          .from(waitTickets)
          .where(eq(waitTickets.id, grant.ticket.id));
        const [offer] = await db
          .insert(dailyPriorityOffers)
          .values({
            businessDate: date,
            orderSessionId: owner.id,
            storeId,
            productId: ticket!.productId,
            waitTicketId: ticket!.id,
            priorityLevel: 'P0A',
            offeredQuantity: grant.quantity,
            eligibleQuantityAtOffer: ticket!.remainingQuantity,
            acceptedQuantity: grant.quantity,
            status: 'accepted',
            // Offered by the 08:00 job, not "now": after 09:00 a default createdAt would put the
            // offer after its own deadline and break the PriorityOffer contract for every list reader.
            createdAt: new Date(`${date}T08:00:00+07:00`),
            responseDeadlineAt: new Date(`${date}T09:00:00+07:00`),
            respondedAt: new Date(`${date}T08:30:00+07:00`),
          })
          .returning();
        const [line] = await db
          .insert(allocationLines)
          .values({
            allocationRunId: run!.id,
            storeId,
            productId: ticket!.productId,
            waitTicketId: ticket!.id,
            priorityOfferId: offer!.id,
            priorityLevel: 'P0A',
            roundNumber: 1,
            sequenceInRound: index + 1,
            requestedQuantity: grant.quantity,
            allocatedQuantity: grant.quantity,
            waitlistedQuantity: 0,
            status: 'allocated',
            reasonCode: 'LIVE_E2E_WAIT_DOCUMENT',
          })
          .returning();
        await db.insert(reservations).values({
          productId: ticket!.productId,
          storeId,
          allocationLineId: line!.id,
          quantity: grant.quantity,
        });
        await withSerializableTransaction(db, (tx) =>
          applyWarehouseMovement(tx, {
            productId: ticket!.productId,
            eventType: 'reservation',
            onHandDelta: 0,
            reservedDelta: grant.quantity,
            sourceType: 'allocation_run',
            sourceId: run!.id,
            eventSequence: index + 1,
          }),
        );
        const remaining = ticket!.remainingQuantity - grant.quantity;
        await db
          .update(waitTickets)
          .set({
            remainingQuantity: remaining,
            fulfilledQuantity: ticket!.fulfilledQuantity + grant.quantity,
            status: remaining === 0 ? 'fulfilled' : 'active',
            resolvedAt: remaining === 0 ? new Date() : null,
          })
          .where(eq(waitTickets.id, ticket!.id));
      }
      const decisions = await withSerializableTransaction(db, (tx) =>
        publishAllocationDecisionsInTransaction(tx, {
          allocationRunId: run!.id,
          orderSessionId: owner.id,
          publishedAt: new Date(),
        }),
      );
      await db
        .update(allocationRuns)
        .set({ status: 'completed' })
        .where(eq(allocationRuns.id, run!.id));
      return { decisionId: decisions.find((row) => row.storeId === storeId)!.id };
    },
  };
}

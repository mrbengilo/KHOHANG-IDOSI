import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  publishAllocationDecisionsInTransaction,
  reservations,
  respondAllocationDecision,
  users,
  warehouseBalances,
  withSerializableTransaction,
  type Database,
} from '@idosi/database';
import { eq, inArray } from 'drizzle-orm';

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
    await page.route('**/allocation-decisions/*/respond', async (route) => {
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
    await expect(panel.locator('.badge')).toHaveText('Đã chấp nhận');
    await page.unroute('**/allocation-decisions/*/respond');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(panel).toContainText('Đã xuất kho, chờ cửa hàng khai nhận');
    expect(await balance(db, product!.id)).toEqual({ onHand: 50, reserved: 7 });
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
    await expect(panel.locator('.badge')).toHaveText('đã từ chối nhận');
    await expect(panel).toContainText('Lý do: Cửa hàng đã đủ hàng');
    await page.reload();
    await expect(page.locator('.allocation-decision .badge')).toHaveText('đã từ chối nhận');
    // Only the rejected grant went back; the carried goods stay held for the store.
    expect(await balance(db, product!.id)).toEqual({ onHand: 50, reserved: 3 });
    expect(await balance(db, carriedProduct!.id)).toEqual({ onHand: 50, reserved: 2 });
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
    await expect(page.locator('.allocation-decision .badge')).toHaveText('Đã chấp nhận');
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
    await expect(page.locator('.allocation-decision .badge')).toHaveText('đã từ chối nhận');
    await expect(
      page.locator('.allocation-decision').getByRole('button', { name: 'Chấp nhận' }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('decision-admin-390.png'), fullPage: true });
  } finally {
    await client.close();
  }
});

async function signIn(page: Page, login: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(login.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(login.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

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

async function balance(db: Database, productId: string) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return { onHand: row!.onHandQuantity, reserved: row!.reservedQuantity };
}

async function decisionStatus(db: Database, decisionId: string) {
  const { allocationResultDecisions } = await import('@idosi/database');
  const [row] = await db
    .select({ status: allocationResultDecisions.status })
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, decisionId));
  return row?.status;
}

/** Persists exactly what the 09:00 run writes for one store: lines, holds, decision, shipment. */
async function publishResult(
  db: Database,
  input: {
    storeId: string;
    adminId: string;
    grants: readonly { productId: string; quantity: number }[];
    shipment: boolean;
    carry?: readonly string[];
  },
) {
  const token = randomUUID().replaceAll('-', '');
  const now = new Date();
  // The schedule must fall on the Asia/Ho_Chi_Minh business date, as real sessions do.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `E2E-DEC-${token}`,
      kind: 'manual',
      businessDate: date,
      status: 'completed',
      openedAt: new Date(`${date}T00:00:00+07:00`),
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session!.id,
      businessDate: date,
      snapshotType: 'manual',
      status: 'completed',
      capturedAt: now,
      completedAt: now,
      balanceVersion: 0,
    })
    .returning();
  const [run] = await db
    .insert(allocationRuns)
    .values({
      orderSessionId: session!.id,
      inventorySnapshotId: snapshot!.id,
      runNumber: 1,
      status: 'running',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: now,
      requestedByUserId: input.adminId,
    })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      status: 'allocated',
      requestCount: 1,
    })
    .returning();
  const reservationIds: string[] = [];
  const lineIds: string[] = [];
  for (const [index, grant] of input.grants.entries()) {
    const [item] = await db
      .insert(orderRequestItems)
      .values({
        orderRequestId: order!.id,
        productId: grant.productId,
        requestedQuantity: grant.quantity,
      })
      .returning();
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId: grant.productId,
        requestedQuantity: grant.quantity,
        priorityLevel: 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: item!.id,
      requestedQuantity: grant.quantity,
    });
    const [line] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: run!.id,
        mergedOrderId: merged!.id,
        storeId: input.storeId,
        productId: grant.productId,
        orderRequestItemId: item!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: index + 1,
        requestedQuantity: grant.quantity,
        allocatedQuantity: grant.quantity,
        status: 'allocated',
        reasonCode: 'LIVE_E2E_DECISION',
      })
      .returning();
    lineIds.push(line!.id);
    const [reservation] = await db
      .insert(reservations)
      .values({
        productId: grant.productId,
        storeId: input.storeId,
        allocationLineId: line!.id,
        quantity: grant.quantity,
      })
      .returning();
    reservationIds.push(reservation!.id);
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: grant.productId,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: grant.quantity,
        sourceType: 'allocation_run',
        sourceId: run!.id,
        eventSequence: index + 1,
      }),
    );
  }
  const [decision] = await withSerializableTransaction(db, (tx) =>
    publishAllocationDecisionsInTransaction(tx, {
      allocationRunId: run!.id,
      orderSessionId: session!.id,
      publishedAt: now,
    }),
  );
  if (input.shipment) {
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId: input.storeId,
        orderSessionId: session!.id,
        allocationRunId: run!.id,
        status: 'reserved',
        requestedByUserId: input.adminId,
        submittedAt: now,
        approvedAt: now,
      })
      .returning();
    const carried = input.carry?.length
      ? await db
          .select()
          .from(reservations)
          .where(inArray(reservations.id, [...input.carry]))
      : [];
    const rows = [
      ...input.grants.map((grant, index) => ({
        productId: grant.productId,
        quantity: grant.quantity,
        lineId: lineIds[index]!,
        reservationId: reservationIds[index]!,
      })),
      ...carried.map((row) => ({
        productId: row.productId,
        quantity: row.quantity,
        lineId: row.allocationLineId!,
        reservationId: row.id,
      })),
    ];
    for (const productId of new Set(rows.map((row) => row.productId))) {
      const sources = rows.filter((row) => row.productId === productId);
      const quantity = sources.reduce((total, row) => total + row.quantity, 0);
      const [outboundLine] = await db
        .insert(outboundRequestLines)
        .values({
          outboundRequestId: outbound!.id,
          productId,
          allocationLineId: sources[0]!.lineId,
          requestedQuantity: quantity,
          approvedQuantity: quantity,
          reservedQuantity: quantity,
        })
        .returning();
      await db
        .update(reservations)
        .set({ outboundRequestLineId: outboundLine!.id })
        .where(
          inArray(
            reservations.id,
            sources.map((row) => row.reservationId),
          ),
        );
    }
  }
  await db
    .update(allocationRuns)
    .set({ status: 'completed' })
    .where(eq(allocationRuns.id, run!.id));
  return { decisionId: decision!.id, reservationIds };
}

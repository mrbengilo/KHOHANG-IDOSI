import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  allocationLines,
  allocationResultDecisions,
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
  products,
  reservations,
  stores,
  users,
  warehouseBalances,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu', { exact: true })
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/u);
}

type Client = ReturnType<typeof createDatabase>;

/** What the 09:00 run leaves after granting `quantity` and the store accepting the result. */
async function acceptedGrant(client: Client, storeId: string, productId: string, quantity: number) {
  const db = client.db;
  const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
  const day = new Date(Date.UTC(2045 + Math.floor(Math.random() * 40), 0, 1));
  day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 360));
  const date = day.toISOString().slice(0, 10);
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `RS-E2E-${randomUUID().slice(0, 8)}`,
      kind: 'manual',
      businessDate: date,
      status: 'completed',
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      completedAt: new Date(),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: admin!.id,
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session!.id,
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
      orderSessionId: session!.id,
      inventorySnapshotId: snapshot!.id,
      runNumber: 1,
      status: 'completed',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session!.id,
      storeId,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: new Date(),
      requestedByUserId: admin!.id,
    })
    .returning();
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: order!.id, productId, requestedQuantity: quantity })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({ orderSessionId: session!.id, storeId, status: 'allocated', requestCount: 1 })
    .returning();
  const [mergedItem] = await db
    .insert(mergedOrderItems)
    .values({
      mergedOrderId: merged!.id,
      productId,
      requestedQuantity: quantity,
      priorityLevel: 'P1',
    })
    .returning();
  await db.insert(mergedOrderSources).values({
    mergedOrderItemId: mergedItem!.id,
    orderRequestItemId: item!.id,
    requestedQuantity: quantity,
  });
  const [line] = await db
    .insert(allocationLines)
    .values({
      allocationRunId: run!.id,
      mergedOrderId: merged!.id,
      storeId,
      productId,
      orderRequestItemId: item!.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: quantity,
      allocatedQuantity: quantity,
      status: 'allocated',
      reasonCode: 'LIVE_E2E_RESHARE',
    })
    .returning();
  await db.insert(reservations).values({
    productId,
    storeId,
    allocationLineId: line!.id,
    quantity,
  });
  await db.transaction((tx) =>
    applyWarehouseMovement(tx, {
      productId,
      eventType: 'reservation',
      onHandDelta: 0,
      reservedDelta: quantity,
      sourceType: 'allocation_run',
      sourceId: run!.id,
    }),
  );
  await db.insert(allocationResultDecisions).values({
    allocationRunId: run!.id,
    orderSessionId: session!.id,
    storeId,
    status: 'accepted',
    grantedQuantity: quantity,
    respondedAt: new Date(),
    respondedByUserId: admin!.id,
  });
  return session!.code;
}

test('AC01: Reshare shows 3, A granted 3, C re-observes 3 → nothing more is allocatable', async ({
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
    const name = `Đồ nam Reshare ${token}`;
    const [product] = await db
      .insert(products)
      .values({ sku: `RS-UI-${token}`, slug: `rs-ui-${token}`, name })
      .returning();
    const [reference] = await db.select().from(stores).limit(1);
    const [store] = await db
      .insert(stores)
      .values({
        code: `RS-${token}`,
        name: `Cửa hàng Reshare ${token}`,
        groupId: reference!.groupId,
      })
      .returning();

    await login(page);
    // A dedicated source keeps this run independent of sources other suites created.
    const created = await tabApi(page).post(`${api}/supplier-sources`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { code: `RS-${token.toUpperCase()}`, name: `Reshare E2E ${token}` },
    });
    expect(created.status()).toBe(201);
    const sourceId = ((await created.json()) as { data: { id: string } }).data.id;

    // Configuration through the UI: pick the source, then the SKU.
    await page.goto('/supplier-reconciliation?tab=settings');
    const settings = page.getByRole('region', { name: 'Cấu hình nguồn Reshare' });
    const sourceSelect = settings.getByLabel('Nguồn đang cấu hình');
    if (await sourceSelect.count()) await sourceSelect.selectOption(sourceId);
    await settings.getByRole('checkbox', { name: new RegExp(name, 'u') }).check();
    await settings.getByRole('button', { name: /Đưa 1 mặt hàng vào đối chiếu/u }).click();
    await expect(settings.getByRole('status')).toContainText('Đã đưa 1 mặt hàng');

    // Legacy cumulative inbound is now refused for this SKU.
    const inbound = await tabApi(page).post(`${api}/inbound-receipts`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        supplierName: 'Reshare',
        receivedAt: new Date().toISOString(),
        bags: [{ productId: product!.id, bagCode: `B-${randomUUID()}`, weightKg: null }],
      },
    });
    expect(inbound.status()).toBe(409);
    expect(((await inbound.json()) as { error: { code: string } }).error.code).toBe(
      'SOURCE_RECONCILED',
    );

    const reconcile = async (quantity: string, expectedNotice: string) => {
      await page.goto('/supplier-reconciliation?tab=reconcile');
      const summary = page.getByRole('region', { name: 'Cập nhật tồn Reshare theo mặt hàng' });
      await summary.getByLabel('Tìm mặt hàng').fill(product!.sku);
      await summary.getByRole('button', { name: 'Tìm', exact: true }).click();
      const row = summary.getByRole('row').filter({ hasText: product!.sku }).first();
      await row.getByRole('button', { name: 'Đối chiếu', exact: true }).click();
      await page.getByLabel(`Tổng số bao Reshare đang cho đặt của ${product!.sku}`).fill(quantity);
      await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeVisible();
      const attest = page.getByLabel(/Tôi xác nhận các lượng giữ trước khi bật đối chiếu/u);
      if (await attest.count()) await attest.check();
      if (await page.getByRole('button', { name: 'Xem trước lại' }).isEnabled()) {
        await page.getByRole('button', { name: 'Xem trước lại' }).click();
      }
      await page.getByRole('button', { name: 'Lưu cập nhật tồn' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Đã lưu cập nhật tồn' }),
      ).toContainText(expectedNotice);
    };

    // Day 1: C sees 3 at Reshare; all 3 are free.
    await reconcile('3', `${product!.sku}: khả dụng 0 → 3 bao (+3).`);
    // The 09:00 run grants all 3 and the store accepts; HTKD has not ordered at Reshare yet.
    const sessionCode = await acceptedGrant(client, store!.id, product!.id, 3);
    // Day 2: Reshare still shows 3. Re-observing never adds them again.
    await reconcile('3', `${product!.sku}: khả dụng giữ nguyên 0 bao.`);
    const [balance] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, product!.id));
    expect(balance).toMatchObject({ onHandQuantity: 3, reservedQuantity: 3 });

    // The drill-down names the store, session and the bags still to order at Reshare.
    const summary = page.getByRole('region', { name: 'Cập nhật tồn Reshare theo mặt hàng' });
    const row = summary.getByRole('row').filter({ hasText: product!.sku }).first();
    await row.getByRole('button', { name: 'Xem giữ hàng' }).click();
    await expect(row.getByRole('button', { name: 'Thu gọn' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(summary).toContainText(store!.code);
    await expect(summary).toContainText(sessionCode);
    await expect(summary).toContainText('Chưa đặt Reshare');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath(`supplier-reconciliation-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // A hold accepted before RE orders existed keeps the old manual record (old data section).
    await page.goto('/supplier-reconciliation?tab=legacy');
    const queue = page.getByRole('region', { name: 'Hàng giữ trước khi có đơn RE' });
    await queue.getByLabel('Mặt hàng').selectOption(product!.id);
    await queue.getByRole('checkbox', { name: `Chọn ${product!.sku} của ${store!.code}` }).check();
    await queue
      .getByLabel(`Số bao Reshare đã nhận cho ${product!.sku} của ${store!.code}`)
      .fill('3');
    await queue.getByLabel('Mã đơn Reshare').fill(`RS-ORDER-${token}`);
    await queue.getByRole('button', { name: 'Ghi nhận đơn Reshare' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Đã ghi nhận đơn Reshare' }),
    ).toContainText('Khả dụng không đổi');
    const [after] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, product!.id));
    // Ordering at Reshare neither frees stock nor releases the hold before receipt.
    expect(after).toMatchObject({ onHandQuantity: 3, reservedQuantity: 3 });
    const history = page.getByRole('region', { name: 'Lịch sử đơn Reshare' });
    await expect(history).toContainText(`RS-ORDER-${token}`);

    const reconciliation = await tabApi(page).get(
      `${api}/supplier-reconciliation?search=${encodeURIComponent(product!.sku)}`,
    );
    const body = (await reconciliation.json()) as {
      data: { position: { freeQuantity: number; unorderedCommitmentQuantity: number } }[];
    };
    expect(body.data[0]!.position).toMatchObject({
      freeQuantity: 0,
      unorderedCommitmentQuantity: 0,
    });
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});

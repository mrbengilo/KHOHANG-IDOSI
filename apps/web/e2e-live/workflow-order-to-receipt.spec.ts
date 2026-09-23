import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';
import {
  applyWarehouseMovement,
  createDatabase,
  orderSessions,
  products,
  storeInventoryBags,
  warehouseBalances,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

// Named to run after the other live suites: it publishes the allocation of the shared
// ordering session, which is what a real 09:00 run does to every store's open orders.
const api = 'http://127.0.0.1:3100/api/v1';

interface AllocationJobRepository {
  captureSnapshotAndCreateOffers(session: unknown, now: Date): Promise<unknown>;
  expireOffersAndFinalizeAllocation(
    session: unknown,
    now: Date,
  ): Promise<{ replayed: boolean; resourceId: string }>;
}

test('an order approved by the 09:00 allocation reaches the store and can be received', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  try {
    const token = randomUUID().slice(0, 8);
    const productName = `Hàng giao nhận ${token}`;
    const [product] = await client.db
      .insert(products)
      .values({ sku: `E2E-RCV-${token}`, slug: `e2e-rcv-${token}`, name: productName })
      .returning();
    await client.db.transaction((tx) =>
      applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: 5,
        reservedDelta: 0,
        sourceType: 'live_e2e_opening',
        sourceId: randomUUID(),
        reason: 'Live order-to-receipt workflow stock',
        occurredAt: new Date(),
      }),
    );

    const admin = await page.request.post(`${api}/auth/login`, {
      data: {
        username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
        password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
      },
    });
    expect(admin.status()).toBe(200);
    const groups = await page.request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const created = await page.request.post(`${api}/stores`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        code: `UI_RCV_${token}`,
        name: `Cửa hàng nhận ${token}`,
        kind: 'RETAIL',
        groupId: (await groups.json()).data[0].id,
      },
    });
    expect(created.status()).toBe(201);
    const store = (await created.json()).data as { id: string };
    const username = `store.rcv.${token}`;
    const password = `Test-only-${randomUUID()}!`;
    const account = await page.request.post(`${api}/admin/accounts`, {
      data: {
        username,
        password,
        displayName: 'Cửa hàng kiểm thử nhận',
        role: 'STORE',
        storeId: store.id,
      },
    });
    expect(account.status()).toBe(201);
    await page.request.post(`${api}/auth/logout`);

    // 1. The store orders two bags through the ordering screen.
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(username);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.getByRole('link', { name: 'Đặt hàng', exact: true }).click();
    await page.getByRole('checkbox', { name: productName }).check();
    await page.getByRole('button', { name: `Tăng số bao ${productName}` }).click();
    const orderResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/order-requests' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng' }).click();
    const order = (await (await orderResponse).json()).data as { sessionId: string };

    // 2. The 09:00 run approves the allocation; nobody has to release the shipment by hand.
    const [session] = await client.db
      .select()
      .from(orderSessions)
      .where(eq(orderSessions.id, order.sessionId));
    const scheduled = {
      id: session!.id,
      businessDate: session!.businessDate,
      snapshotDueAt: session!.inventorySnapshotDueAt,
      finalDueAt: session!.requestDeadlineAt,
      policyVersion: session!.policyVersion,
    };
    const processedAt = new Date(
      Math.max(Date.now(), session!.requestDeadlineAt.getTime()) + 1_000,
    );
    const workerModule = (await import(
      pathToFileURL(resolve(process.cwd(), '../worker/dist/postgres-repository.js')).href
    )) as { PostgresAllocationJobRepository: new (client: unknown) => AllocationJobRepository };
    const worker = new workerModule.PostgresAllocationJobRepository(client);
    await worker.captureSnapshotAndCreateOffers(scheduled, processedAt);
    const allocation = await worker.expireOffersAndFinalizeAllocation(scheduled, processedAt);
    // A retried run must not ship the same goods twice.
    expect((await worker.expireOffersAndFinalizeAllocation(scheduled, processedAt)).replayed).toBe(
      true,
    );
    expect(allocation.resourceId).toBeTruthy();

    // 3. The slip is on /receive at once, with the product and the approved bag count.
    await page.goto('/receive');
    const createPanel = page.locator('.receipt-create');
    await createPanel.getByRole('button', { name: /Tạo phiếu/ }).click();
    const card = page
      .locator('[aria-label="Lệnh xuất đang chờ nhận"]')
      .getByRole('button')
      .filter({ hasText: productName });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Duyệt 2 · giao 2');
    for (const width of [360, 390, 768, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(card).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath('store-receive-slip.png'),
      animations: 'disabled',
      fullPage: true,
    });

    // 4. The store confirms receipt and sends it to HTKD.
    await card.click();
    await page.getByRole('button', { name: 'Lưu phiếu nháp' }).click();
    await expect(page.getByText('Đã tạo phiếu nháp.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Gửi HTKD duyệt' }).click();
    await expect(page.getByText('Đã gửi số thực nhận cho HTKD duyệt.')).toBeVisible();

    // Stock rules: the warehouse keeps the two bags reserved until HTKD finalizes, and the
    // store gains nothing before that.
    const [balance] = await client.db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, product!.id));
    expect(balance).toMatchObject({ onHandQuantity: 5, reservedQuantity: 2 });
    const storeBags = await client.db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store.id));
    expect(storeBags).toHaveLength(0);
  } finally {
    await client.close();
  }
});

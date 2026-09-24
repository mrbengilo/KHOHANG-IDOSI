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

    // 5. HTKD enters kg, costs and the VAT printed on the actual delivery note, then books it.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
    await page
      .getByLabel('Mật khẩu', { exact: true })
      .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/receive');
    await page
      .locator('.receipt-filters select')
      .first()
      .selectOption({ label: `UI_RCV_${token} · Cửa hàng nhận ${token}` });
    const review = page.locator('.receipt-detail');
    await expect(review.getByRole('button', { name: /Chốt giá & nhập kho/ })).toBeVisible();
    await review.getByLabel('Giá nhập / kg (VND)').fill('20000');
    await review.getByLabel('Khối lượng bao 1 (kg)').fill('30');
    await review.getByLabel('Khối lượng bao 2 (kg)').fill('25,5');
    await review.getByLabel('Phí vận chuyển (VND)').fill('10000');
    await review.getByLabel('Phí bốc xếp (VND)').fill('5000');
    const vat = review.getByLabel('VAT 8% theo phiếu (VND)');
    await expect(vat).toHaveValue('');
    await expect(vat).toHaveAttribute('required', '');
    await review.getByRole('button', { name: /Chốt giá & nhập kho/ }).click();
    await expect(review.getByRole('alert')).toContainText('Nhập VAT theo phiếu nhận hàng thực tế');
    await vat.fill('44000');
    await expect(vat).toHaveValue('44,000');
    // Preview: landed cost excludes VAT, the receipt total adds it.
    const preview = review.locator('.receipt-totals');
    await expect(preview).toContainText(/Giá vốn \(không gồm VAT\)\s*1\.125\.000/);
    await expect(preview).toContainText(/Tổng tiền phiếu \(gồm VAT\)\s*1\.169\.000/);
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(vat).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await review.locator('.receipt-fees').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('htkd-receipt-vat-mobile.png'),
      animations: 'disabled',
      fullPage: true,
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath('htkd-receipt-vat-desktop.png'),
      animations: 'disabled',
      fullPage: true,
    });
    const finalizeResponse = page.waitForResponse(
      (response) =>
        /\/store-receipts\/[^/]+\/finalize$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST',
    );
    await review.getByRole('button', { name: /Chốt giá & nhập kho/ }).click();
    const finalized = await finalizeResponse;
    expect(finalized.status(), await finalized.text()).toBe(200);
    expect(finalized.request().postDataJSON()).toMatchObject({
      freightVnd: 10000,
      handlingVnd: 5000,
      vat: { amountVnd: 44000, ratePercent: 8 },
    });
    // 55.5 kg × 20,000 + freight + handling; VAT is recorded beside the landed cost.
    expect((await finalized.json()).data).toMatchObject({
      status: 'FINALIZED',
      totalCostVnd: 1_125_000,
      totalAmountVnd: 1_169_000,
      vat: { amountVnd: 44000, ratePercent: 8 },
    });
    const summary = review.locator('.receipt-finalized-summary');
    await expect(summary).toContainText('VAT 8%');
    await expect(summary).toContainText(/44\.000/);
    await expect(summary).toContainText(/Giá vốn \(không gồm VAT\)\s*1\.125\.000/);
    await expect(summary).toContainText(/Tổng tiền phiếu \(gồm VAT\)\s*1\.169\.000/);
  } finally {
    await client.close();
  }
});

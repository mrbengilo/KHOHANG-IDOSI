import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import {
  applyWarehouseMovement,
  auditLogs,
  createDatabase,
  orderSessions,
  products,
  storeInventoryBags,
  storeReceipts,
  waitTickets,
  warehouseBalances,
} from '@idosi/database';
import { and, eq } from 'drizzle-orm';

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
    await expect(createPanel.getByRole('heading', { name: 'Khai phiếu nhận hàng' })).toBeVisible();
    await expect(createPanel.locator('.receipt-source-count__value')).toHaveText('1');
    await createPanel.getByRole('button', { name: 'Nhận hàng', exact: true }).click();
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
    await page.getByRole('button', { name: 'Lưu phiếu khai nhận (nháp)' }).click();
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
      .locator('.receipt-scope select')
      .selectOption({ label: `UI_RCV_${token} · Cửa hàng nhận ${token}` });
    const review = page.locator('.receipt-detail');
    await page.locator('.receipt-card').first().click();
    await expect(review).toBeFocused();
    expect((await review.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    expect((await review.boundingBox())!.y).toBeLessThan(200);
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

// Runs last, after the retail workflow above has published its session: the wholesale desk
// then orders into the next open session and that session's 09:00 run is published here.
test('a wholesale store orders, receives, is finalized and reports a discrepancy like a retail store', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  const adminLogin = {
    username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
    password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
  };
  try {
    const token = randomUUID().slice(0, 8);
    const productName = `Hàng sỉ giao nhận ${token}`;
    const actualName = `Hàng sỉ thực tế ${token}`;
    const [product] = await client.db
      .insert(products)
      .values({ sku: `E2E-WRCV-${token}`, slug: `e2e-wrcv-${token}`, name: productName })
      .returning();
    const [actual] = await client.db
      .insert(products)
      .values({ sku: `E2E-WACT-${token}`, slug: `e2e-wact-${token}`, name: actualName })
      .returning();
    await client.db.transaction((tx) =>
      applyWarehouseMovement(tx, {
        productId: product!.id,
        eventType: 'opening_balance',
        onHandDelta: 5,
        reservedDelta: 0,
        sourceType: 'live_e2e_opening',
        sourceId: randomUUID(),
        reason: 'Live wholesale order-to-receipt workflow stock',
        occurredAt: new Date(),
      }),
    );

    // Two wholesale stores, the desk that covers them and an HTKD assigned to both.
    expect((await page.request.post(`${api}/auth/login`, { data: adminLogin })).status()).toBe(200);
    const groups = await page.request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const groupId = (await groups.json()).data[0].id as string;
    const newStore = async (suffix: string) => {
      const created = await page.request.post(`${api}/stores`, {
        headers: { 'idempotency-key': randomUUID() },
        data: {
          code: `UI_SI_${suffix}_${token}`,
          name: `Cửa hàng sỉ ${suffix} ${token}`,
          kind: 'WHOLESALE',
          groupId,
        },
      });
      expect(created.status()).toBe(201);
      return (await created.json()).data as { id: string; code: string; name: string };
    };
    const storeA = await newStore('A');
    const storeB = await newStore('B');
    const deskLogin = { username: `desk.si.${token}`, password: `Test-only-${randomUUID()}!` };
    const htkdLogin = { username: `htkd.si.${token}`, password: `Test-only-${randomUUID()}!` };
    const desk = await page.request.post(`${api}/admin/accounts`, {
      data: { ...deskLogin, displayName: 'Quầy sỉ kiểm thử', role: 'WHOLESALE' },
    });
    expect(desk.status()).toBe(201);
    const deskId = (await desk.json()).data.id as string;
    const htkd = await page.request.post(`${api}/admin/accounts`, {
      data: { ...htkdLogin, displayName: 'HTKD cửa hàng sỉ', role: 'HTKD' },
    });
    expect(htkd.status()).toBe(201);
    const htkdId = (await htkd.json()).data.id as string;
    expect(
      (
        await page.request.put(`${api}/admin/accounts/${htkdId}/assignments`, {
          data: {
            expectedSessionVersion: 0,
            storeIds: [storeA.id, storeB.id],
            reason: 'Phân công kiểm thử cửa hàng sỉ',
          },
        })
      ).status(),
    ).toBe(200);
    await page.request.post(`${api}/auth/logout`);
    const labelA = `${storeA.code} · ${storeA.name}`;
    const labelB = `${storeB.code} · ${storeB.name}`;

    // 1. The desk orders for store A on the same form a retail store uses, notes included.
    await signIn(page, deskLogin);
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'Đặt hàng & kết quả' })).toBeVisible();
    await page.getByLabel('Cửa hàng').selectOption({ label: `${storeA.code} • ${storeA.name}` });
    await expect(page.locator('.quota-card')).toContainText('0 / 2 phiếu');
    await page.getByRole('checkbox', { name: productName }).check();
    await page.getByRole('button', { name: `Tăng số bao ${productName}` }).click();
    await page.getByLabel(`Ghi chú mặt hàng — ${productName}`).fill('Giao buổi sáng');
    const orderResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/order-requests' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng' }).click();
    const order = (await (await orderResponse).json()).data as {
      sessionId: string;
      storeId: string;
    };
    expect(order.storeId).toBe(storeA.id);
    await expect(page.locator('.quota-card')).toContainText('1 / 2 phiếu');

    // 2. The same 09:00 run that serves retail stores allocates and dispatches it.
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
    await worker.expireOffersAndFinalizeAllocation(scheduled, processedAt);
    expect((await worker.expireOffersAndFinalizeAllocation(scheduled, processedAt)).replayed).toBe(
      true,
    );

    // 3. Receiving: the store selector comes first and scopes the pending count.
    await page.goto('/receive');
    const scope = page.locator('.receipt-scope select');
    const createPanel = page.locator('.receipt-create');
    await expect(createPanel).toBeVisible();
    expect(
      await page.evaluate(() => {
        const selector = document.querySelector('.receipt-scope');
        const declaration = document.querySelector('.receipt-create');
        return Boolean(
          selector &&
          declaration &&
          selector.compareDocumentPosition(declaration) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);
    await scope.selectOption({ label: labelB });
    await expect(createPanel.locator('.receipt-source-count__value')).toHaveText('0');
    await expect(createPanel).toContainText(storeB.name);
    await scope.selectOption({ label: labelA });
    await expect(createPanel.getByRole('heading', { name: 'Khai phiếu nhận hàng' })).toBeVisible();
    await expect(createPanel.locator('.receipt-source-count')).toHaveText(
      /1\s*phiếu chờ nhận hàng/,
    );
    await expect(createPanel.getByRole('button', { name: 'Tạo phiếu' })).toHaveCount(0);
    const refresh = createPanel.getByRole('button', { name: 'Làm mới phiếu chờ nhận hàng' });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(createPanel.locator('.receipt-source-count__value')).toHaveText('1');
    await createPanel.getByRole('button', { name: 'Nhận hàng', exact: true }).click();
    const card = createPanel
      .locator('[aria-label="Lệnh xuất đang chờ nhận"]')
      .getByRole('button')
      .filter({ hasText: productName });
    await expect(card).toContainText('Duyệt 2 · giao 2');
    await card.click();
    await createPanel.getByLabel('Thực nhận').fill('2');

    // An unsaved declaration is never carried to, or silently lost on, another store.
    page.once('dialog', (dialog) => void dialog.dismiss());
    await scope.selectOption({ label: labelB });
    await expect(scope).toHaveValue(storeA.id);
    await expect(createPanel.locator('.receipt-source-selection')).toBeVisible();
    await assertReceiveLayout(page, testInfo.outputPath('wholesale-receive'));

    await createPanel.getByRole('button', { name: 'Lưu phiếu khai nhận (nháp)' }).click();
    await expect(page.getByText('Đã tạo phiếu nháp.', { exact: false })).toBeVisible();
    await expect(createPanel.locator('.receipt-source-count__value')).toHaveText('0');
    await page.getByRole('button', { name: 'Gửi HTKD duyệt' }).click();
    await expect(page.getByText('Đã gửi số thực nhận cho HTKD duyệt.')).toBeVisible();
    const [receipt] = await client.db
      .select({ id: storeReceipts.id, receiptNumber: storeReceipts.receiptNumber })
      .from(storeReceipts)
      .where(eq(storeReceipts.storeId, storeA.id));
    expect(
      await client.db
        .select()
        .from(storeInventoryBags)
        .where(eq(storeInventoryBags.storeId, storeA.id)),
    ).toHaveLength(0);

    // Store B shows nothing of store A.
    await scope.selectOption({ label: labelB });
    await expect(page.locator('.receipt-list')).toHaveCount(0);
    await expect(page.getByText(receipt!.receiptNumber)).toHaveCount(0);

    // 4. The assigned HTKD finalizes it; only then does store A hold the bags.
    await switchAccount(page, htkdLogin);
    await page.goto('/receive');
    await page.locator('.receipt-scope select').selectOption({ label: labelA });
    const review = page.locator('.receipt-detail');
    await review.getByLabel('Giá nhập / kg (VND)').fill('20000');
    await review.getByLabel('Khối lượng bao 1 (kg)').fill('30');
    await review.getByLabel('Khối lượng bao 2 (kg)').fill('25');
    await review.getByLabel('Phí vận chuyển (VND)').fill('0');
    await review.getByLabel('Phí bốc xếp (VND)').fill('0');
    await review.getByLabel('VAT 8% theo phiếu (VND)').fill('0');
    await review.getByRole('button', { name: /Chốt giá & nhập kho/ }).click();
    await expect(review).toContainText('Đã nhập kho');
    expect(
      await client.db
        .select()
        .from(storeInventoryBags)
        .where(eq(storeInventoryBags.storeId, storeA.id)),
    ).toHaveLength(2);

    // 5. The desk reports a mixed-up bag after finalization, from store A's receipt.
    await switchAccount(page, deskLogin);
    await page.goto('/receive');
    await page.locator('.receipt-scope select').selectOption({ label: labelA });
    const section = page.locator('.adjustment-section');
    await section.getByRole('button', { name: 'Báo sai lệch sau khui bao' }).click();
    await section.getByRole('checkbox', { name: /Bao 1/ }).check();
    await section.getByLabel('Mặt hàng thực tế').selectOption({ label: actualName });
    await section.getByLabel('Lý do').fill('Khui bao 1 thấy mặt hàng khác');
    await section.getByRole('button', { name: 'Gửi HTKD xác minh' }).click();
    await expect(section.locator('.receipt-notice')).toContainText('PSL-');
    await expect(section.getByRole('button', { name: /Xác minh, gửi Admin duyệt/ })).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Duyệt và áp dụng' })).toHaveCount(0);

    // 6. HTKD asks for more information; the desk answers from its queue.
    await switchAccount(page, htkdLogin);
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ HTKD xác minh' })
      .filter({ hasText: storeA.name })
      .first()
      .click();
    const htkdDetail = page.locator('.adjustment-detail');
    await htkdDetail.getByLabel('Nội dung/lý do').fill('Gửi thêm ảnh tem bao');
    await htkdDetail.getByRole('button', { name: 'Yêu cầu cửa hàng bổ sung' }).click();
    await expect(htkdDetail).toContainText('Cần cửa hàng bổ sung');

    await switchAccount(page, deskLogin);
    await page.goto('/receive');
    await page.locator('.receipt-scope select').selectOption({ label: labelB });
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Cần cửa hàng bổ sung' })
      .filter({ hasText: storeA.name })
      .first()
      .click();
    // The queue opens the document in its own store, not the one selected before.
    await expect(page.locator('.receipt-scope select')).toHaveValue(storeA.id);
    const deskDetail = page.locator('.adjustment-detail');
    await deskDetail
      .getByRole('textbox', { name: 'Lý do', exact: true })
      .fill('Đã gửi ảnh tem bao cho HTKD');
    await deskDetail.getByRole('button', { name: 'Gửi lại HTKD' }).click();
    await expect(deskDetail).toContainText('Chờ HTKD xác minh');

    // 7. HTKD verifies, the admin applies; the desk's store gets its P0B right.
    await switchAccount(page, htkdLogin);
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ HTKD xác minh' })
      .filter({ hasText: storeA.name })
      .first()
      .click();
    const verify = page.locator('.adjustment-detail');
    await verify.getByLabel('Giá / kg mặt hàng thực tế (VND)').fill('16000');
    await verify.getByLabel('Nguyên nhân').selectOption('SOURCE_MISCLASSIFICATION');
    await verify.getByLabel('Ghi chú xác minh').fill('Đã xem ảnh tem bao');
    await verify.getByRole('button', { name: 'Xác minh, gửi Admin duyệt' }).click();
    await expect(verify).toContainText('Chờ Admin duyệt');

    await switchAccount(page, adminLogin);
    await page.goto('/receive');
    await page
      .locator('.adjustment-queue')
      .getByRole('button')
      .filter({ hasText: 'Chờ Admin duyệt' })
      .filter({ hasText: storeA.name })
      .first()
      .click();
    const applied = page.locator('.adjustment-detail');
    await applied.getByRole('button', { name: 'Duyệt và áp dụng' }).click();
    await expect(applied).toContainText('Đã xử lý');
    // 30 kg × 20.000 = 600.000 became 30 kg × 16.000 = 480.000: 1.100.000 → 980.000.
    await expect(page.locator('.adjustment-money__effective')).toContainText('980.000');

    const bags = await client.db
      .select({ productId: storeInventoryBags.productId })
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, storeA.id));
    expect(bags.filter((bag) => bag.productId === product!.id)).toHaveLength(1);
    expect(bags.filter((bag) => bag.productId === actual!.id)).toHaveLength(1);
    expect(
      await client.db
        .select({ priority: waitTickets.priorityLevel, remaining: waitTickets.remainingQuantity })
        .from(waitTickets)
        .where(and(eq(waitTickets.storeId, storeA.id), eq(waitTickets.status, 'active'))),
    ).toEqual([{ priority: 'P0B', remaining: 1 }]);
    expect(
      await client.db
        .select({ id: waitTickets.id })
        .from(waitTickets)
        .where(eq(waitTickets.storeId, storeB.id)),
    ).toHaveLength(0);
    const deskAudits = await client.db
      .select({ role: auditLogs.actorRole })
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, deskId));
    expect(deskAudits.length).toBeGreaterThan(0);
    expect(deskAudits.every((row) => row.role === 'wholesale')).toBe(true);
  } finally {
    await client.close();
  }
});

async function signIn(page: Page, credentials: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function switchAccount(page: Page, credentials: { username: string; password: string }) {
  await page.context().clearCookies();
  await page.evaluate(() => window.sessionStorage.clear());
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, credentials);
}

/** No horizontal scroll, no clipped button label, at every supported width; screenshots kept. */
async function assertReceiveLayout(page: Page, screenshotPrefix: string) {
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    const clipped = await page.evaluate(
      () =>
        [...document.querySelectorAll('.receipt-scope, .receipt-create')]
          .flatMap((root) => [...root.querySelectorAll('.button, .receipt-source-count')])
          .filter((element) => element.scrollWidth > element.clientWidth + 1).length,
    );
    expect(clipped).toBe(0);
    if ([360, 390, 1366, 1440].includes(width)) {
      await page.screenshot({
        path: `${screenshotPrefix}-${width}.png`,
        animations: 'disabled',
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

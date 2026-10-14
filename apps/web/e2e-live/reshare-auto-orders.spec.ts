import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import {
  applyWarehouseMovement,
  allocationResultDecisions,
  auditLogs,
  createDatabase,
  products,
  reshareOrders,
  users,
  warehouseLedgerEntries,
  withSerializableTransaction,
} from '@idosi/database';
import { and, eq } from 'drizzle-orm';

import { balance, publishResult, signIn } from './allocation-result-fixture';

const api = 'http://127.0.0.1:3100/api/v1';

async function noPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

/*
 * Web → API → PostgreSQL: accepting a result creates exactly one RE order (RE-xxxxxx) and issues
 * the accepted bags out of the central warehouse at once; an assigned HTKD accepts on the store's
 * behalf (acceptance only); the history shows each order once with its lines and total.
 */
test('accepting creates one RE order, issues stock at once and shows it in the scoped history', async ({
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
    const pantsName = `Quần dài nữ RE ${token}`;
    const shirtName = `Áo RE ${token}`;
    const [pants] = await db
      .insert(products)
      .values({ sku: `E2E-RE-P-${token}`, slug: `e2e-re-p-${token}`, name: pantsName })
      .returning();
    const [shirt] = await db
      .insert(products)
      .values({ sku: `E2E-RE-S-${token}`, slug: `e2e-re-s-${token}`, name: shirtName })
      .returning();
    for (const productId of [pants!.id, shirt!.id]) {
      await withSerializableTransaction(db, (tx) =>
        applyWarehouseMovement(tx, {
          productId,
          eventType: 'opening_balance',
          onHandDelta: 10,
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
        code: `UI_RE_${token}`,
        name: `Cửa hàng RE ${token} có tên khá dài để kiểm tra bố cục`,
        kind: 'RETAIL',
        groupId: (await groups.json()).data[0].id,
      },
    });
    expect(created.status()).toBe(201);
    const store = (await created.json()).data as { id: string; name: string };
    const account = async (role: 'STORE' | 'HTKD', label: string) => {
      const login = { username: `re.${label}.${token}`, password: `Test-only-${randomUUID()}!` };
      const response = await page.request.post(`${api}/admin/accounts`, {
        data: {
          ...login,
          displayName: `RE ${label}`,
          role,
          ...(role === 'STORE' ? { storeId: store.id } : {}),
        },
      });
      expect(response.status()).toBe(201);
      return { ...login, id: (await response.json()).data.id as string };
    };
    const storeAccount = await account('STORE', 'store');
    const htkd = await account('HTKD', 'htkd');
    // No store assignment at all: still manages the Reshare module (step 5).
    const freeHtkd = await account('HTKD', 'htkd-free');
    const assigned = await page.request.put(`${api}/admin/accounts/${htkd.id}/assignments`, {
      data: { expectedSessionVersion: 0, storeIds: [store.id], reason: 'Phạm vi kiểm thử đơn RE' },
    });
    expect(assigned.status()).toBe(200);
    await page.request.post(`${api}/auth/logout`);
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);

    // Result A: two products for one store (one RE order); result B: priority-only, no shipment.
    const resultA = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [
        { productId: pants!.id, quantity: 2 },
        { productId: shirt!.id, quantity: 3 },
      ],
      shipment: true,
    });
    const resultB = await publishResult(db, {
      storeId: store.id,
      adminId: admin!.id,
      grants: [{ productId: pants!.id, quantity: 1 }],
      shipment: false,
    });
    expect(await balance(db, pants!.id)).toEqual({ onHand: 10, reserved: 3 });
    expect(await balance(db, shirt!.id)).toEqual({ onHand: 10, reserved: 3 });

    // 1. The store accepts A: RE tag at once, the warehouse issues 2 + 3 bags in the same answer.
    await signIn(page, storeAccount);
    await page.goto(`/allocations?decision=${resultA.decisionId}`);
    const panel = page.locator('.allocation-decision');
    await expect(panel.getByRole('button', { name: 'Từ chối' })).toBeVisible();
    await panel.getByRole('button', { name: 'Chấp nhận' }).click();
    const tag = panel.getByRole('link', { name: /Đã lập đơn Reshare, mở đơn RE-\d{6}/u });
    await expect(tag).toBeVisible();
    await expect(panel.locator('.inline-notice--success')).toContainText(/tạo đơn RE-\d{6}/u);
    await expect(panel.locator('.inline-notice--success')).toContainText(
      'xuất 5 bao khỏi kho tổng IDOSI',
    );
    const [orderA] = await db
      .select()
      .from(reshareOrders)
      .where(eq(reshareOrders.allocationDecisionId, resultA.decisionId));
    expect(orderA).toMatchObject({ totalQuantity: 5, actorRole: 'store', status: 'ordered' });
    expect(orderA!.code).toMatch(/^RE-\d{6}$/u);
    expect(await balance(db, pants!.id)).toEqual({ onHand: 8, reserved: 1 });
    expect(await balance(db, shirt!.id)).toEqual({ onHand: 7, reserved: 0 });
    const issued = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.sourceType, 'reshare_order'),
          eq(warehouseLedgerEntries.sourceId, orderA!.id),
        ),
      );
    expect(issued).toHaveLength(2);
    expect(issued.every((entry) => entry.reason === `Xuất theo đơn ${orderA!.code}`)).toBe(true);
    // Reload keeps the tag (server state, not a client flag).
    await page.reload();
    await expect(
      page.locator('.allocation-decision').getByText(`Đã lập đơn Reshare · ${orderA!.code}`),
    ).toBeVisible();

    // 2. The tag opens the history on that order: lines and total once.
    await page
      .locator('.allocation-decision')
      .getByRole('link', { name: /Đã lập đơn Reshare/u })
      .click();
    await expect(page).toHaveURL(new RegExp(`code=${orderA!.code}`, 'u'));
    const history = page.locator('.reshare-history');
    const group = history.locator('tbody').filter({ hasText: orderA!.code });
    await expect(group).toHaveCount(1);
    await expect(group).toContainText(pantsName);
    await expect(group).toContainText(shirtName);
    await expect(group.locator('td strong').filter({ hasText: /^5$/u })).toHaveCount(1);
    await expect(group).toContainText('Đã đặt Reshare');
    await expect(group).not.toContainText('UI_RE_');

    // 3. The assigned HTKD accepts B for the store: acceptance only, audited as HTKD.
    await page.context().clearCookies();
    await signIn(page, htkd);
    await page.goto(`/allocations?decision=${resultB.decisionId}`);
    const htkdPanel = page.locator('.allocation-decision');
    await expect(htkdPanel).toContainText('Bạn chấp nhận thay cửa hàng được phân công.');
    await expect(htkdPanel.getByRole('button', { name: 'Từ chối' })).toHaveCount(0);
    await htkdPanel.getByRole('button', { name: 'Chấp nhận' }).click();
    await expect(
      htkdPanel.getByRole('link', { name: /Đã lập đơn Reshare, mở đơn RE-\d{6}/u }),
    ).toBeVisible();
    const [orderB] = await db
      .select()
      .from(reshareOrders)
      .where(eq(reshareOrders.allocationDecisionId, resultB.decisionId));
    expect(orderB).toMatchObject({ actorUserId: htkd.id, actorRole: 'htkd', totalQuantity: 1 });
    expect(orderB!.code).not.toBe(orderA!.code);
    expect(await balance(db, pants!.id)).toEqual({ onHand: 7, reserved: 0 });

    // 4. HTKD history (every store in the Reshare module), filtered on the server by product.
    await page.goto('/supplier-reconciliation');
    await page.getByLabel('Mặt hàng').selectOption(shirt!.id);
    const htkdHistory = page.locator('.reshare-history');
    await expect(htkdHistory.locator('tbody').filter({ hasText: orderA!.code })).toHaveCount(1);
    await expect(htkdHistory.locator('tbody').filter({ hasText: orderB!.code })).toHaveCount(0);
    // Filtering by a product never shrinks the order total.
    await expect(
      htkdHistory
        .locator('tbody')
        .filter({ hasText: orderA!.code })
        .locator('td strong')
        .filter({ hasText: /^5$/u }),
    ).toHaveCount(1);
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
      if (width === 390 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath(`reshare-history-live-${width}.png`),
          fullPage: true,
        });
      }
    }
    // Admin edits on the real UI must persist through API/DB and reload without a second issue.
    await page.context().clearCookies();
    await signIn(page, adminLogin);
    await page.goto(`/supplier-reconciliation?code=${orderA!.code}`);
    const adminGroup = page.locator('.reshare-history tbody').filter({ hasText: orderA!.code });
    const beforeStatusChange = await balance(db, pants!.id);
    await adminGroup.getByRole('button', { name: 'Đánh dấu chưa đặt', exact: true }).click();
    await expect(adminGroup.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
    await page.reload();
    await expect(adminGroup.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
    let [persisted] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, resultA.decisionId));
    expect(persisted).toMatchObject({
      reshareStatus: 'not_ordered',
      reshareStatusVersion: 1,
      status: 'accepted',
    });
    await adminGroup.getByRole('button', { name: 'Đánh dấu đã đặt', exact: true }).click();
    await expect(adminGroup.getByText('Đã đặt Reshare', { exact: true })).toBeVisible();
    [persisted] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, resultA.decisionId));
    expect(persisted).toMatchObject({
      reshareStatus: 'ordered',
      reshareStatusVersion: 2,
      status: 'accepted',
    });
    const changes = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, resultA.decisionId),
          eq(auditLogs.action, 'RESHARE_ORDER_STATUS_UPDATED'),
        ),
      );
    expect(changes).toHaveLength(2);
    expect(changes.every((row) => row.actorRole === 'admin')).toBe(true);
    expect(await balance(db, pants!.id)).toEqual(beforeStatusChange);
    for (const width of [360, 390, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
      const button = adminGroup.getByRole('button', { name: 'Đánh dấu chưa đặt', exact: true });
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: testInfo.outputPath(`admin-reshare-status-${width}.png`),
          fullPage: true,
        });
    }

    // 5. An HTKD with no store assignment manages the Reshare status too (module-wide right);
    // every change keeps its real actor and stays readable in "Lịch sử thay đổi" after reload.
    await page.context().clearCookies();
    await signIn(page, freeHtkd);
    await page.goto(`/supplier-reconciliation?code=${orderA!.code}`);
    await expect(page.getByRole('tab')).toHaveCount(4);
    const htkdGroup = page.locator('.reshare-history tbody').filter({ hasText: orderA!.code });
    await htkdGroup.getByRole('button', { name: 'Đánh dấu chưa đặt', exact: true }).click();
    await expect(htkdGroup.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
    await expect(htkdGroup).toContainText('Cập nhật lần cuối bởi RE htkd-free (HTKD)');
    await page.reload();
    await htkdGroup.getByRole('button', { name: /^Lịch sử thay đổi/u }).click();
    const dialog = page.getByRole('dialog', { name: 'Lịch sử thay đổi trạng thái' });
    const events = dialog.locator('tbody tr');
    await expect(events).toHaveCount(4);
    await expect(events.nth(0)).toContainText('RE htkd-free');
    await expect(events.nth(0).locator('td').nth(4)).toHaveText('HTKD');
    await expect(events.nth(0).locator('td').nth(2)).toHaveText('Chưa đặt Reshare');
    await expect(events.nth(1).locator('td').nth(4)).toHaveText('Admin');
    await expect(events.nth(3)).toContainText(`Tạo đơn ${orderA!.code}`);
    await expect(events.nth(3).locator('td').nth(4)).toHaveText('Cửa hàng');
    for (const width of [360, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: testInfo.outputPath(`reshare-status-history-live-${width}.png`),
          fullPage: true,
        });
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const [latest] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, resultA.decisionId),
          eq(auditLogs.action, 'RESHARE_ORDER_STATUS_UPDATED'),
          eq(auditLogs.actorUserId, freeHtkd.id),
        ),
      );
    expect(latest).toMatchObject({ actorRole: 'htkd', metadata: { actorName: 'RE htkd-free' } });
    expect(await balance(db, pants!.id)).toEqual(beforeStatusChange);
  } finally {
    await client.close();
  }
});

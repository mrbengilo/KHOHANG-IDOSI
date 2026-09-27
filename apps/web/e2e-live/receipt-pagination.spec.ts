import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import {
  createDatabase,
  users,
  storeGroups,
  stores,
  products,
  outboundRequests,
  outboundRequestLines,
  storeReceipts,
  storeReceiptLines,
} from '@idosi/database';
import { eq } from 'drizzle-orm';

test('receipt headers paginate at the server and detail follows only the selected store', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  if (!process.env.DATABASE_URL) throw new Error('Isolated PostgreSQL required');
  const client = createDatabase({ connectionString: process.env.DATABASE_URL });
  const api = 'http://127.0.0.1:3100/api/v1';
  try {
    const token = randomUUID();
    const [admin] = await client.db
      .select()
      .from(users)
      .where(eq(users.email, process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin'));
    const [group] = await client.db.select().from(storeGroups).limit(1);
    const [product] = await client.db.select().from(products).limit(1);
    const scopeStores = await client.db
      .insert(stores)
      .values(
        ['A', 'B'].map((suffix) => ({
          code: token + suffix,
          name: 'Phân trang ' + suffix + ' ' + token,
          groupId: group!.id,
        })),
      )
      .returning();
    for (const [index, store] of scopeStores.entries()) {
      await client.db.transaction(async (tx) => {
        for (let i = 0; i < (index === 0 ? 121 : 1); i++) {
          const [outbound] = await tx
            .insert(outboundRequests)
            .values({
              requestNumber: '',
              storeId: store.id,
              requestedByUserId: admin!.id,
              status: 'dispatched',
            })
            .returning();
          const [outboundLine] = await tx
            .insert(outboundRequestLines)
            .values({
              outboundRequestId: outbound!.id,
              productId: product!.id,
              requestedQuantity: 1,
              approvedQuantity: 1,
              reservedQuantity: 1,
              dispatchedQuantity: 1,
            })
            .returning();
          const [receipt] = await tx
            .insert(storeReceipts)
            .values({
              receiptNumber: '',
              storeId: store.id,
              outboundRequestId: outbound!.id,
              declaredByUserId: admin!.id,
            })
            .returning();
          await tx.insert(storeReceiptLines).values({
            storeReceiptId: receipt!.id,
            outboundRequestLineId: outboundLine!.id,
            productId: product!.id,
            approvedQuantity: 1,
            receivedQuantity: 1,
          });
        }
      });
    }
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
    await page
      .getByLabel('Mật khẩu', { exact: true })
      .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
    const calls: string[] = [];
    page.on('request', (request) => {
      if (/\/store-receipt(?:s|-summaries)(?:\?|\/|$)/.test(request.url()))
        calls.push(request.url());
    });
    await page.goto('/costs');
    await expect(page.getByText('Chọn cửa hàng để xem phiếu nhập và giá vốn')).toBeVisible();
    expect(calls).toHaveLength(0);
    const start = performance.now();
    await page.locator('.receipt-scope select').selectOption(scopeStores[0]!.id);
    await expect(page.locator('.receipt-card')).toHaveCount(20);
    const timeToListMs = performance.now() - start;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('page=1&pageSize=20');
    await expect(page.getByText('20 / 121', { exact: true })).toBeVisible();
    const selectedCode = await page.locator('.receipt-card strong').first().innerText();
    await page.locator('.receipt-card').first().click();
    await expect(page.locator('.receipt-detail')).toContainText(selectedCode);
    expect(calls.filter((url) => /\/store-receipts\//.test(url))).toHaveLength(1);
    await page.locator('.receipt-scope select').selectOption(scopeStores[1]!.id);
    await expect(page.locator('.receipt-card')).toHaveCount(1);
    await expect(page.locator('.receipt-detail')).toContainText('Chọn phiếu nhận');
    await page.locator('.receipt-scope select').selectOption(scopeStores[0]!.id);
    await expect(page.locator('.receipt-card')).toHaveCount(20);
    await page
      .getByRole('navigation', { name: 'Phân trang phiếu nhận' })
      .getByRole('button', { name: 'Trang sau' })
      .click();
    await expect(page.getByText('Trang 2 / 7', { exact: true })).toBeVisible();
    await expect(page.locator('.receipt-card')).toHaveCount(20);
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if ([390, 1440].includes(width))
        await page.screenshot({
          path: testInfo.outputPath('receipt-pagination-' + width + '.png'),
          fullPage: true,
        });
    }
    // Compare the former listAllPages access pattern with one summary page on identical data.
    const login = await page.request.post(api + '/auth/login', {
      data: {
        username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
        password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
      },
    });
    expect(login.status()).toBe(200);
    const baselineStart = performance.now();
    let baselineBytes = 0;
    let baselineCount = 0;
    for (const number of [1, 2]) {
      const response = await page.request.get(
        api + '/store-receipts?storeId=' + scopeStores[0]!.id + '&pageSize=100&page=' + number,
      );
      expect(response.status()).toBe(200);
      baselineBytes += (await response.body()).length;
      baselineCount += (await response.json()).data.length;
    }
    const baselineMs = performance.now() - baselineStart;
    const afterStart = performance.now();
    const after = await page.request.get(
      api + '/store-receipt-summaries?storeId=' + scopeStores[0]!.id + '&pageSize=20&page=1',
    );
    expect(after.status()).toBe(200);
    const afterBytes = (await after.body()).length;
    const afterMs = performance.now() - afterStart;
    expect((await after.json()).data[0]).not.toHaveProperty('lines');
    expect(baselineCount).toBe(121);
    expect(afterBytes).toBeLessThan(baselineBytes / 5);
    const measurement = JSON.stringify(
      {
        storeId: scopeStores[0]!.id,
        dataset: 121,
        baseline: { requests: 2, receipts: baselineCount, bytes: baselineBytes, ms: baselineMs },
        after: { requests: 1, receipts: 20, bytes: afterBytes, ms: afterMs, timeToListMs },
      },
      null,
      2,
    );
    await writeFile(testInfo.outputPath('receipt-load-measurement.json'), measurement);
    await testInfo.attach('receipt-load-measurement', {
      contentType: 'application/json',
      body: measurement,
    });
  } finally {
    await client.close();
  }
});

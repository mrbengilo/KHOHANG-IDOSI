import { expect, test } from '@playwright/test';

const storeId = '11111111-1111-4111-8111-111111111111';
const bagId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-09-23T00:00:00.000Z';
const pagination = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };

test('sorting offers only three reasons and records sale by piece', async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const respond = (json: unknown, status = 200) =>
      route.fulfill({ contentType: 'application/json', json, status });
    if (url.pathname.endsWith('/auth/session')) {
      return respond({
        data: {
          id: '44444444-4444-4444-8444-444444444444',
          principal: {
            accountId: '55555555-5555-4555-8555-555555555555',
            username: 'store.test',
            displayName: 'Cửa hàng thử nghiệm',
            role: 'STORE',
            status: 'ACTIVE',
            storeId,
            assignedStoreIds: [],
          },
          createdAt: timestamp,
          lastSeenAt: timestamp,
          expiresAt: '2099-09-23T00:00:00.000Z',
        },
      });
    }
    if (url.pathname.endsWith('/stores')) {
      return respond({
        data: [
          {
            id: storeId,
            code: 'DS_TEST',
            name: 'Cửa hàng thử nghiệm',
            groupId: '66666666-6666-4666-8666-666666666666',
            kind: 'RETAIL',
            status: 'ACTIVE',
            address: null,
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        pagination: { ...pagination, totalItems: 1, totalPages: 1 },
      });
    }
    if (url.pathname.endsWith('/store-inventory-bags')) {
      const bags =
        url.searchParams.get('status') === 'AVAILABLE'
          ? [
              {
                id: bagId,
                storeId,
                productId,
                sourceReceiptBagId: '77777777-7777-4777-8777-777777777777',
                outboundOrderId: null,
                sourceTransferId: null,
                sourceInventoryBagId: null,
                bagCode: 'MB-00001',
                originalWeightKg: '10.000',
                receivedWeightKg: '10.000',
                remainingWeightKg: '10.000',
                status: 'AVAILABLE',
                version: 0,
                receivedAt: timestamp,
                updatedAt: timestamp,
              },
            ]
          : [];
      return respond({
        data: bags,
        pagination: { ...pagination, totalItems: bags.length, totalPages: bags.length ? 1 : 0 },
      });
    }
    if (url.pathname.endsWith('/store-outbounds') && route.request().method() === 'POST') {
      created = route.request().postDataJSON() as Record<string, unknown>;
      const outbound = { ...created };
      delete outbound.expectedInventoryVersion;
      return respond(
        {
          data: {
            id: '88888888-8888-4888-8888-888888888888',
            ...outbound,
            inventoryLotId: bagId,
            status: 'PENDING',
            createdByAccountId: '55555555-5555-4555-8555-555555555555',
            reviewedByAccountId: null,
            reviewNote: null,
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        201,
      );
    }
    return respond({ data: [], pagination });
  });

  await page.goto('/sorting');
  const reason = page.getByLabel('Lý do');
  await expect(reason).toBeVisible();
  await expect(reason.locator('option')).toHaveText(['Từ thiện', 'Sale', 'Hủy']);
  await reason.selectOption('SALE');
  await expect(page.getByLabel('Hình thức sale')).toBeVisible();
  await page.getByLabel('Hình thức sale').selectOption('SALE_PIECE');
  await expect(page.getByLabel('Số cái')).toBeVisible();
  await page.getByLabel('Khối lượng (kg)').fill('1.250');
  await page.getByLabel('Doanh thu (VND)').fill('100000');
  await expect(page.getByRole('button', { name: 'Gửi phiếu chờ duyệt' })).toBeDisabled();
  await page.getByLabel('Số cái').fill('2');
  await page.getByRole('button', { name: 'Gửi phiếu chờ duyệt' }).click();
  await expect
    .poll(() => created)
    .toMatchObject({ reason: 'SALE_PIECE', pieceCount: 2, weightKg: '1.250', revenueVnd: 100000 });
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

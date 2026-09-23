import { expect, test } from '@playwright/test';

const storeId = '11111111-1111-4111-8111-111111111111';
const destinationStoreId = '11111111-1111-4111-8111-111111111112';
const bagId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const stockId = '88888888-8888-4888-8888-888888888888';
const timestamp = '2026-09-23T00:00:00.000Z';
const pagination = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };

test('sorting credits Sale bags and kilograms and offers Sale, Charity and Cancel', async ({
  page,
}) => {
  let created: Record<string, unknown> | null = null;
  let stocks: Record<string, unknown>[] = [];
  let activeStoreId = storeId;
  let transferRequest: Record<string, unknown> | null = null;
  let transfer: Record<string, unknown> | null = null;
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
            storeId: activeStoreId,
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
          {
            id: destinationStoreId,
            code: 'DS_RECEIVE',
            name: 'Cửa hàng nhận',
            groupId: '66666666-6666-4666-8666-666666666666',
            kind: 'RETAIL',
            status: 'ACTIVE',
            address: null,
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        pagination: { ...pagination, totalItems: 2, totalPages: 1 },
      });
    }
    if (url.pathname.endsWith('/products')) {
      return respond({
        data: [
          {
            id: productId,
            sku: 'DO_NAM',
            name: 'Đồ nam',
            measurement: 'WEIGHT',
            unitLabel: 'kg',
            status: 'ACTIVE',
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
                remainingWeightKg: created ? '8.750' : '10.000',
                status: 'AVAILABLE',
                version: created ? 1 : 0,
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
    if (url.pathname.endsWith('/store-sorted-stocks'))
      return respond({ data: stocks.filter((stock) => stock.storeId === activeStoreId) });
    if (url.pathname.endsWith('/store-transfers/destinations'))
      return respond({
        data: [
          {
            id: activeStoreId === storeId ? destinationStoreId : storeId,
            code: activeStoreId === storeId ? 'DS_RECEIVE' : 'DS_TEST',
            name: activeStoreId === storeId ? 'Cửa hàng nhận' : 'Cửa hàng thử nghiệm',
            groupId: '66666666-6666-4666-8666-666666666666',
            kind: 'RETAIL',
            status: 'ACTIVE',
            address: null,
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
    if (url.pathname.endsWith('/store-transfers')) return respond({ data: [], pagination });
    if (url.pathname.endsWith('/sorted-sale-transfers')) {
      if (route.request().method() === 'GET') return respond({ data: transfer ? [transfer] : [] });
      transferRequest = route.request().postDataJSON() as Record<string, unknown>;
      stocks = stocks.map((stock) =>
        stock.id === stockId
          ? { ...stock, bagQuantity: 1, saleWeightKg: '0.625', version: 1 }
          : stock,
      );
      transfer = {
        id: '99999999-9999-4999-8999-999999999999',
        transferNumber: 'PDC-00001',
        sourceStockId: stockId,
        sourceStoreId: storeId,
        destinationStoreId,
        productId,
        bagQuantity: 1,
        weightKg: '0.625',
        enteredWeightKg: null,
        status: 'IN_TRANSIT',
        version: 0,
        note: null,
        createdAt: timestamp,
        receivedAt: null,
      };
      return respond({ data: transfer }, 201);
    }
    if (
      url.pathname.endsWith('/sorted-sale-transfers/99999999-9999-4999-8999-999999999999/receive')
    ) {
      transfer = { ...transfer, status: 'RECEIVED', version: 1, receivedAt: timestamp };
      stocks.push({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        storeId: destinationStoreId,
        productId,
        inventoryLotId: '99999999-9999-4999-8999-999999999999',
        bagCode: 'PDC-00001',
        bagQuantity: 1,
        saleWeightKg: '0.625',
        charityWeightKg: '0.000',
        version: 0,
        updatedAt: timestamp,
      });
      return respond({ data: transfer });
    }
    if (url.pathname.endsWith('/store-sortings') && route.request().method() === 'POST') {
      created = route.request().postDataJSON() as Record<string, unknown>;
      stocks = [
        {
          id: stockId,
          storeId,
          productId,
          inventoryLotId: bagId,
          bagCode: 'MB-00001',
          saleWeightKg: '1.250',
          bagQuantity: 2,
          charityWeightKg: '0.000',
          version: 0,
          updatedAt: timestamp,
        },
      ];
      return respond({ data: { stockId, inventoryLotId: bagId, inventoryVersion: 1 } }, 201);
    }
    return respond({ data: [], pagination });
  });

  await page.goto('/sorting');
  const reason = page.getByLabel('Lý do');
  await expect(reason).toBeVisible();
  await expect(reason.locator('option')).toHaveText(['Từ thiện', 'Sale', 'Hủy']);
  await reason.selectOption('SALE');
  await expect(page.getByLabel('Hình thức sale')).toHaveCount(0);
  await expect(page.getByLabel('Số cái')).toHaveCount(0);
  await page.getByLabel('Khối lượng đã lọc (kg)').fill('1.250');
  await expect(page.getByRole('button', { name: 'Lưu khối lượng đã lọc' })).toBeDisabled();
  await page.getByLabel('Số lượng sau lọc (bao)').fill('2');
  await page.getByRole('button', { name: 'Lưu khối lượng đã lọc' }).click();
  await expect
    .poll(() => created)
    .toMatchObject({ reason: 'SALE', weightKg: '1.250', bagQuantity: 2 });
  expect(Object.keys(created ?? {})).toEqual([
    'storeId',
    'inventoryLotId',
    'expectedInventoryVersion',
    'reason',
    'weightKg',
    'bagQuantity',
  ]);
  for (const width of [360, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }

  await page.goto('/transfers');
  await expect(page.getByRole('heading', { name: 'Điều chuyển từ Sale sau lọc' })).toBeVisible();
  await page.getByLabel('Số lượng (bao)').fill('1');
  await expect(page.getByLabel('Khối lượng (kg), không bắt buộc')).toHaveValue('');
  await page.getByRole('button', { name: 'Điều chuyển', exact: true }).click();
  await expect
    .poll(() => transferRequest)
    .toMatchObject({
      sourceStockId: stockId,
      sourceStoreId: storeId,
      destinationStoreId,
      bagQuantity: 1,
      weightKg: null,
    });
  await expect(page.getByText('1 bao · 0,625 kg · v1')).toBeVisible();
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }

  activeStoreId = destinationStoreId;
  await page.reload();
  await page.getByRole('button', { name: 'Xác nhận đã nhận' }).click();
  await expect(page.getByText('1 bao · 0,625 kg · v0')).toBeVisible();
  await expect(page.locator('.transfer-card header span').getByText('Đã nhận')).toBeVisible();
});

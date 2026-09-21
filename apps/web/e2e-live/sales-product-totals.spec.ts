import { expect, test } from '@playwright/test';

test('sales workspace groups source products and month/store filters preserve scope', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin');
  await page
    .getByLabel('Mật khẩu')
    .fill(process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production');
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  expect((await loginResponsePromise).status()).toBe(200);
  const storesResponse = await page
    .context()
    .request.get(
      'http://127.0.0.1:3100/api/v1/stores?page=1&pageSize=100&kind=RETAIL&status=ACTIVE',
    );
  expect(storesResponse.status()).toBe(200);
  const storesPayload = (await storesResponse.json()) as {
    data: Array<{ id: string; kind: string; name: string; status: string }>;
  };
  const stores = storesPayload.data
    .filter((store) => store.kind === 'RETAIL' && store.status === 'ACTIVE')
    .slice(0, 2);
  expect(stores).toHaveLength(2);
  const region = page.getByRole('region', { name: 'Doanh thu & hàng đã bán · IDOSI', exact: true });
  const storeFilter = page.getByRole('combobox', {
    name: 'Cửa hàng thống kê IDOSI',
    exact: true,
  });
  let interceptedRequests = 0;
  const refreshedStores = new Set<string>();
  const sourceStates = new Map<string, unknown>();
  await page.route('**/integrations/idosi/order-statistics/sync', async (route) => {
    const scope = route.request().postDataJSON() as { storeId: string; period: string };
    expect(scope.period).toBe('2024-02');
    refreshedStores.add(scope.storeId);
    await route.fulfill({ json: { data: sourceStates.get(scope.storeId) } });
  });
  await page.route('**/integrations/idosi/statistics-summary?*', async (route) => {
    interceptedRequests += 1;
    const url = new URL(route.request().url());
    const period = url.searchParams.get('period')!;
    const selected = stores.filter(
      (store) => !url.searchParams.has('storeId') || store.id === url.searchParams.get('storeId'),
    );
    const data = selected.map((store, index) => {
      const quantity = (period === '2024-02' ? 3 : 6) + (refreshedStores.has(store.id) ? 3 : 0);
      const bucket = {
        actualKg: 0,
        estimatedKg: quantity / 3,
        knownKg: quantity / 3,
        totalKg: quantity / 3,
        isComplete: true,
        missingFactorLines: 0,
        invalidLines: 0,
        unclassifiedOrders: 0,
      };
      const weight = {
        ...bucket,
        schemaVersion: 1,
        unit: 'KG',
        tableVersion: 'test',
        byRevenueType: { NORMAL: bucket, SALE_KG: bucket, SALE_PIECE: bucket },
      };
      const timestamp = '2026-09-21T01:00:00Z';
      return {
        scope: { storeId: store.id, period },
        integrationStatus: 'CONFIGURED',
        freshness: 'CURRENT',
        latestAttempt: null,
        snapshot: {
          id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          storeId: store.id,
          scopeKey: period,
          firstSyncedAt: timestamp,
          lastSyncedAt: timestamp,
          payload: {
            ok: true,
            apiVersion: 1,
            storeId: store.id,
            store,
            currency: 'VND',
            timezone: 'Asia/Ho_Chi_Minh',
            revenueBasis: 'ACTIVE_ORDER_AMOUNT',
            generatedAt: timestamp,
            serverTime: timestamp,
            requestId: 'test',
            filters: { period, date: null, shiftId: null, paymentMethod: null },
            totals: {
              orders: 1,
              cash: 100,
              transfer: 0,
              revenue: 100,
              cashOrders: 1,
              transferOrders: 0,
              revenueByType: { NORMAL: 100, SALE_KG: 0, SALE_PIECE: 0 },
              weight,
            },
            products: {
              totalQuantity: quantity,
              totalWeightKg: 0,
              productTypes: 1,
              ordersWithItems: 1,
              unclassifiedOrders: 0,
              weight,
              weightByProduct: [],
              items: [
                {
                  productId: 'SOURCE-TEST',
                  productName: 'Mặt hàng kiểm thử tổng hợp',
                  quantity,
                  unit: 'PIECE',
                  revenueType: 'NORMAL',
                  orders: 1,
                  weight,
                },
              ],
            },
            groups: { day: [], month: [], shift: [] },
          },
        },
      };
    });
    data.forEach((state) => sourceStates.set(state.scope.storeId, state));
    await route.fulfill({
      json: {
        data,
        pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
      },
    });
  });
  await page.goto('/sales');
  await expect.poll(() => interceptedRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(storeFilter).toBeVisible({ timeout: 30_000 });
  const row = region.getByRole('row', { name: /Mặt hàng kiểm thử tổng hợp/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('12 cái');
  await expect(row).toContainText('4 kg');
  await page.getByLabel('Kỳ thống kê IDOSI', { exact: true }).fill('2024-02');
  await expect(row).toContainText('6 cái');
  await expect(row).toContainText('2 kg');
  await storeFilter.selectOption(stores[0]!.id);
  await expect(row).toContainText('3 cái');
  await expect(row).toContainText('1 kg');
  await region.getByRole('button', { name: 'Đồng bộ từ IDOSI', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('Đã đồng bộ 1/1 cửa hàng');
  expect([...refreshedStores]).toEqual([stores[0]!.id]);
  await expect(row).toContainText('6 cái');
  await expect(row).toContainText('2 kg');
  await expect(region).toContainText('Dữ liệu nguồn lúc');
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`sales-totals-${width}.png`),
      animations: 'disabled',
    });
  }
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { layoutAdminSession, layoutProducts, mockLayoutData } from './layout-fixtures';
import {
  measureTableLayout,
  tableLayoutViewports,
  tableLayoutViolations,
} from './table-layout-metrics';

const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-15T02:00:00.000Z';
const store = {
  id: id(1),
  code: 'TABLE-STORE',
  name: 'Cửa hàng thử nghiệm tên dài tại Thành phố Hồ Chí Minh',
  kind: 'RETAIL',
  groupId: id(2),
  status: 'ACTIVE',
  address: null,
  version: 0,
  createdAt: time,
  updatedAt: time,
};
const pagination = { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };
const document = {
  id: id(3),
  code: 'PCT-000001',
  storeId: store.id,
  storeCode: store.code,
  storeName: store.name,
  status: 'CURRENT',
  version: 1,
  chainId: id(3),
  chainSequence: 1,
  openedAt: time,
  closedAt: null,
  waitingSince: time,
  predecessor: null,
  successor: null,
  openedEvent: {
    id: id(4),
    kind: 'SYSTEM_SYNC',
    occurredAt: time,
    actor: null,
    reason: null,
    session: null,
    allocationRunId: null,
    allocationDecisionId: null,
    reshareOrderCode: null,
    waitTicket: null,
    priorityOffer: null,
    storeReceipt: null,
  },
  closedEvent: null,
  lines: layoutProducts.slice(0, 2).map((product, index) => ({
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    unit: 'BAG',
    carriedInQuantity: 0,
    addedQuantity: index + 3,
    openingRemainingQuantity: index + 3,
    openingPendingQuantity: 0,
    confirmedQuantity: null,
    cancelledQuantity: null,
    adjustedQuantity: null,
    carriedOutQuantity: null,
    remainingQuantity: index + 3,
    pendingQuantity: 0,
  })),
};
async function mock(page: Page, role = 'ADMIN') {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path === '/auth/session') {
      const session = layoutAdminSession();
      return route.fulfill({
        json: {
          data: {
            ...session,
            principal: {
              ...session.principal,
              role,
              storeId: role === 'STORE' ? store.id : null,
              assignedStoreIds: role === 'HTKD' || role === 'WHOLESALE' ? [store.id] : [],
            },
          },
        },
      });
    }
    if (path === '/stores') return route.fulfill({ json: { data: [store], pagination } });
    if (path === `/stores/${store.id}`) return route.fulfill({ json: { data: store } });
    if (path === '/wait-documents')
      return route.fulfill({ json: { data: [document], pagination } });
    if (path === `/wait-documents/${document.id}`)
      return route.fulfill({
        json: {
          data: {
            ...document,
            members: [],
            pendingResults: [],
            chain: [],
            currentDocument: { id: document.id, code: document.code },
          },
        },
      });
    return route.fulfill({
      json: { data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } },
    });
  });
  await mockLayoutData(page);
}

test('PCT list and detail fill their box, have STT and retain colored names and borders', async ({
  page,
}, testInfo) => {
  await mock(page);
  await page.goto('/allocations?tab=wait-tickets');
  const card = page.locator('.wait-document-card');
  await expect(card).toHaveCount(1);
  const measurements = [];
  for (const [width, height] of tableLayoutViewports.filter(([w]) =>
    testInfo.project.name === 'desktop-1440' ? w > 820 : w <= 820,
  )) {
    await page.setViewportSize({ width, height });
    const layout = await measureTableLayout(page);
    expect(tableLayoutViolations(layout), `PCT at ${width}`).toEqual([]);
    expect(layout.tables.length).toBeGreaterThan(0);
    await expect(card.locator('tbody .table-index')).toHaveText(['1', '2']);
    await expect(card.locator('h3 .store-name')).toHaveCSS('color', 'rgb(30, 64, 175)');
    await expect(card.locator('h3 .store-name')).toHaveCSS('font-weight', '700');
    await expect(card).toHaveCSS('border-top-color', 'rgb(147, 189, 240)');
    await expect(card).toHaveCSS('border-top-style', 'solid');
    measurements.push(layout);
    if ([390, 1920, 2560].includes(width))
      await page.screenshot({ path: testInfo.outputPath(`pct-${width}.png`), fullPage: true });
  }
  await card.getByRole('button', { name: /Xem chi tiết phiếu chờ/ }).click();
  const detail = page.locator('.wait-document-detail');
  await expect(detail.locator('tbody .table-index')).toHaveText(['1', '2']);
  expect(tableLayoutViolations(await measureTableLayout(page))).toEqual([]);
  await testInfo.attach('pct-measurements', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  });
});

for (const role of ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE'])
  test(`${role} warehouse demand binding and pagination use server metadata`, async ({ page }) => {
    await mock(page, role);
    await page.route('**/api/v1/warehouse-inventory?*', async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('projection')).toBe('waiting-demand-v2');
      const current = Number(url.searchParams.get('page'));
      return route.fulfill({
        json: {
          data: [
            {
              productId: layoutProducts[0]!.id,
              productName: 'Đồ nam',
              sku: 'DEMAND-TEST',
              onHandBags: 0,
              reservedBags: 0,
              waitTicketHoldBags: 0,
              waitingDemandBags: 8,
              sharedDeliveryHoldBags: 0,
              availableBags: 0,
              dispatchedBags: 0,
              balanceVersion: 0,
              productActive: true,
              reshareReconciled: false,
            },
          ],
          pagination: { page: current, pageSize: 20, totalItems: 21, totalPages: 2 },
        },
      });
    });
    await page.goto('/inventory?tab=warehouse&kt.page=2');
    const table = page.locator('.warehouse-stock-table');
    await expect(table.locator('tbody .table-index')).toHaveText('21');
    await expect(table.locator('td[data-label="Đang giữ phiếu chờ"]')).toHaveText('8 bao');
    await expect(table.locator('td[data-label="Đang có tại kho"]')).toContainText('0 bao');
    await page.getByLabel('Tìm mặt hàng kho tổng').fill('Đồ nam');
    await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
    await expect(table.locator('tbody .table-index')).toHaveText('1');
  });

test('an old API response or rollback fails clearly without substituting zero or reloading', async ({
  page,
}) => {
  await mock(page);
  await page.clock.install();
  let completedResponses = 0;
  let documentNavigations = 0;
  // CI's NODE_ENV=test enables Strict Mode: its first mount can abort a request before
  // the remount succeeds. That cancellation is not a retry/reload caused by this error.
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/v1/warehouse-inventory' && response.ok())
      completedResponses++;
  });
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentNavigations++;
  });
  await page.route('**/api/v1/warehouse-inventory?*', (route) => {
    return route.fulfill({
      json: {
        data: [
          {
            productId: layoutProducts[0]!.id,
            productName: 'Legacy',
            sku: 'LEGACY',
            onHandBags: 0,
            reservedBags: 0,
            waitTicketHoldBags: 0,
            sharedDeliveryHoldBags: 0,
            availableBags: 0,
            dispatchedBags: 0,
            balanceVersion: 0,
            productActive: true,
            reshareReconciled: false,
          },
        ],
        pagination,
      },
    });
  });
  await page.goto('/inventory');
  await expect(page.getByRole('alert')).toContainText(
    'Phiên bản dữ liệu tồn kho không tương thích',
  );
  await expect(page.locator('.warehouse-stock-table')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(page.getByRole('alert')).toContainText(
    'Phiên bản dữ liệu tồn kho không tương thích',
  );
  expect(completedResponses).toBe(1);
  expect(documentNavigations).toBe(1);
});

test('discrepancy filters and populated list stay inside the viewport across the sidebar breakpoint', async ({
  page,
}) => {
  await mock(page);
  await page.route('**/api/v1/receipt-adjustments?*', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: id(21),
            code: 'PSL-000001',
            receiptId: id(22),
            receiptNumber: 'PNH-000001',
            storeId: store.id,
            storeCode: store.code,
            storeName: store.name,
            status: 'PENDING_HTKD',
            version: 1,
            reason: 'Khui bao thấy mặt hàng khác với phiếu nhận',
            cause: 'SOURCE_MISCLASSIFICATION',
            lineCount: 1,
            shortageQuantity: 1,
            goodsDeltaVnd: -200000,
            reportedBy: {
              accountId: id(23),
              displayName: store.name,
              username: 'store.table.test',
            },
            reportedAt: time,
            verifiedBy: null,
            verifiedAt: null,
            decidedBy: null,
            decidedAt: null,
            decisionNote: null,
            appliedAt: null,
            updatedAt: time,
          },
        ],
        pagination,
      },
    }),
  );
  await page.goto('/inventory?tab=adjustments');
  await expect(page.locator('.adjustment-workspace__table tbody tr')).toHaveCount(1);
  for (const width of [1440, 360, 819, 820, 821, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `viewport ${width}`,
    ).toBeLessThanOrEqual(width + 1);
    const scrollport = page.locator('.adjustment-workspace__table');
    // ResizeObserver can change header widths in the next frame. Scroll and measure in
    // one layout, allowing that reflow to finish; the page-overflow assertion above stays immediate.
    await expect
      .poll(() =>
        scrollport.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
          const action = node.querySelector('button')!.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return action.left >= box.left - 1 && action.right <= box.right + 1;
        }),
      )
      .toBe(true);
    await scrollport.evaluate((node) => {
      node.scrollLeft = 0;
    });
  }
});

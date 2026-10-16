import { expect, test, type Page } from '@playwright/test';
import { layoutAdminSession, layoutProducts, mockLayoutData } from './layout-fixtures';

/*
 * Thẻ kết quả phân bổ (đặt → kết quả → chờ ưu tiên → phiếu chờ cũ ⇒ phiếu chờ mới) và bảng tồn kho
 * tổng (khả dụng, giữ chờ giao chung, giữ phiếu chờ, tổng đã xuất) trên production bundle với API
 * fixture: không tràn ngang ở 360–1440 px, chữ/nút không bị cắt.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-15T02:00:00.000Z';
const storeId = id(31);
const sessionId = id(70);
const runId = id(71);
const emptyPage = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
const [nam, nu, jeans, ao, quan] = layoutProducts.map((product) => product.id);

function source(
  n: number,
  productId: string,
  requested: number,
  allocated: number,
  waitTicketId: string | null = null,
) {
  return {
    result: {
      id: id(100 + n),
      allocationRunId: runId,
      sessionId,
      mergedOrderId: null,
      storeId,
      productId,
      priority: waitTicketId ? 'P0A' : 'P1',
      appliedPriority: waitTicketId ? 'P0A' : 'P1',
      roundNumber: 1,
      sequenceInRound: n,
      rounds: allocated ? [{ roundNumber: 1, allocatedQuantity: allocated }] : [],
      requestedQuantity: requested,
      allocatedQuantity: allocated,
      waitlistedQuantity: requested - allocated,
      status: allocated === requested ? 'ALLOCATED' : allocated ? 'PARTIAL' : 'WAITLISTED',
      reasonCode: 'ROUND_ROBIN',
      createdAt: time,
    },
    orderRequestId: waitTicketId ? null : id(80),
    orderRequestCode: waitTicketId ? null : 'PDH-000042',
    orderRequestItemId: waitTicketId ? null : id(90 + n),
    submittedAt: waitTicketId ? null : time,
    waitTicketId,
    priorityOfferId: waitTicketId ? id(95 + n) : null,
  };
}

const line = (productId: string, quantity: number, pendingQuantity = 0) => ({
  productId,
  quantity,
  remainingQuantity: quantity - pendingQuantity,
  pendingQuantity,
});

const sessionDocument = {
  id: `${sessionId}:${storeId}`,
  orderCode: `TH-${sessionId}-${storeId}`,
  resultCode: `KQ-${sessionId}-${storeId}`,
  sessionId,
  storeId,
  allocationRunId: runId,
  version: 1,
  createdAt: time,
  hasPrioritySource: false,
  carriedAllocations: [],
  // The run also grants the 1 Áo of the old wait document: it leaves the waiting bags.
  sources: [
    source(1, nam!, 3, 2),
    source(2, nu!, 2, 0),
    source(3, jeans!, 4, 1),
    source(4, ao!, 1, 1, id(60)),
  ],
  decision: {
    id: id(72),
    allocationRunId: runId,
    runVersion: 1,
    sessionId,
    sessionCode: 'PDH-000042',
    businessDate: '2026-10-15',
    storeId,
    status: 'ACCEPTED',
    version: 2,
    grantedQuantity: 3,
    origin: 'ALLOCATION_RUN',
    canRespond: false,
    respondedAt: time,
    respondedByAccountId: null,
    respondedByName: null,
    reason: null,
    createdAt: time,
    updatedAt: time,
    lines: [],
    carried: [],
    heldQuantity: 0,
    releasedQuantity: 0,
    shipment: null,
  },
  waitDocuments: {
    // 1 Quần of the old document had a full offer nobody answered: the run cancelled it.
    before: { id: id(73), code: 'PCT-000011', lines: [line(ao!, 1), line(quan!, 3), line(nu!, 3)] },
    after: {
      id: id(74),
      code: 'PCT-000012',
      lines: [line(nam!, 1), line(nu!, 5), line(ao!, 1, 1), line(quan!, 2), line(jeans!, 3)],
    },
    changed: true,
    removed: [{ productId: quan!, quantity: 1, reason: 'PRIORITY_RESPONSE_TIMEOUT' }],
  },
  lines: [
    { productId: nam, requestedQuantity: 3, allocatedQuantity: 2, waitlistedQuantity: 1 },
    { productId: nu, requestedQuantity: 2, allocatedQuantity: 0, waitlistedQuantity: 2 },
    { productId: jeans, requestedQuantity: 4, allocatedQuantity: 1, waitlistedQuantity: 3 },
    { productId: ao, requestedQuantity: 1, allocatedQuantity: 1, waitlistedQuantity: 0 },
  ],
};

const historySession = {
  id: sessionId,
  code: 'PDH-000042',
  kind: 'DEFAULT',
  businessDate: '2026-10-15',
  status: 'ALLOCATED',
  requestOpensAt: '2026-10-14T01:00:00.000Z',
  requestClosesAt: '2026-10-15T01:00:00.000Z',
  allocationStartsAt: '2026-10-15T02:00:00.000Z',
  completedAt: time,
};

function historyEntry(
  n: number,
  status: 'SUBMITTED' | 'ALLOCATED' | 'PARTIALLY_ALLOCATED' | 'WAITLISTED',
  quantities: readonly number[],
) {
  return {
    id: id(200 + n),
    code: `PDT-00012${n}`,
    requestSequence: 1,
    status,
    storeId,
    storeCode: 'CH-A',
    storeName: 'Cửa hàng A — chi nhánh trung tâm thành phố',
    session: historySession,
    submittedAt: time,
    submittedBy: { accountId: id(210), displayName: 'Nhân viên cửa hàng A' },
    cancelledAt: null,
    cancellationReason: null,
    mergedDocument:
      status === 'SUBMITTED'
        ? null
        : { sessionId, storeId, mergedOrderId: id(220 + n), version: 1 },
    lines: quantities.map((quantity, index) => ({
      id: id(230 + n * 10 + index),
      productId: layoutProducts[index]!.id,
      sku: `SKU-HIDDEN-${index}`,
      productName: layoutProducts[index]!.name,
      unit: 'BAG',
      requestedQuantity: quantity,
      matchesFilter: true,
    })),
  };
}

const orderHistory = [
  historyEntry(1, 'SUBMITTED', [1, 1, 2, 1]),
  historyEntry(2, 'PARTIALLY_ALLOCATED', [2, 2]),
  historyEntry(3, 'ALLOCATED', [1]),
];

async function mockApi(page: Page) {
  const requests: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    requests.push(`${path}${url.search}`);
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: {} });
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === '/auth/session') return json({ data: layoutAdminSession('Thẻ kết quả') });
    if (path === '/stores')
      return json({
        data: [
          {
            id: storeId,
            code: 'CH-A',
            name: 'Cửa hàng A — chi nhánh trung tâm thành phố',
            groupId: id(40),
            kind: 'RETAIL',
            status: 'ACTIVE',
            address: null,
            version: 0,
            createdAt: time,
            updatedAt: time,
          },
        ],
        pagination: { ...emptyPage, pageSize: 100, totalItems: 1, totalPages: 1 },
      });
    if (path === '/session-documents')
      return json({
        data: [sessionDocument],
        pagination: { ...emptyPage, totalItems: 1, totalPages: 1 },
      });
    if (path === '/order-history')
      return json({
        data: orderHistory,
        pagination: { ...emptyPage, totalItems: 3, totalPages: 1 },
      });
    if (path === '/held-allocations' || path === '/store-sorted-stocks') return json({ data: [] });
    return json({ data: [], pagination: emptyPage });
  });
  await mockLayoutData(page);
  return requests;
}

const widths = [360, 390, 768, 1366, 1440];

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}

test('allocation result card reads order, result, waiting and old ⇒ new wait document', async ({
  page,
}, testInfo) => {
  const requests = await mockApi(page);
  await page.goto('/allocations');
  const card = page.getByRole('article', { name: 'Cửa hàng A — chi nhánh trung tâm thành phố' });
  await expect(card).toBeVisible();
  expect(requests.some((entry) => entry.includes('includeWaitDocuments=true'))).toBe(true);
  expect(requests.some((entry) => entry.includes('includeWaitRemovals=true'))).toBe(true);
  await expect(card.getByText('Phân bổ lúc', { exact: false })).toBeVisible();
  await expect(card.getByText('Đã xác nhận phân bổ')).toBeVisible();
  await expect(card.getByRole('button', { name: /Xem phiếu/u })).toBeVisible();
  const summary = card.locator('.allocation-summary');
  const terms = summary.getByRole('term');
  await expect(terms).toHaveText([
    /đặt\s*9 bao$/u,
    /^Kết quả\s*4 bao$/u,
    /^Chờ ưu tiên\s*6 bao$/u,
    /^Phiếu chờ cũ\s*PCT-000011\s*7 bao$/u,
    /^Hủy khỏi phiếu chờ\s*1 bao$/u,
    // 7 old − 1 Áo granted − 1 Quần cancelled + 6 new waiting: the granted Áo awaits the
    // answer, noted apart.
    /^⇒ Phiếu chờ mới\s*PCT-000012\s*11 bao$/u,
  ]);
  await expect(
    card.getByText('Không gồm 1 bao đã cấp, chờ xác nhận phân bổ', { exact: false }),
  ).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await card.screenshot({ path: testInfo.outputPath(`allocation-card-${width}.png`) });
  }
  // Only a plain button on the card face; long internal codes never reach the screen.
  const details = card.locator('summary');
  await expect(details).toHaveText('Xem chi tiết');
  await expect(card.getByText(/KQ-|TH-/u)).toHaveCount(0);
  // Opening at desktop first sets header minimum widths. The details grid item must still
  // shrink when the viewport changes, so the observer can re-evaluate those widths.
  await details.click();
  await expect(details).toHaveText('Ẩn chi tiết');
  await expect(card.getByText(/KQ-|TH-|phiên bản/u)).toHaveCount(0);
  await expect(card.getByText('Nguồn đặt hàng và các vòng phân bổ')).toBeVisible();
  const detailTable = card.locator('details table');
  await expect(detailTable.locator('th').first()).toHaveText('STT');
  for (const width of [360, 390, 412, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    const detailBox = await card.locator('details').boundingBox();
    const cardBox = await card.boundingBox();
    expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    await expect(detailTable.locator('tbody tr')).toHaveCount(sessionDocument.lines.length);
    await card.screenshot({ path: testInfo.outputPath(`allocation-card-details-${width}.png`) });
  }
});

test('warehouse stock shows available, both holds, total dispatched and the action', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto('/inventory?tab=warehouse');
  const table = page.locator('.warehouse-stock-table');
  await expect(table.locator('tbody tr')).toHaveCount(24);
  for (const header of [
    'Mặt hàng',
    'Đang có tại kho',
    'Đang giữ chờ giao chung',
    'Đang giữ phiếu chờ',
    'Tổng đã xuất',
    'Thao tác',
  ]) {
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeAttached();
  }
  // Names only: the SKU no longer sits under the product name.
  await expect(table.getByText('LAYOUT-1', { exact: true })).toHaveCount(0);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`warehouse-stock-${width}.png`) });
  }
});

test('order history: store name only, separate order/store and product/quantity columns', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto('/allocations?tab=history');
  const table = page.locator('.order-history__table');
  await expect(table.locator('tbody')).toHaveCount(orderHistory.length);
  for (const header of ['Phiếu đặt hàng', 'Cửa hàng', 'Mặt hàng', 'Số lượng', 'Trạng thái']) {
    await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeAttached();
  }
  await expect(page.getByText('CH-A', { exact: false })).toHaveCount(0);
  await expect(page.getByText('SKU-HIDDEN', { exact: false })).toHaveCount(0);
  const firstOrder = table.locator('tbody').first();
  await expect(firstOrder.locator('tr')).toHaveCount(4);
  for (const width of [1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Each product sits on the same line as its quantity.
    const products = firstOrder.locator('td.order-history__product');
    const quantities = firstOrder.locator('td.order-history__quantity');
    for (let index = 0; index < 4; index += 1) {
      const product = await products.nth(index).boundingBox();
      const quantity = await quantities.nth(index).boundingBox();
      expect(Math.abs(product!.y - quantity!.y)).toBeLessThanOrEqual(1);
    }
    // Status badges start at one left edge whatever their label length.
    const badges = await table
      .locator('.order-history__status .badge')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(badges).size).toBe(1);
    const storeSize = await table
      .locator('.order-history__store')
      .first()
      .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const cellSize = await firstOrder
      .locator('td.order-history__product')
      .first()
      .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(storeSize).toBeGreaterThan(cellSize);
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await page
      .locator('.order-history')
      .screenshot({ path: testInfo.outputPath(`order-history-${width}.png`) });
  }
});

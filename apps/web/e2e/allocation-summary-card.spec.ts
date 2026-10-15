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

function source(n: number, productId: string, requested: number, allocated: number) {
  return {
    result: {
      id: id(100 + n),
      allocationRunId: runId,
      sessionId,
      mergedOrderId: null,
      storeId,
      productId,
      priority: 'P1',
      appliedPriority: 'P1',
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
    orderRequestId: id(80),
    orderRequestCode: 'PDH-000042',
    orderRequestItemId: id(90 + n),
    submittedAt: time,
    waitTicketId: null,
    priorityOfferId: null,
  };
}

const line = (productId: string, quantity: number) => ({
  productId,
  quantity,
  remainingQuantity: quantity,
  pendingQuantity: 0,
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
  sources: [source(1, nam!, 3, 2), source(2, nu!, 2, 0), source(3, jeans!, 4, 1)],
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
    before: { id: id(73), code: 'PCT-000011', lines: [line(ao!, 1), line(quan!, 2), line(nu!, 3)] },
    after: {
      id: id(74),
      code: 'PCT-000012',
      lines: [line(nam!, 1), line(nu!, 5), line(ao!, 1), line(quan!, 2), line(jeans!, 3)],
    },
    changed: true,
  },
  lines: [
    { productId: nam, requestedQuantity: 3, allocatedQuantity: 2, waitlistedQuantity: 1 },
    { productId: nu, requestedQuantity: 2, allocatedQuantity: 0, waitlistedQuantity: 2 },
    { productId: jeans, requestedQuantity: 4, allocatedQuantity: 1, waitlistedQuantity: 3 },
  ],
};

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
  await expect(card.getByText('Phân bổ lúc', { exact: false })).toBeVisible();
  await expect(card.getByText('Đã xác nhận phân bổ')).toBeVisible();
  await expect(card.getByRole('button', { name: /Xem phiếu/u })).toBeVisible();
  const summary = card.locator('.allocation-summary');
  const terms = summary.getByRole('term');
  await expect(terms).toHaveText([
    /đặt\s*9 bao$/u,
    /^Kết quả\s*3 bao$/u,
    /^Chờ ưu tiên\s*6 bao$/u,
    /^Phiếu chờ cũ\s*PCT-000011\s*6 bao$/u,
    /^⇒ Phiếu chờ mới\s*PCT-000012\s*12 bao$/u,
  ]);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await card.screenshot({ path: testInfo.outputPath(`allocation-card-${width}.png`) });
  }
  // Opening at desktop first sets header minimum widths. The details grid item must still
  // shrink when the viewport changes, so the observer can re-evaluate those widths.
  await card.locator('summary').click();
  const detailTable = card.locator('details table');
  await expect(detailTable.locator('th').first()).toHaveText('STT');
  for (const width of [360, 390, 412, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    const detailBox = await card.locator('details').boundingBox();
    const cardBox = await card.boundingBox();
    expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    await expect(detailTable.locator('tbody tr')).toHaveCount(sessionDocument.lines.length);
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

import { expect, test, type Page, type Request } from '@playwright/test';

import { layoutAdminSession } from './layout-fixtures';

/*
 * Đơn đặt và tồn Reshare trên production bundle với API giả lập theo đúng contract: mọi vai trò
 * mở vào "Đơn đặt Reshare" (lịch sử RE nhóm theo đơn, lọc phía server), Admin và HTKD quản lý
 * toàn mục (đổi trạng thái, cập nhật tồn, cấu hình nguồn), mỗi đơn có "Lịch sử thay đổi" tải khi
 * mở, đơn ghi nhận thủ công chỉ còn ở mục dữ liệu cũ, mặt hàng chỉ hiện tên (không kèm SKU), và
 * bố cục/chữ đủ lớn, không tràn ở các bề rộng đại diện.
 */

type Role = 'ADMIN' | 'HTKD' | 'STORE';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-13T01:00:00.000Z';
const page1 = (count: number) => ({
  page: 1,
  pageSize: 20,
  totalItems: count,
  totalPages: count ? 1 : 0,
});
const productId = id(501);
const reshareLineId = id(1101);

const reshareRows = [
  {
    decisionId: id(1001),
    decisionStatus: 'ACCEPTED',
    sessionId: id(801),
    sessionCode: 'PDH-000012',
    businessDate: '2026-10-13',
    runVersion: 1,
    sessionOpenedAt: '2026-10-12T17:00:00.000Z',
    allocationCompletedAt: '2026-10-13T02:00:05.000Z',
    publishedAt: '2026-10-13T02:00:05.000Z',
    acceptedAt: '2026-10-13T02:20:00.000Z',
    acceptedByName: 'Cửa hàng Gò Vấp',
    storeId: id(31),
    storeName: 'Cửa hàng Gò Vấp — chi nhánh có tên rất dài để kiểm tra xuống dòng',
    status: 'ORDERED',
    order: {
      id: id(1002),
      code: 'RE-000001',
      orderedAt: '2026-10-13T02:20:00.000Z',
      origin: 'ACCEPTANCE',
      actorName: 'Cửa hàng Gò Vấp',
      actorRole: 'STORE',
      cancelledAt: null,
      cancelReason: null,
    },
    lines: [
      { productId, productName: 'Quần dài nữ', productSku: 'QDN', quantity: 2 },
      { productId: id(502), productName: 'Áo', productSku: 'AO', quantity: 3 },
    ],
    totalQuantity: 5,
    delivery: {
      issuedQuantity: 5,
      receivedQuantity: 0,
      shortageQuantity: 0,
      awaitingReceiptQuantity: 5,
      onShipmentQuantity: 5,
    },
  },
  {
    decisionId: id(1003),
    decisionStatus: 'PENDING',
    sessionId: id(803),
    sessionCode: 'PDH-000013',
    businessDate: '2026-10-13',
    runVersion: 1,
    sessionOpenedAt: '2026-10-13T03:00:00.000Z',
    allocationCompletedAt: '2026-10-13T05:00:02.000Z',
    publishedAt: '2026-10-13T05:00:02.000Z',
    acceptedAt: null,
    acceptedByName: null,
    storeId: id(31),
    storeName: 'Cửa hàng Gò Vấp — chi nhánh có tên rất dài để kiểm tra xuống dòng',
    status: 'NOT_ORDERED',
    order: null,
    lines: [{ productId, productName: 'Quần dài nữ', productSku: 'QDN', quantity: 1 }],
    totalQuantity: 1,
    delivery: null,
  },
];
const eventId = id(601);
const reservationId = id(701);

const position = {
  state: 'RECONCILED',
  baselineQuantity: 3,
  pendingDelta: -1,
  ambiguousEventCount: 0,
  effectiveSupplierQuantity: 2,
  offerHoldQuantity: 0,
  unorderedReservedQuantity: 2,
  orderedReservedQuantity: 1,
  unorderedCommitmentQuantity: 2,
  freeQuantity: 0,
  shortfallQuantity: 0,
  ledgerOnHand: 3,
  ledgerReserved: 3,
  ledgerAvailable: 0,
  targetOnHand: 3,
  projectionMismatch: false,
  allocatableQuantity: 0,
};

const productName = 'Bao đồ nam tuyển chọn — tên dài để kiểm tra xuống dòng trong bảng đối chiếu';
const totalLabel = `Tổng số bao Reshare đang cho đặt của ${productName}`;
const summaryRow = {
  productId,
  sku: 'NAM-01',
  productName,
  productActive: true,
  sourceId: id(401),
  sourceCode: 'RESHARE',
  status: 'ACTIVE',
  blockReason: null,
  baseline: { observedQuantity: 3, observedAt: time },
  position,
  integrityIssueCount: 0,
};

const commitment = {
  kind: 'RESERVATION',
  id: reservationId,
  commitmentKey: id(702),
  productId,
  sku: 'NAM-01',
  productName: summaryRow.productName,
  storeId: id(31),
  storeCode: 'CH-GOVAP',
  storeName: 'Cửa hàng Gò Vấp',
  orderSessionId: id(801),
  orderSessionCode: 'PH0001-12/10/2026',
  businessDate: '2026-10-12',
  allocationRunId: id(802),
  allocationLineId: id(702),
  priorityLevel: 'P1',
  decisionStatus: 'accepted',
  outboundRequestNumber: null,
  outboundStatus: null,
  quantity: 3,
  orderedQuantity: 1,
  cancelledQuantity: 0,
  unorderedQuantity: 2,
  orderState: 'PARTIALLY_ORDERED',
  orderable: true,
  notOrderableReason: null,
  heldSince: time,
  deadlineAt: null,
  htkdNames: ['HTKD Miền Nam'],
};

function preview(decided: boolean) {
  return {
    revision: decided ? 'rev-2' : 'rev-1',
    observedAt: time,
    blockingIssues: decided ? [] : ['EXTERNAL_EVENT_COVERAGE_AMBIGUOUS'],
    lines: [
      {
        productId,
        sku: 'NAM-01',
        productName: summaryRow.productName,
        observedQuantity: 2,
        statusBefore: 'ACTIVE',
        statusAfter: decided ? 'ACTIVE' : 'NEEDS_RECONCILIATION',
        baselineBefore: { observedQuantity: 3, observedAt: time },
        before: position,
        after: { ...position, pendingDelta: 0, effectiveSupplierQuantity: 2 },
        events: [
          {
            id: eventId,
            kind: 'ORDER',
            quantity: 1,
            coverage: 'OPEN',
            occurredAt: time,
            recordedAt: time,
            externalRef: 'RS-1001',
            externalLineRef: 'NAM-01',
            storeId: id(31),
            decision: decided ? 'COVERED' : 'UNDECIDED',
          },
        ],
        undecidedEventCount: decided ? 0 : 1,
        coveredEventCount: decided ? 1 : 0,
        unlinkedLegacyQuantity: 0,
        issuedOrders: [
          {
            lineId: reshareLineId,
            orderId: id(1002),
            code: 'RE-000001',
            storeId: id(31),
            storeName: 'Cửa hàng Gò Vấp',
            orderedAt: time,
            quantity: 2,
            unreflectedQuantity: 2,
            declaredReflectedQuantity: 0,
            afterObservation: false,
          },
        ],
        reflectedReshareQuantity: 0,
        onHandDelta: 0,
      },
    ],
  };
}

const observation = {
  id: id(901),
  sourceId: id(401),
  observedAt: time,
  recordedAt: time,
  note: null,
  evidenceRef: null,
  createdBy: { accountId: id(2), displayName: 'Admin' },
  lines: [
    {
      productId,
      sku: 'NAM-01',
      productName: summaryRow.productName,
      observedQuantity: 2,
      coveredEventCount: 1,
      effectiveSupplierQuantity: 2,
      offerHoldQuantity: 0,
      unorderedReservedQuantity: 2,
      orderedReservedQuantity: 1,
      attestedUnlinkedQuantity: 0,
      unorderedCommitmentQuantity: 2,
      freeQuantity: 0,
      shortfallQuantity: 0,
      onHandBefore: 3,
      reservedBefore: 3,
      onHandAfter: 3,
      ledgerEntryId: null,
      statusBefore: 'ACTIVE',
    },
  ],
};

function sessionFor(role: Role) {
  const session = layoutAdminSession('Kiểm thử Reshare');
  if (role === 'ADMIN') return session;
  return {
    ...session,
    principal: {
      ...session.principal,
      accountId: id(3),
      role,
      storeId: role === 'STORE' ? id(31) : null,
      assignedStoreIds: role === 'HTKD' ? [id(31)] : [],
      username: role.toLowerCase(),
    },
  };
}

interface Log {
  readonly mutations: Request[];
  readonly orderQueries: URLSearchParams[];
  readonly historyQueries: string[];
  failNextConfirm: boolean;
  failNextStatus?: boolean;
}

async function mockApi(
  page: Page,
  role: Role,
  unlinkedLegacyQuantity = 0,
  longList = false,
): Promise<Log> {
  const log: Log = { mutations: [], orderQueries: [], historyQueries: [], failNextConfirm: false };
  const events = new Map<string, Record<string, unknown>[]>();
  let previews = 0;
  const historyRows = reshareRows.map((row) => ({
    ...structuredClone(row),
    statusControl: {
      version: 0,
      updatedAt: null as string | null,
      updatedByName: null as string | null,
      updatedByRole: null as string | null,
    },
  }));
  const savedStatus = new Map<string, unknown>();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === '/auth/session') return json({ data: sessionFor(role) });
    if (path === '/stores')
      return json({
        data: [
          {
            id: id(31),
            code: 'CH-GOVAP',
            name: 'Cửa hàng Gò Vấp',
            groupId: id(40),
            kind: 'RETAIL',
            status: 'ACTIVE',
            address: null,
            version: 0,
            createdAt: time,
            updatedAt: time,
          },
        ],
        pagination: { ...page1(1), pageSize: 100 },
      });
    if (request.method() !== 'GET') log.mutations.push(request);
    if (path === '/reshare-orders/stores')
      return json({
        data: [
          { id: id(31), code: 'CH-GOVAP', name: 'Cửa hàng Gò Vấp', isActive: true },
          { id: id(32), code: 'CH-Q1', name: 'Cửa hàng Quận 1', isActive: false },
        ],
        scoped: role === 'STORE',
      });
    if (/^\/reshare-orders\/.+\/status-history$/u.test(path)) {
      log.historyQueries.push(path);
      const decisionId = path.split('/')[2]!;
      const list = [...(events.get(decisionId) ?? [])].reverse();
      return json({
        data: list,
        pagination: {
          page: 1,
          pageSize: 10,
          totalItems: list.length,
          totalPages: list.length ? 1 : 0,
        },
        decision: { id: decisionId, storeId: id(31), publishedAt: '2026-10-13T05:00:02.000Z' },
      });
    }
    if (/^\/reshare-orders\/.+\/status$/u.test(path)) {
      const key = request.headers()['idempotency-key']!;
      if (savedStatus.has(key)) return json({ data: savedStatus.get(key) });
      const row = historyRows.find((row) => path.includes(row.decisionId))!;
      const input = request.postDataJSON();
      const actorName = role === 'ADMIN' ? 'Quản trị viên' : 'Nhân viên HTKD';
      events.set(row.decisionId, [
        ...(events.get(row.decisionId) ?? []),
        {
          id: id(5000 + (events.get(row.decisionId)?.length ?? 0)),
          occurredAt: time,
          kind: 'STATUS_CHANGED',
          source: 'MANUAL',
          statusBefore: row.status,
          statusAfter: input.status,
          version: row.statusControl.version + 1,
          orderCode: row.order?.code ?? null,
          actor: { accountId: id(3), role, nameAtEvent: actorName, currentName: null },
          requestId: `req-${key}`,
        },
      ]);
      row.status = input.status;
      row.statusControl = {
        version: row.statusControl.version + 1,
        updatedAt: time,
        updatedByName: actorName,
        updatedByRole: role,
      };
      const data = {
        decisionId: row.decisionId,
        status: row.status,
        version: row.statusControl.version,
      };
      savedStatus.set(key, data);
      if (log.failNextStatus) {
        log.failNextStatus = false;
        return route.abort('failed');
      }
      return json({ data });
    }
    if (path === '/reshare-orders') {
      log.orderQueries.push(url.searchParams);
      const status = url.searchParams.get('status');
      const code = url.searchParams.get('code');
      const rows = historyRows.filter(
        (row) =>
          (!status || row.status === status) && (!code || (row.order?.code ?? '').includes(code)),
      );
      // Like the API: the recorded role is only sent to bundles that ask for it.
      const withActor = url.searchParams.get('includeStatusActor') === 'true';
      const data = rows.map((row) => {
        if (withActor) return row;
        const { updatedByRole: _omitted, ...statusControl } = row.statusControl;
        return { ...row, statusControl };
      });
      return json({ data, pagination: page1(rows.length), scoped: role === 'STORE' });
    }
    if (path === '/supplier-sources' && request.method() === 'GET')
      return json({
        data: [
          {
            id: id(401),
            code: 'RESHARE',
            name: 'Kho Reshare',
            isActive: true,
            productCount: 1,
            createdAt: time,
          },
        ],
      });
    if (path === '/supplier-reconciliation')
      return json({
        data: longList
          ? Array.from({ length: 20 }, (_, index) => ({
              ...summaryRow,
              productId: id(501 + index),
              productName: `Mặt hàng ${index + 1}`,
            }))
          : [summaryRow],
        pagination: page1(longList ? 20 : 1),
        revision: 'rev-1',
        generatedAt: time,
      });
    if (path === '/supplier-commitments')
      return json({
        data: [commitment],
        pagination: page1(1),
        totals: { quantity: 3, orderedQuantity: 1, unorderedQuantity: 2 },
        scoped: role === 'STORE',
      });
    if (path === '/supplier-orders' && request.method() === 'GET')
      return json({ data: [], pagination: { ...page1(0), pageSize: 10 } });
    if (path === '/supplier-stock-observations/preview') {
      previews += 1;
      const body = request.postDataJSON() as { eventCoverage: { eventId: string }[] };
      const data = preview(body.eventCoverage.length > 0 || previews > 2);
      data.lines[0]!.unlinkedLegacyQuantity = unlinkedLegacyQuantity;
      if (longList) {
        const input = request.postDataJSON() as {
          lines: { productId: string; observedQuantity: number }[];
        };
        data.lines = input.lines.map((line) => ({
          ...data.lines[0]!,
          ...line,
          productName: `Mặt hàng ${Number(line.productId.slice(-12)) - 500}`,
          events: [],
          undecidedEventCount: 0,
          issuedOrders: [],
        }));
        data.blockingIssues = [];
      }
      return json({ data });
    }
    if (path === '/supplier-stock-observations') {
      if (log.failNextConfirm) {
        log.failNextConfirm = false;
        return route.abort('connectionreset');
      }
      return json({ data: observation }, 201);
    }
    if (path === '/supplier-orders' && request.method() === 'POST')
      return json(
        {
          data: {
            id: id(951),
            sourceId: id(401),
            kind: 'ORDER',
            externalRef: 'RS-2002',
            storeId: id(31),
            occurredAt: time,
            recordedAt: time,
            note: null,
            createdBy: { accountId: id(3), displayName: 'HTKD' },
            events: [
              {
                id: id(952),
                productId,
                sku: 'NAM-01',
                productName: summaryRow.productName,
                kind: 'ORDER',
                quantity: 2,
                externalRef: 'RS-2002',
                externalLineRef: 'NAM-01',
                coverage: 'OPEN',
                reversesEventId: null,
                links: [{ reservationId, allocationLineId: id(702), storeId: id(31), quantity: 2 }],
              },
            ],
          },
        },
        201,
      );
    return json({ data: [], pagination: page1(0) });
  });
  return log;
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('Admin persists both states for legacy rows, reloads, filters and retries the same command', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation');
  const group = page.locator('.reshare-history tbody').filter({ hasText: 'PDH-000013' });
  log.failNextStatus = true;
  await group.getByRole('button', { name: 'Đánh dấu đã đặt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Không xác nhận được kết quả lưu');
  await expect(group.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
  await group.getByRole('button', { name: 'Đánh dấu đã đặt', exact: true }).click();
  await expect(group.getByText('Đã đặt Reshare', { exact: true })).toBeVisible();
  const writes = log.mutations.filter((request) => request.url().endsWith('/status'));
  expect(writes).toHaveLength(2);
  expect(writes[0]!.method()).toBe('PUT');
  expect(writes[0]!.headers()['idempotency-key']).toBe(writes[1]!.headers()['idempotency-key']);
  expect(writes[0]!.postDataJSON()).toEqual({
    status: 'ORDERED',
    expectedStatus: 'NOT_ORDERED',
    expectedVersion: 0,
  });
  await page.reload();
  await expect(group.getByText('Đã đặt Reshare', { exact: true })).toBeVisible();
  await expect(group).toContainText('Chưa có chứng từ RE');
  await expect(group).toContainText('Quản trị viên');
  await group.getByRole('button', { name: 'Đánh dấu chưa đặt', exact: true }).click();
  await expect(group.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
  await page.getByLabel('Trạng thái').selectOption('ORDERED');
  await expect(group).toHaveCount(0);
  await expectNoPageOverflow(page);
});

test('STORE sees the acknowledgement and its history with no edit controls', async ({ page }) => {
  const log = await mockApi(page, 'STORE');
  await page.goto('/supplier-reconciliation');
  await expect(page.locator('.reshare-history')).toBeVisible();
  await expect(page.getByRole('button', { name: /Đánh dấu (chưa đặt|đã đặt)/u })).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  // The store filter only offers the account's own scope.
  await expect(page.getByLabel('Cửa hàng', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Lịch sử thay đổi của RE-000001/u }).click();
  await expect(page.getByRole('dialog', { name: 'Lịch sử thay đổi trạng thái' })).toBeVisible();
  await expect(page.getByText('Chưa ghi nhận thay đổi trạng thái nào')).toBeVisible();
  expect(log.mutations).toHaveLength(0);
});

test('HTKD changes the status of any store and every change shows in the order history', async ({
  page,
}) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('tab')).toHaveText([
    'Đơn đặt Reshare',
    'Cập nhật tồn Reshare',
    'Lịch sử cập nhật tồn',
    'Cấu hình nguồn',
  ]);
  // Reshare-only store filter: every store, inactive ones marked.
  const storeFilter = page.getByRole('combobox', { name: 'Cửa hàng', exact: true });
  await expect(storeFilter.locator('option')).toHaveText([
    'Tất cả cửa hàng',
    'Cửa hàng Gò Vấp',
    'Cửa hàng Quận 1 (ngừng hoạt động)',
  ]);
  // No history is requested for the rows until a dialog is opened (no N+1).
  expect(log.historyQueries).toHaveLength(0);
  const group = page.locator('.reshare-history tbody').filter({ hasText: 'PDH-000013' });
  await group.getByRole('button', { name: 'Đánh dấu đã đặt', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ghi vào lịch sử' })).toBeVisible();
  await expect(group).toContainText('Cập nhật lần cuối bởi Nhân viên HTKD (HTKD)');
  await group.getByRole('button', { name: 'Đánh dấu chưa đặt', exact: true }).click();
  await expect(group.getByText('Chưa đặt Reshare', { exact: true })).toBeVisible();
  const open = group.getByRole('button', { name: /^Lịch sử thay đổi của PDH-000013/u });
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Lịch sử thay đổi trạng thái' });
  await expect(dialog).toBeVisible();
  // Only the opened order's history is read.
  expect(new Set(log.historyQueries)).toEqual(
    new Set(['/reshare-orders/' + id(1003) + '/status-history']),
  );
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // Newest first, with the real actor and role, before → after.
  await expect(rows.nth(0)).toContainText('Đã đặt Reshare');
  await expect(rows.nth(0).locator('td').nth(2)).toHaveText('Chưa đặt Reshare');
  await expect(rows.nth(0)).toContainText('Nhân viên HTKD');
  await expect(rows.nth(0).locator('td').nth(4)).toHaveText('HTKD');
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('Đã đặt Reshare');
  await expect(dialog).toContainText('08:00:00 13/10/2026');
  await expect(dialog.getByText(/Không có dữ liệu lịch sử nào trước các dòng trên/u)).toBeVisible();
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoPageOverflow(page);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('every role opens on its RE orders: one group per order, total once, server filters', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('heading', { name: 'Đơn đặt và tồn Reshare' })).toBeVisible();
  await expect(page.getByText('Xác nhận kết quả phân bổ để tự tạo đơn Reshare')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Đơn đặt Reshare' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' })).toBeVisible();
  // One table at every width (cards on narrow screens): one group per order, total once.
  const table = page.locator('.reshare-history');
  await expect(table.getByText('RE-000001')).toHaveCount(1);
  await expect(table.getByText('Quần dài nữ').first()).toBeVisible();
  await expect(table.getByText('Áo', { exact: true })).toBeVisible();
  const totals = table.locator('tbody').first().locator('.reshare-history__total');
  await expect(totals).toHaveCount(1);
  await expect(totals).toHaveText('5');
  await expect(table.getByText('Chưa đặt Reshare')).toBeVisible();
  await expect(table.getByText('Mở phiên: 00:00:00 13/10/2026').first()).toBeVisible();
  // The manual order form is no longer part of the main flow.
  await expect(page.getByLabel('Mã đơn Reshare')).toHaveCount(0);
  await page.getByLabel('Trạng thái').selectOption('ORDERED');
  await expect(table.getByText('Chưa đặt Reshare')).toHaveCount(0);
  expect(log.orderQueries.at(-1)?.get('status')).toBe('ORDERED');
  await page.getByLabel('Mã đơn RE').fill('re-000001');
  await page.getByRole('button', { name: 'Tìm' }).click();
  await expect.poll(() => log.orderQueries.at(-1)?.get('code')).toBe('RE-000001');
  expect(log.mutations).toHaveLength(0);
});

test('a deep link from the result tag opens the order by its RE code', async ({ page }) => {
  const log = await mockApi(page, 'STORE');
  await page.goto('/supplier-reconciliation?tab=orders&code=RE-000001');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.locator('.reshare-history').getByText('RE-000001')).toBeVisible();
  expect(log.orderQueries[0]?.get('code')).toBe('RE-000001');
  // The old "status" tab link still lands on the order history.
  await page.goto('/supplier-reconciliation?tab=status');
  await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ghi nhận đơn Reshare' })).toHaveCount(0);
  expect(log.mutations).toHaveLength(0);
});

test('Admin updates Reshare stock: re-observing frees nothing, RE coverage is explicit and the key is kept on retry', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await expect(page.getByRole('tab', { name: 'Cập nhật tồn Reshare' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const row = page.getByRole('row').filter({ hasText: productName }).first();
  await expect(row).toContainText('Đã đối chiếu');
  // Product name only: the SKU never appears next to it.
  await expect(row.locator('.supplier-product-name')).toHaveText(productName);
  await expect(row).not.toContainText('NAM-01');

  const details = row.getByRole('button', { name: 'Xem giữ hàng' });
  await details.click();
  await expect(row.getByRole('button', { name: 'Thu gọn' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByText('CH-GOVAP')).toBeVisible();
  await expect(page.getByText(/Reshare còn đặt được 2 bao/u)).toBeVisible();

  await row.getByRole('button', { name: 'Đối chiếu' }).click();
  await expect(page.getByText('không phải số nhập thêm')).toBeVisible();
  await page.getByLabel(totalLabel).fill('2');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  const save = page.getByRole('button', { name: 'Lưu cập nhật tồn' });
  await expect(page.getByText('Còn 1 biến động chưa trả lời')).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(page.getByText('Số tồn này đã trừ các đơn RE nào?')).toBeVisible();
  await page.getByLabel('Đã gồm trong số vừa nhập').check();
  await page.getByLabel('Đã trừ trong số vừa nhập').check();
  await expect(page.getByLabel('Số bao của RE-000001 đã trừ trong số tồn')).toHaveValue('2');
  await expect(page.getByText(/Bấm “Xem trước lại”/u)).toBeVisible();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(save).toBeEnabled();

  // The first confirmation loses its response; the retry must reuse the same key and payload.
  log.failNextConfirm = true;
  await save.click();
  await expect(page.getByRole('alert')).toContainText('cùng thao tác sẽ không bị ghi hai lần');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu cập nhật tồn' })).toContainText(
    `${productName}: khả dụng giữ nguyên 0 bao.`,
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'Đã lưu cập nhật tồn' }),
  ).toBeInViewport();
  const confirms = log.mutations.filter((request) =>
    request.url().endsWith('/supplier-stock-observations'),
  );
  expect(confirms).toHaveLength(2);
  expect(confirms[0]!.headers()['idempotency-key']).toBe(confirms[1]!.headers()['idempotency-key']);
  expect(confirms[0]!.postData()).toBe(confirms[1]!.postData());
  const body = confirms[1]!.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({
    expectedRevision: 'rev-2',
    lines: [{ productId, observedQuantity: 2 }],
    eventCoverage: [{ eventId, included: true }],
    reshareCoverage: [{ reshareOrderLineId: reshareLineId, quantity: 2 }],
  });
  // The client never sends derived numbers.
  expect(JSON.stringify(body)).not.toMatch(/freeQuantity|onHand|reserved/u);
  await expectNoPageOverflow(page);
});

test('RE deducted bags stay editable while clearing and saving partial coverage', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page
    .getByRole('row')
    .filter({ hasText: productName })
    .first()
    .getByRole('button', { name: 'Đối chiếu' })
    .click();
  await page.getByLabel(totalLabel).fill('26');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await page.getByLabel('Đã gồm trong số vừa nhập').check();
  const selected = page.getByLabel('Đã trừ trong số vừa nhập');
  const quantity = page.getByLabel('Số bao của RE-000001 đã trừ trong số tồn');
  const save = page.getByRole('button', { name: 'Lưu cập nhật tồn' });
  await selected.check();
  await expect(quantity).toHaveValue('2');
  await quantity.fill('');
  await expect(quantity).toBeVisible();
  await expect(selected).toBeChecked();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(page.getByRole('alert').first()).toContainText('RE-000001');
  expect(log.mutations.filter((r) => r.url().endsWith('/preview'))).toHaveLength(1);
  for (const invalid of ['0', '3', '1.5']) {
    await quantity.fill(invalid);
    await page.getByRole('button', { name: 'Xem trước lại' }).click();
    await expect(save).toBeDisabled();
    expect(log.mutations.filter((r) => r.url().endsWith('/preview'))).toHaveLength(1);
  }
  await selected.uncheck();
  await expect(quantity).toHaveCount(0);
  await selected.check();
  await quantity.fill('1');
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  const saved = log.mutations.find((r) => r.url().endsWith('/supplier-stock-observations'))!;
  expect(saved.postDataJSON()).toMatchObject({
    lines: [{ productId, observedQuantity: 26 }],
    reshareCoverage: [{ reshareOrderLineId: reshareLineId, quantity: 1 }],
  });
});

test('legacy attestation and changed totals require a fresh preview before saving', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN', 2);
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page
    .getByRole('row')
    .filter({ hasText: productName })
    .first()
    .getByRole('button', { name: 'Đối chiếu' })
    .click();
  const total = page.getByLabel(totalLabel);
  await total.fill('7');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await page.getByLabel('Đã gồm trong số vừa nhập').check();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  const save = page.getByRole('button', { name: 'Lưu cập nhật tồn' });
  await expect(save).toBeDisabled();
  await expect(page.locator('.supplier-save-help')).toContainText('Xác nhận các lượng giữ cũ');
  await total.fill('26');
  await page.getByLabel('Tôi xác nhận các lượng giữ trước').check();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(save).toBeEnabled();
  // Editing again must never save an obsolete preview, including clearing a RE checkbox.
  await page.getByLabel('Đã trừ trong số vừa nhập').check();
  await expect(save).toBeDisabled();
  await page.getByLabel('Đã trừ trong số vừa nhập').uncheck();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  const saved = log.mutations.find((r) => r.url().endsWith('/supplier-stock-observations'))!;
  expect(saved.postDataJSON()).toMatchObject({
    lines: [{ productId, observedQuantity: 26 }],
    attestUnlinkedAsNotOrdered: true,
    reshareCoverage: [],
  });
});

test('RE quantity has usable dimensions and preview is next to save at responsive widths', async ({
  page,
}, testInfo) => {
  await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page
    .getByRole('row')
    .filter({ hasText: productName })
    .first()
    .getByRole('button', { name: 'Đối chiếu' })
    .click();
  await page.getByLabel(totalLabel).fill('26');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await page.getByLabel('Đã trừ trong số vừa nhập').check();
  const quantity = page.getByLabel('Số bao của RE-000001 đã trừ trong số tồn');
  for (const width of [360, 390, 412, 768, 1366, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await quantity.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(100);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
    await expect(
      page
        .locator('.supplier-preview .supplier-actions')
        .getByRole('button', { name: 'Xem trước lại' }),
    ).toBeVisible();
    if (width === 390 || width === 1440) {
      await page.screenshot({
        path: testInfo.outputPath(`reshare-input-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  await page.getByLabel('Đã gồm trong số vừa nhập').check();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(page.getByRole('button', { name: 'Lưu cập nhật tồn' })).toBeEnabled();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: testInfo.outputPath(`reshare-save-enabled-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});

test('HTKD opens every Reshare tab by deep link; manual records stay as old data', async ({
  page,
}) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/supplier-reconciliation?tab=settings');
  await expect(page.getByRole('tab', { name: 'Cấu hình nguồn' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goto('/supplier-reconciliation?tab=history');
  await expect(page.getByRole('tab', { name: 'Lịch sử cập nhật tồn' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await expect(page.getByRole('row').filter({ hasText: productName }).first()).toBeVisible();
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' })).toBeVisible();
  await expect(page.getByLabel('Mã đơn Reshare')).toHaveCount(0);
  await page.getByRole('button', { name: 'Xem đơn ghi nhận thủ công' }).click();
  await expect(
    page.getByRole('heading', { name: 'Hàng giữ trước khi có đơn RE (ghi nhận thủ công)' }),
  ).toBeVisible();
  await expect(page.getByText('Chỉ gồm cửa hàng của tài khoản')).toHaveCount(0);
  await page.getByLabel(`Chọn ${productName} của Cửa hàng Gò Vấp`).check();
  await expect(
    page.getByLabel(`Số bao Reshare đã nhận cho ${productName} của Cửa hàng Gò Vấp`),
  ).toHaveValue('2');
  await page.getByLabel('Mã đơn Reshare').fill('RS-2002');
  await page.getByRole('button', { name: 'Ghi nhận đơn Reshare' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Đã ghi nhận đơn Reshare' }),
  ).toContainText('Khả dụng không đổi');
  const posted = log.mutations.find((request) => request.url().endsWith('/supplier-orders'))!;
  expect(posted.headers()['idempotency-key']).toBeTruthy();
  expect(posted.postDataJSON()).toMatchObject({
    externalRef: 'RS-2002',
    lines: [{ reservationId, quantity: 2, externalLineRef: 'NAM-01' }],
  });
  await expectNoPageOverflow(page);
});

test('stores read their RE orders without any action', async ({ page }) => {
  const log = await mockApi(page, 'STORE');
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ghi nhận đơn Reshare' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Xem đơn ghi nhận thủ công' })).toHaveCount(0);
  expect(log.mutations).toHaveLength(0);
});

for (const width of [360, 390, 412, 683, 768, 821, 911, 1093, 1366, 1440, 1920, 2560]) {
  // 683, 911 and 1093 px are a 1366 px screen at 200/150/125% browser zoom.
  test(`reconciliation layout fits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page, 'ADMIN');
    await page.goto('/supplier-reconciliation?tab=reconcile');
    const row = page.getByRole('row').filter({ hasText: productName }).first();
    await row.getByRole('button', { name: 'Xem giữ hàng' }).click();
    await row.getByRole('button', { name: 'Đối chiếu' }).click();
    await expect(page.getByLabel(totalLabel)).toBeVisible();
    await page.getByLabel(totalLabel).fill('2');
    await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeVisible();
    await expect(page.getByText('Số tồn này đã trừ các đơn RE nào?')).toBeVisible();
    await expectNoPageOverflow(page);
    if (width === 390 || width === 1440) {
      await page.screenshot({
        path: testInfo.outputPath(`supplier-reconciliation-${width}.png`),
        fullPage: true,
      });
    }
    for (const button of await page.getByRole('button').all()) {
      if (!(await button.isVisible())) continue;
      const fits = await button.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1 && element.clientHeight >= 32,
      );
      expect(fits, await button.innerText()).toBe(true);
    }
  });
}

for (const role of ['ADMIN', 'HTKD', 'STORE'] as const) {
  test(`RE order history fits from 360 to 2560px for ${role}`, async ({ page }, testInfo) => {
    await mockApi(page, role);
    await page.goto('/supplier-reconciliation');
    await expect(
      page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' }),
    ).toBeVisible();
    for (const width of [360, 390, 412, 683, 768, 1366, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoPageOverflow(page);
      // The same table everywhere: narrow screens lay each order out as one card (lines inside,
      // total once), wide ones as grouped rows.
      const table = page.locator('.reshare-history table');
      await expect(table).toBeVisible();
      const display = await table.evaluate((element) => getComputedStyle(element).display);
      expect(display === 'table').toBe(width > 620);
      const group = table.locator('tbody').first();
      await expect(group).toContainText('RE-000001');
      await expect(group.locator('.reshare-history__total')).toHaveText('5');
      const box = await group.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      // Read a single DOM snapshot: responsive shell buttons can mount/unmount between awaits.
      const buttonSizes = await page.getByRole('button').evaluateAll((buttons) =>
        buttons
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({
            label: element.textContent ?? '',
            fits: element.scrollWidth <= element.clientWidth + 1 && element.clientHeight >= 32,
          })),
      );
      for (const button of buttonSizes) expect(button.fits, button.label).toBe(true);
      if (role === 'ADMIN' && (width === 390 || width === 1440)) {
        await page.screenshot({
          path: testInfo.outputPath(`reshare-orders-${width}.png`),
          fullPage: true,
        });
      }
    }
  });
}

test('Reshare readability: type scale, metric tiles, touch targets and no SKU next to names', async ({
  page,
}, testInfo) => {
  await mockApi(page, 'HTKD');
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page
    .getByRole('row')
    .filter({ hasText: productName })
    .first()
    .getByRole('button', { name: 'Đối chiếu' })
    .click();
  await page.getByLabel(totalLabel).fill('2');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await page.getByLabel('Đã trừ trong số vừa nhập').check();
  for (const width of [360, 390, 412, 768, 820, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectNoPageOverflow(page);
    const metrics = await page.evaluate(() => {
      const px = (element: Element | null) =>
        element ? parseFloat(getComputedStyle(element).fontSize) : 0;
      const weight = (element: Element | null) =>
        element ? Number(getComputedStyle(element).fontWeight) : 0;
      const figures = Array.from(document.querySelectorAll('.supplier-figures > div'));
      return {
        heading: px(document.querySelector('.supplier-observation h2')),
        headingWeight: weight(document.querySelector('.supplier-observation h2')),
        productHeading: px(document.querySelector('.supplier-preview__line h3')),
        productHeadingText: document.querySelector('.supplier-preview__line h3')?.textContent,
        tableName: document.querySelector('.supplier-observation-table .supplier-product-name')
          ?.textContent,
        input: px(document.querySelector('.supplier-observation-table input')),
        hint: px(document.querySelector('.supplier-observation .supplier-hint')),
        labels: figures.map((figure) => ({
          text: figure.querySelector('dt')?.textContent,
          size: px(figure.querySelector('dt')),
          weight: weight(figure.querySelector('dt')),
          value: px(figure.querySelector('dd')),
          valueWeight: weight(figure.querySelector('dd')),
          numeric: getComputedStyle(figure.querySelector('dd')!).fontVariantNumeric,
          right: figure.getBoundingClientRect().right,
        })),
        after: px(document.querySelector('.supplier-figure__after')),
        before: px(document.querySelector('.supplier-figure__before')),
        checkboxTarget: document
          .querySelector('.supplier-coverage__choice label')!
          .getBoundingClientRect().height,
        actionButtons: Array.from(
          document.querySelectorAll('.supplier-preview .supplier-actions .button'),
        ).map((button) => button.getBoundingClientRect().height),
        observationTableWidth: document
          .querySelector('.supplier-observation-table')!
          .getBoundingClientRect().width,
        panelWidth: document.querySelector('.supplier-observation')!.getBoundingClientRect().width,
      };
    });
    expect(metrics.heading).toBeGreaterThanOrEqual(20);
    expect(metrics.heading).toBeLessThanOrEqual(22);
    expect(metrics.headingWeight).toBeGreaterThanOrEqual(700);
    expect(metrics.productHeading).toBeGreaterThanOrEqual(18);
    expect(metrics.productHeading).toBeLessThanOrEqual(20);
    expect(metrics.productHeadingText).toBe(productName);
    expect(metrics.tableName).toBe(productName);
    expect(metrics.input).toBeGreaterThanOrEqual(16);
    expect(metrics.hint).toBeGreaterThanOrEqual(14);
    expect(metrics.labels.map((label) => label.text)).toEqual([
      'Reshare cho đặt (S)',
      'Biến động sau lúc xem',
      'Giữ ưu tiên chưa đặt',
      'Đã cấp, đang giữ chưa đặt',
      'Đơn RE số tồn chưa trừ',
      'Khả dụng hiện tại → sau',
      'Thiếu nguồn',
    ]);
    for (const label of metrics.labels) {
      expect(label.size).toBeGreaterThanOrEqual(14);
      expect(label.size).toBeLessThanOrEqual(16);
      expect(label.weight).toBeGreaterThanOrEqual(600);
      expect(label.value).toBeGreaterThanOrEqual(22);
      expect(label.value).toBeLessThanOrEqual(26);
      expect(label.valueWeight).toBeGreaterThanOrEqual(700);
      expect(label.numeric).toContain('tabular-nums');
      expect(label.right).toBeLessThanOrEqual(width + 1);
    }
    expect(metrics.after).toBeGreaterThan(metrics.before);
    expect(metrics.checkboxTarget).toBeGreaterThanOrEqual(44);
    for (const height of metrics.actionButtons) expect(height).toBeGreaterThanOrEqual(44);
    // The observation table uses the panel width instead of a small island.
    expect(metrics.observationTableWidth).toBeGreaterThanOrEqual(metrics.panelWidth * 0.85);
    if (width === 390 || width === 1440) {
      await page.screenshot({
        path: testInfo.outputPath(`reshare-readability-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
});

test('table headings and mobile card labels are sentence case and bold', async ({ page }) => {
  await mockApi(page, 'ADMIN');
  for (const [tab, width] of [
    ['', 1440],
    ['', 390],
    ['?tab=reconcile', 1440],
    ['?tab=reconcile', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/supplier-reconciliation${tab}`);
    await expect(page.locator('table').first()).toBeVisible();
    const headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.app-main thead th, .app-main td[data-label]'))
        .filter((cell) => cell.getBoundingClientRect().width > 0)
        .map((cell) => {
          const header = cell.tagName === 'TH';
          const style = getComputedStyle(cell, header ? null : '::before');
          return {
            text: header ? cell.textContent : cell.getAttribute('data-label'),
            shown: header || (style.content !== 'none' && style.display !== 'none'),
            weight: Number(style.fontWeight),
            transform: style.textTransform,
          };
        })
        .filter((cell) => cell.shown),
    );
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading.weight, heading.text ?? '').toBeGreaterThanOrEqual(700);
      expect(heading.transform, heading.text ?? '').toBe('none');
    }
    const texts = headings.map((heading) => heading.text);
    if (tab === '' && width === 1440) {
      expect(texts).toContain('Tổng số lượng (bao)');
      expect(texts).toContain('Mã đặt hàng Reshare');
    }
  }
});

test('long list reveals the clicked reconciliation target before any form interaction', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'ADMIN', 0, true);
  await page.goto('/supplier-reconciliation?tab=reconcile');
  const row = page.locator('.supplier-summary tbody tr').filter({ hasText: 'Mặt hàng 20' });
  const trigger = row.getByRole('button', { name: 'Đối chiếu', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  await page.screenshot({ path: testInfo.outputPath('before-click.png') });
  await trigger.click();
  const heading = page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' });
  await testInfo.attach('navigation-dom', {
    body: JSON.stringify(
      await page.evaluate(() => ({
        url: location.href,
        scrollY,
        activeElement: document.activeElement?.outerHTML,
        heading: document
          .querySelector('.supplier-observation h2')
          ?.getBoundingClientRect()
          .toJSON(),
        scrollOwner: document.scrollingElement?.tagName,
      })),
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('after-click.png') });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  await expect(page.locator('.supplier-observation tbody tr')).toHaveCount(1);
  await expect(page.locator('.supplier-observation')).toContainText('Mặt hàng 20');
  await expect(
    page.getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 20', { exact: true }),
  ).toBeInViewport();
  expect(log.mutations).toHaveLength(0);
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toBeInViewport();
});

test('row target ignores selection; same target preserves draft; switching requires discard and clears preview', async ({
  page,
}) => {
  const log = await mockApi(page, 'HTKD', 0, true);
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page.getByLabel('Chọn Mặt hàng 1 để đối chiếu', { exact: true }).check();
  const open = (n: number) =>
    page
      .locator('.supplier-summary tbody tr')
      .filter({ has: page.getByText(`Mặt hàng ${n}`, { exact: true }) })
      .getByRole('button', { name: 'Đối chiếu', exact: true });
  await open(20).click();
  const input = page.getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 20', {
    exact: true,
  });
  await expect(page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' })).toBeInViewport();
  await expect(page.locator('.supplier-observation tbody tr')).toHaveCount(1);
  await input.fill('8');
  await open(20).click();
  await expect(input).toHaveValue('8');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeInViewport();
  await open(20).click();
  await expect(input).toHaveValue('8');
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.dismiss());
  await open(19).click();
  await expect(input).toHaveValue('8');
  await expect(page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' })).toBeInViewport();
  page.once('dialog', (dialog) => dialog.accept());
  await open(19).click();
  await expect(page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' })).toBeInViewport();
  await expect(
    page.getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 19', { exact: true }),
  ).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(open(19)).toBeFocused();
  await page.getByLabel('Chọn Mặt hàng 2 để đối chiếu', { exact: true }).check();
  await page.getByRole('button', { name: 'Đối chiếu 2 mặt hàng', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' })).toBeInViewport();
  await expect(page.locator('.supplier-observation tbody tr')).toHaveCount(2);
  await expect(page.locator('.supplier-observation')).toContainText('Mặt hàng 1');
  await expect(page.locator('.supplier-observation')).toContainText('Mặt hàng 2');
  expect(log.mutations.filter((request) => request.url().endsWith('/preview'))).toHaveLength(1);
  expect(log.mutations.filter((request) => !request.url().endsWith('/preview'))).toHaveLength(0);
});

test('delayed preview cannot reveal a replaced target or steal focus from another input', async ({
  page,
}) => {
  await mockApi(page, 'ADMIN', 0, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route('**/supplier-stock-observations/preview', async (route) => {
    arrived();
    await gate;
    await route.fulfill({ json: { data: preview(false) } }).catch(() => undefined);
  });
  await page.goto('/supplier-reconciliation?tab=reconcile');
  const open = (n: number) =>
    page
      .locator('.supplier-summary tbody tr')
      .filter({ has: page.getByText(`Mặt hàng ${n}`, { exact: true }) })
      .getByRole('button', { name: 'Đối chiếu', exact: true });
  await open(1).click();
  await page
    .getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 1', { exact: true })
    .fill('3');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await requestArrived;
  page.once('dialog', (dialog) => dialog.accept());
  await open(2).click();
  const heading = page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' });
  await expect(heading).toBeFocused();
  release();
  await expect(
    page.getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 2', { exact: true }),
  ).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toHaveCount(0);
  await expect(heading).toBeFocused();
});

for (const [width, height] of [
  [1366, 768],
  [1920, 1080],
  [2560, 1440],
  [768, 1024],
  [1024, 768],
  [360, 800],
  [412, 915],
  [819, 900],
  [820, 900],
  [821, 900],
]) {
  test(`long-list destination geometry ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await mockApi(page, 'ADMIN', 0, true);
    await page.goto('/supplier-reconciliation?tab=reconcile');
    const trigger = page
      .locator('.supplier-summary tbody tr')
      .filter({ has: page.getByText('Mặt hàng 20', { exact: true }) })
      .getByRole('button', { name: 'Đối chiếu', exact: true });
    await trigger.click();
    const heading = page.getByRole('heading', { name: 'Cập nhật tổng tồn Reshare' });
    await expect(heading).toBeInViewport();
    await expect(heading).toBeFocused();
    const box = await heading.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(width! <= 820 ? 60 : 0);
    await expectNoPageOverflow(page);
  });
}

test('multiple sources cannot open a group; preview payload uses the clicked source and product', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN', 0, true);
  await page.route('**/api/v1/supplier-reconciliation?*', (route) =>
    route.fulfill({
      json: {
        data: [
          { ...summaryRow, productName: 'Mặt hàng 1' },
          {
            ...summaryRow,
            productId: id(502),
            productName: 'Mặt hàng 2',
            sourceId: id(402),
            sourceCode: 'SECOND',
          },
        ],
        pagination: page1(2),
        revision: 'rev-1',
        generatedAt: time,
      },
    }),
  );
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page.getByLabel('Chọn Mặt hàng 1 để đối chiếu', { exact: true }).check();
  await page.getByLabel('Chọn Mặt hàng 2 để đối chiếu', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Đối chiếu 2 mặt hàng' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('thuộc nhiều nguồn');
  const row = page.locator('.supplier-summary tbody tr').filter({ hasText: 'Mặt hàng 2' });
  await row.getByRole('button', { name: 'Đối chiếu', exact: true }).click();
  await page
    .getByLabel('Tổng số bao Reshare đang cho đặt của Mặt hàng 2', { exact: true })
    .fill('5');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeInViewport();
  const writes = log.mutations.filter((r) => r.url().endsWith('/preview'));
  expect(writes).toHaveLength(1);
  expect(writes[0]!.postDataJSON()).toMatchObject({
    sourceId: id(402),
    lines: [{ productId: id(502), observedQuantity: 5 }],
  });
});

test('preview response respects focus moved to the list and invalid quantity points to its field', async ({
  page,
}) => {
  await mockApi(page, 'ADMIN');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/supplier-stock-observations/preview', async (route) => {
    await gate;
    await route.fulfill({ json: { data: preview(false) } });
  });
  await page.goto('/supplier-reconciliation?tab=reconcile');
  await page
    .locator('.supplier-summary tbody')
    .getByRole('button', { name: 'Đối chiếu', exact: true })
    .click();
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.getByLabel(totalLabel)).toBeFocused();
  await expect(page.getByLabel(totalLabel)).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel(totalLabel).fill('3');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  const search = page.getByLabel('Tìm mặt hàng', { exact: true });
  await search.fill('đang nhập');
  const scroll = await page.evaluate(() => scrollY);
  release();
  await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeAttached();
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(scroll, -1);
});

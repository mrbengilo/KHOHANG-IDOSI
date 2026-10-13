import { expect, test, type Page, type Request } from '@playwright/test';

import { layoutAdminSession } from './layout-fixtures';

/*
 * Đơn đặt và tồn Reshare trên production bundle với API giả lập theo đúng contract: mọi vai trò
 * mở vào "Đơn đặt Reshare" (lịch sử RE nhóm theo đơn, lọc phía server), Admin cập nhật tồn (xem
 * trước, coverage biến động và đơn RE, lưu, giữ Idempotency-Key khi gửi lại), đơn ghi nhận thủ
 * công chỉ còn ở mục dữ liệu cũ, và bố cục không tràn ở các bề rộng đại diện.
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

const summaryRow = {
  productId,
  sku: 'NAM-01',
  productName: 'Bao đồ nam tuyển chọn — tên dài để kiểm tra xuống dòng trong bảng đối chiếu',
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
  failNextConfirm: boolean;
  failNextStatus?: boolean;
}

async function mockApi(page: Page, role: Role): Promise<Log> {
  const log: Log = { mutations: [], orderQueries: [], failNextConfirm: false };
  let previews = 0;
  const historyRows = reshareRows.map((row) => ({
    ...structuredClone(row),
    statusControl: {
      version: 0,
      updatedAt: null as string | null,
      updatedByName: null as string | null,
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
    if (/^\/reshare-orders\/.+\/status$/u.test(path)) {
      const key = request.headers()['idempotency-key']!;
      if (savedStatus.has(key)) return json({ data: savedStatus.get(key) });
      const row = historyRows.find((row) => path.includes(row.decisionId))!;
      const input = request.postDataJSON();
      row.status = input.status;
      row.statusControl = {
        version: row.statusControl.version + 1,
        updatedAt: time,
        updatedByName: 'Quản trị viên',
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
      return json({ data: rows, pagination: page1(rows.length), scoped: role !== 'ADMIN' });
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
        data: [summaryRow],
        pagination: page1(1),
        revision: 'rev-1',
        generatedAt: time,
      });
    if (path === '/supplier-commitments')
      return json({
        data: [commitment],
        pagination: page1(1),
        totals: { quantity: 3, orderedQuantity: 1, unorderedQuantity: 2 },
        scoped: role !== 'ADMIN',
      });
    if (path === '/supplier-orders' && request.method() === 'GET')
      return json({ data: [], pagination: { ...page1(0), pageSize: 10 } });
    if (path === '/supplier-stock-observations/preview') {
      previews += 1;
      const body = request.postDataJSON() as { eventCoverage: { eventId: string }[] };
      return json({ data: preview(body.eventCoverage.length > 0 || previews > 2) });
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

for (const role of ['HTKD', 'STORE'] as const) {
  test(`${role} sees the acknowledgement with no edit controls`, async ({ page }) => {
    await mockApi(page, role);
    await page.goto('/supplier-reconciliation');
    await expect(page.locator('.reshare-history')).toBeVisible();
    await expect(page.getByRole('button', { name: /Đánh dấu (chưa đặt|đã đặt)/u })).toHaveCount(0);
  });
}

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
  const row = page.getByRole('row').filter({ hasText: 'NAM-01' }).first();
  await expect(row).toContainText('Đã đối chiếu');

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
  await page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01').fill('2');
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
    'NAM-01: khả dụng giữ nguyên 0 bao.',
  );
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

test('HTKD sees its orders; manual Reshare records are only kept as old data', async ({ page }) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/supplier-reconciliation?tab=settings');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Lịch sử đặt hàng theo phân bổ' })).toBeVisible();
  await expect(page.getByLabel('Mã đơn Reshare')).toHaveCount(0);
  await page.getByRole('button', { name: 'Xem đơn ghi nhận thủ công' }).click();
  await expect(
    page.getByRole('heading', { name: 'Hàng giữ trước khi có đơn RE (ghi nhận thủ công)' }),
  ).toBeVisible();
  await expect(page.getByText('Chỉ gồm cửa hàng thuộc phạm vi tài khoản')).toBeVisible();
  await page.getByLabel('Chọn NAM-01 của CH-GOVAP').check();
  await expect(page.getByLabel('Số bao Reshare đã nhận cho NAM-01 của CH-GOVAP')).toHaveValue('2');
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
    const row = page.getByRole('row').filter({ hasText: 'NAM-01' }).first();
    await row.getByRole('button', { name: 'Xem giữ hàng' }).click();
    await row.getByRole('button', { name: 'Đối chiếu' }).click();
    await expect(page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01')).toBeVisible();
    await page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01').fill('2');
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
      const buttonSizes = await page
        .getByRole('button')
        .evaluateAll((buttons) =>
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

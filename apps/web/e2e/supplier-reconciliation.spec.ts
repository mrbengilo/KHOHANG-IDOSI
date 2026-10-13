import { expect, test, type Page, type Request } from '@playwright/test';

import { layoutAdminSession } from './layout-fixtures';

/*
 * Đối chiếu tồn Reshare trên production bundle với API giả lập theo đúng contract: luồng Admin
 * (xem, chi tiết, xem trước, xác nhận coverage, lưu), giữ Idempotency-Key khi gửi lại, HTKD chỉ
 * thấy hàng chờ đặt, và bố cục không tràn ở các bề rộng đại diện.
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
  failNextConfirm: boolean;
}

async function mockApi(page: Page, role: Role): Promise<Log> {
  const log: Log = { mutations: [], failNextConfirm: false };
  let previews = 0;
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

test('Admin reconciles the AC01 case: re-observing 3 bags frees nothing and keeps the key on retry', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('heading', { name: 'Đối chiếu tồn Reshare' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Đối chiếu tồn' })).toHaveAttribute(
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
  await page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01').fill('2');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  const save = page.getByRole('button', { name: 'Lưu đối chiếu' });
  await expect(page.getByText('Còn 1 biến động chưa trả lời')).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel('Đã gồm trong số vừa nhập').check();
  await expect(page.getByText(/Bấm “Xem trước lại”/u)).toBeVisible();
  await page.getByRole('button', { name: 'Xem trước lại' }).click();
  await expect(save).toBeEnabled();

  // The first confirmation loses its response; the retry must reuse the same key and payload.
  log.failNextConfirm = true;
  await save.click();
  await expect(page.getByRole('alert')).toContainText('cùng thao tác sẽ không bị ghi hai lần');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu đối chiếu' })).toContainText(
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
  });
  // The client never sends derived numbers.
  expect(JSON.stringify(body)).not.toMatch(/freeQuantity|onHand|reserved/u);
  await expectNoPageOverflow(page);
});

test('HTKD only records Reshare orders for its stores', async ({ page }) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/supplier-reconciliation?tab=settings');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Chờ đặt Reshare' })).toBeVisible();
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

test('stores read their Reshare order state without any action', async ({ page }) => {
  const log = await mockApi(page, 'STORE');
  await page.goto('/supplier-reconciliation');
  await expect(page.getByRole('heading', { name: 'Hàng đang giữ cho cửa hàng' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ghi nhận đơn Reshare' })).toHaveCount(0);
  expect(log.mutations).toHaveLength(0);
});

for (const width of [360, 390, 412, 683, 768, 911, 1093, 1366, 1440, 1920, 2560]) {
  // 683, 911 and 1093 px are a 1366 px screen at 200/150/125% browser zoom.
  test(`reconciliation layout fits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page, 'ADMIN');
    await page.goto('/supplier-reconciliation');
    const row = page.getByRole('row').filter({ hasText: 'NAM-01' }).first();
    await row.getByRole('button', { name: 'Xem giữ hàng' }).click();
    await row.getByRole('button', { name: 'Đối chiếu' }).click();
    await expect(page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01')).toBeVisible();
    await page.getByLabel('Tổng số bao Reshare đang cho đặt của NAM-01').fill('2');
    await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Xem trước đối chiếu' })).toBeVisible();
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

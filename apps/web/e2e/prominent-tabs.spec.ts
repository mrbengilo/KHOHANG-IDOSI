import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { withBrowserZoom } from './browser-zoom';
import { layoutAdminSession, mockLayoutData } from './layout-fixtures';

/*
 * Thanh tab nổi bật: Phân bổ hàng hóa (Admin/HTKD) và Tồn kho (mọi vai trò) dùng nhãn to hơn, in
 * đậm cả tab chưa chọn. Đo bằng computed style và DOMRect trên production bundle với API fixture;
 * cửa hàng ở trang phân bổ phải giữ thanh tab cũ.
 */

type Role = 'ADMIN' | 'HTKD' | 'STORE' | 'WHOLESALE';
type Level = 'primary' | 'secondary';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-02T03:00:00.000Z';
const storeIds = [id(31), id(32)];
const emptyPage = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };

const ALLOCATION_LABELS = [
  'Phiên và kết quả',
  'Lịch sử đặt hàng',
  'Danh sách phiếu chờ',
  'Tạo phiên mới',
];
const INVENTORY_LABELS = ['Kho tổng', 'Kho cửa hàng', 'Phiếu sai lệch'];
const WAREHOUSE_LABELS = ['Tồn hiện tại', 'Kiểm hàng thiếu', 'Lịch sử xuất', 'Lịch sử điều chỉnh'];
const STORE_LABELS = ['Tồn cửa hàng', 'Sổ phát sinh'];

const bar = (page: Page, label: string) => page.getByRole('tablist', { name: label, exact: true });
const allocationBar = (page: Page) => bar(page, 'Nội dung phân bổ hàng hóa');
const inventoryBar = (page: Page) => bar(page, 'Phạm vi tồn kho');
const warehouseBar = (page: Page) => bar(page, 'Nội dung kho tổng');
const storeBar = (page: Page) => bar(page, 'Nội dung kho cửa hàng');

function sessionFor(role: Role) {
  const session = layoutAdminSession('Kiểm thử thanh tab');
  if (role === 'ADMIN') return session;
  return {
    ...session,
    principal: {
      ...session.principal,
      role,
      username: `tabs.${role.toLowerCase()}`,
      assignedStoreIds: role === 'HTKD' ? [storeIds[0]] : [],
      storeId: role === 'STORE' ? storeIds[0] : null,
    },
  };
}

const stores = storeIds.map((storeId, index) => ({
  id: storeId,
  code: `TAB-${index + 1}`,
  name: `Cửa hàng kiểm thử tab ${index + 1}`,
  groupId: id(40),
  kind: 'RETAIL',
  status: 'ACTIVE',
  address: null,
  version: 0,
  createdAt: time,
  updatedAt: time,
}));

const shortageCheck = {
  id: id(50),
  storeReceiptId: id(51),
  receiptNumber: 'PN-TAB-0001',
  storeId: storeIds[0],
  productId: id(10),
  quantity: 2,
  status: 'PENDING',
  shortageReason: 'Thiếu khi nhận',
  resolutionReason: null,
  resolvedByAccountId: null,
  resolvedAt: null,
  version: 0,
  createdAt: time,
};

// Paginated lists the covered tabs read; a test can override a path to simulate a state.
const LIST_PATHS = [
  '/order-sessions',
  '/order-requests',
  '/wait-tickets',
  '/priority-offers',
  '/session-documents',
  '/order-history',
  '/warehouse-shortage-checks',
  '/outbound-requests',
  '/warehouse-adjustments',
  '/receipt-adjustments',
  '/store-inventory-bags',
  // Store and wholesale shells poll results awaiting their acceptance.
  '/allocation-decisions',
];

interface ApiLog {
  readonly requests: string[];
  readonly unexpected: string[];
  readonly mutations: string[];
}

/**
 * Answers only the endpoints these screens read, with schema-shaped payloads. Anything else gets
 * a 404 and is recorded, so a wrong request cannot hide behind a blanket success response.
 */
async function mockApi(page: Page, role: Role, options: { shortage?: boolean } = {}) {
  const log: ApiLog = { requests: [], unexpected: [], mutations: [] };
  await page.route('**/api/v1/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    log.requests.push(`${request.method()} ${path}`);
    if (request.method() !== 'GET') {
      log.mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { message: 'Mutation not allowed in tab test' } });
    }
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === '/auth/session') return json({ data: sessionFor(role) });
    if (path === '/stores')
      return json({ data: stores, pagination: { ...emptyPage, pageSize: 100, totalItems: 2 } });
    if (path === '/admin/worker-status')
      return json({
        data: {
          worker: 'allocation',
          status: 'HEALTHY',
          lastTickStartedAt: time,
          lastTickCompletedAt: time,
          lastSuccessfulTickAt: time,
          lastError: null,
          failingJobs: [],
          updatedAt: time,
        },
      });
    if (path === '/admin/operational-settings')
      return json({
        data: {
          current: {
            id: id(60),
            version: 1,
            timezone: 'Asia/Ho_Chi_Minh',
            snapshotTime: '08:00',
            cutoffTime: '09:00',
            maxRequestsPerStore: 2,
            policyVersion: 'P0A-P3-v1',
            idosiSyncIntervalMinutes: 15,
            vatRatePercent: 0,
            createdByAccountId: null,
            requestId: 'tabs-fixture',
            createdAt: time,
          },
          history: [],
          integration: { endpoint: 'https://example.invalid/idosi', status: 'NOT_CONFIGURED' },
        },
      });
    if (path === '/held-allocations' || path === '/store-sorted-stocks') return json({ data: [] });
    if (path === '/warehouse-shortage-checks' && options.shortage)
      return json({ data: [shortageCheck], pagination: { ...emptyPage, totalItems: 1 } });
    if (LIST_PATHS.includes(path)) return json({ data: [], pagination: emptyPage });
    log.unexpected.push(`${request.method()} ${path}${url.search}`);
    return route.fulfill({ status: 404, json: { message: 'Not mocked by prominent-tabs' } });
  });
  // Products, warehouse stock and inbound receipts come from the shared layout fixture.
  await mockLayoutData(page);
  return log;
}

interface TabMetrics {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly tabIndex: number;
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly lineHeight: number;
  readonly padding: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly clipped: boolean;
}

async function measureBar(locator: Locator) {
  return locator.evaluate((list) => {
    const box = list.getBoundingClientRect();
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
      const style = getComputedStyle(tab);
      const rect = tab.getBoundingClientRect();
      const px = (value: string) => Number.parseFloat(value);
      return {
        id: tab.id,
        label: tab.textContent ?? '',
        selected: tab.getAttribute('aria-selected') === 'true',
        tabIndex: tab.tabIndex,
        fontSize: px(style.fontSize),
        fontWeight: style.fontWeight,
        lineHeight: px(style.lineHeight),
        padding: [
          px(style.paddingTop),
          px(style.paddingRight),
          px(style.paddingBottom),
          px(style.paddingLeft),
        ] as const,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        // Text wider than its button means the label is cut or ellipsized.
        clipped: tab.scrollWidth > tab.clientWidth + 1,
      };
    });
    return {
      className: list.className,
      left: box.left,
      right: box.right,
      scrollWidth: list.scrollWidth,
      clientWidth: list.clientWidth,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      overflowX: getComputedStyle(list).overflowX,
      tabs: tabs as TabMetrics[],
    };
  });
}

type BarMetrics = Awaited<ReturnType<typeof measureBar>>;

/** Design targets of the prominent bar; at most 620px both levels share the compact size. */
function target(level: Level, viewportWidth: number) {
  if (viewportWidth <= 620) return { fontSize: 16, minHeight: 48, padding: [10, 14] };
  return level === 'primary'
    ? { fontSize: 18, minHeight: 56, padding: [12, 20] }
    : { fontSize: 16, minHeight: 48, padding: [10, 16] };
}

function expectProminent(
  metrics: BarMetrics,
  level: Level,
  labels: readonly string[],
  viewportWidth: number,
) {
  const expected = target(level, viewportWidth);
  expect(metrics.className).toContain('tabs--prominent');
  expect(metrics.tabs.map((tab) => tab.label)).toEqual(labels);
  expect(metrics.tabs.filter((tab) => tab.selected)).toHaveLength(1);
  for (const tab of metrics.tabs) {
    const where = `${tab.id} @${viewportWidth}`;
    expect(tab.fontSize, where).toBe(expected.fontSize);
    expect(tab.fontWeight, where).toBe('700');
    expect(tab.lineHeight / tab.fontSize, where).toBeCloseTo(1.4, 1);
    expect(tab.padding, where).toEqual([
      expected.padding[0],
      expected.padding[1],
      expected.padding[0],
      expected.padding[1],
    ]);
    expect(Math.abs(tab.height - expected.minHeight), where).toBeLessThanOrEqual(0.5);
    // Width follows the label: content plus both side paddings, never squeezed.
    expect(tab.width, where).toBeGreaterThan(2 * expected.padding[1]);
    expect(tab.clipped, where).toBe(false);
    expect(tab.tabIndex, where).toBe(tab.selected ? 0 : -1);
  }
  for (let index = 1; index < metrics.tabs.length; index += 1)
    expect(metrics.tabs[index]!.left).toBeGreaterThanOrEqual(metrics.tabs[index - 1]!.right - 0.5);
  // One row: no vertical scrollbar inside the bar from line-height or the underline.
  expect(metrics.scrollHeight, 'tab bar vertical overflow').toBeLessThanOrEqual(
    metrics.clientHeight,
  );
  expect(metrics.overflowX).toBe('auto');
}

function expectDefault(metrics: BarMetrics, level: Level) {
  expect(metrics.className).not.toContain('tabs--prominent');
  for (const tab of metrics.tabs) {
    expect(tab.fontSize).toBe(level === 'primary' ? 15 : 14);
    expect(tab.fontWeight).toBe(tab.selected ? '700' : '400');
  }
}

async function expectDocumentContained(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

async function expectSelected(page: Page, tablist: Locator, label: string) {
  const tab = tablist.getByRole('tab', { name: label, exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panelId = await tab.getAttribute('aria-controls');
  const panel = page.locator(`[id="${panelId}"]`);
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
}

/** The tab is fully inside the bar's visible scroll area (it may need horizontal scrolling). */
async function expectVisibleInBar(tablist: Locator, label: string) {
  const tab = tablist.getByRole('tab', { name: label, exact: true });
  const [list, box] = await Promise.all([tablist.boundingBox(), tab.boundingBox()]);
  expect(box!.x).toBeGreaterThanOrEqual(list!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(list!.x + list!.width + 1);
}

async function environment(page: Page, testInfo: TestInfo) {
  return {
    project: testInfo.project.name,
    browser: page.context().browser()?.version() ?? null,
    ...(await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      devicePixelRatio,
    }))),
  };
}

async function attach(testInfo: TestInfo, name: string, body: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(body, null, 2),
    contentType: 'application/json',
  });
}

const viewportWidth = (page: Page) => page.viewportSize()?.width ?? 0;

test('Admin allocation tabs are prominent, URL-driven and never submit', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/allocations');
  const tablist = allocationBar(page);
  await expect(tablist.getByRole('tab')).toHaveCount(4);
  await expectSelected(page, tablist, 'Phiên và kết quả');
  // The closed history tab is lazy: no order-history request until it is opened.
  expect(log.requests.filter((entry) => entry.endsWith('/order-history'))).toEqual([]);
  const before = await measureBar(tablist);
  expectProminent(before, 'primary', ALLOCATION_LABELS, viewportWidth(page));
  const widths = [];
  for (const [label, query] of [
    ['Lịch sử đặt hàng', 'history'],
    ['Tạo phiên mới', 'create'],
    ['Phiên và kết quả', null],
  ] as const) {
    await tablist.getByRole('tab', { name: label, exact: true }).click();
    await expectSelected(page, tablist, label);
    expect(new URL(page.url()).searchParams.get('tab')).toBe(query);
    const metrics = await measureBar(tablist);
    expectProminent(metrics, 'primary', ALLOCATION_LABELS, viewportWidth(page));
    widths.push(metrics.tabs.map((tab) => Math.round(tab.width * 10) / 10));
  }
  // Bold labels everywhere: selecting a tab does not change any tab's width.
  for (const row of widths) expect(row).toEqual(widths[0]);
  await page.goto('/allocations?tab=create');
  await expectSelected(page, tablist, 'Tạo phiên mới');
  await expect(page.getByRole('heading', { name: 'Tạo phiên bổ sung' })).toBeVisible();
  await page.goBack();
  await expectSelected(page, tablist, 'Phiên và kết quả');
  await page.goForward();
  await expectSelected(page, tablist, 'Tạo phiên mới');
  await page.reload();
  await expectSelected(page, tablist, 'Tạo phiên mới');
  await expectDocumentContained(page);
  await page.screenshot({
    path: testInfo.outputPath('admin-allocations.png'),
    animations: 'disabled',
  });
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
  await attach(testInfo, 'admin-allocation-tabs', {
    env: await environment(page, testInfo),
    bar: before,
    widthsPerSelection: widths,
  });
});

test('HTKD allocation tabs are prominent and the create tab stays Admin-only', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/allocations?tab=create');
  const tablist = allocationBar(page);
  await expect(tablist.getByRole('tab')).toHaveCount(2);
  await expect(tablist.getByRole('tab', { name: 'Tạo phiên mới' })).toHaveCount(0);
  // A deep link to the Admin-only tab falls back to the sessions tab with no create content.
  await expectSelected(page, tablist, 'Phiên và kết quả');
  await expect(page.getByRole('heading', { name: 'Tạo phiên bổ sung' })).toHaveCount(0);
  const metrics = await measureBar(tablist);
  expectProminent(metrics, 'primary', ALLOCATION_LABELS.slice(0, 2), viewportWidth(page));
  await page.goto('/allocations?tab=history');
  await expectSelected(page, tablist, 'Lịch sử đặt hàng');
  await tablist.getByRole('tab', { name: 'Phiên và kết quả', exact: true }).click();
  await expectSelected(page, tablist, 'Phiên và kết quả');
  await page.goBack();
  await expectSelected(page, tablist, 'Lịch sử đặt hàng');
  await expectDocumentContained(page);
  await page.screenshot({
    path: testInfo.outputPath('htkd-allocations.png'),
    animations: 'disabled',
  });
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
  await attach(testInfo, 'htkd-allocation-tabs', {
    env: await environment(page, testInfo),
    bar: metrics,
  });
});

test('Admin inventory primary and sub-tab bars are prominent with working deep links', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'ADMIN');
  await page.goto('/inventory');
  await expect(page.locator('.warehouse-stock-table tbody tr')).toHaveCount(24);
  // Only the open sub-tab loads: no history, adjustments, discrepancy or store requests yet.
  expect(
    log.requests.filter((entry) =>
      /\/(outbound-requests|warehouse-adjustments|receipt-adjustments|store-inventory-bags|warehouse-shortage-checks)$/.test(
        entry,
      ),
    ),
  ).toEqual([]);
  const width = viewportWidth(page);
  const measured: Record<string, BarMetrics> = {};
  measured.primary = await measureBar(inventoryBar(page));
  expectProminent(measured.primary, 'primary', INVENTORY_LABELS, width);
  for (const label of WAREHOUSE_LABELS) {
    await warehouseBar(page).getByRole('tab', { name: label, exact: true }).click();
    await expectSelected(page, warehouseBar(page), label);
    measured[`warehouse:${label}`] = await measureBar(warehouseBar(page));
    expectProminent(measured[`warehouse:${label}`]!, 'secondary', WAREHOUSE_LABELS, width);
  }
  await inventoryBar(page).getByRole('tab', { name: 'Kho cửa hàng', exact: true }).click();
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');
  for (const label of [...STORE_LABELS].reverse()) {
    await storeBar(page).getByRole('tab', { name: label, exact: true }).click();
    await expectSelected(page, storeBar(page), label);
    measured[`store:${label}`] = await measureBar(storeBar(page));
    expectProminent(measured[`store:${label}`]!, 'secondary', STORE_LABELS, width);
  }
  await inventoryBar(page).getByRole('tab', { name: 'Phiếu sai lệch', exact: true }).click();
  await expectSelected(page, inventoryBar(page), 'Phiếu sai lệch');
  expectProminent(await measureBar(inventoryBar(page)), 'primary', INVENTORY_LABELS, width);

  for (const [url, primary, secondary] of [
    ['/inventory?tab=warehouse&kt=history', 'Kho tổng', 'Lịch sử xuất'],
    ['/inventory?tab=warehouse&kt=adjustments', 'Kho tổng', 'Lịch sử điều chỉnh'],
    ['/inventory?tab=store&ch=ledger', 'Kho cửa hàng', 'Sổ phát sinh'],
    ['/inventory?tab=adjustments', 'Phiếu sai lệch', null],
  ] as const) {
    await page.goto(url);
    await expectSelected(page, inventoryBar(page), primary);
    if (secondary) {
      const sub = primary === 'Kho tổng' ? warehouseBar(page) : storeBar(page);
      await expectSelected(page, sub, secondary);
      await expectVisibleInBar(sub, secondary);
    }
    await page.reload();
    await expectSelected(page, inventoryBar(page), primary);
  }
  await page.goBack();
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');
  await expectSelected(page, storeBar(page), 'Sổ phát sinh');
  await page.goForward();
  await expectSelected(page, inventoryBar(page), 'Phiếu sai lệch');
  await expectDocumentContained(page);
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
  await attach(testInfo, 'admin-inventory-tabs', {
    env: await environment(page, testInfo),
    bars: measured,
  });
});

test('Admin inventory draft guard still asks before a primary tab discards input', async ({
  page,
}) => {
  const log = await mockApi(page, 'ADMIN', { shortage: true });
  await page.goto('/inventory?tab=warehouse&kt=shortage');
  const reason = page.getByLabel('Lý do xác nhận phiếu PN-TAB-0001');
  await reason.fill('Đang kiểm kệ');
  const before = await measureBar(inventoryBar(page));
  await inventoryBar(page).getByRole('tab', { name: 'Kho cửa hàng', exact: true }).click();
  await expect(page.getByText('Tab đang mở có nội dung chưa gửi.')).toBeVisible();
  // The warning does not resize the bar.
  expect((await measureBar(inventoryBar(page))).tabs).toEqual(before.tabs);
  await page.getByRole('button', { name: 'Ở lại', exact: true }).click();
  await expectSelected(page, inventoryBar(page), 'Kho tổng');
  await expect(reason).toHaveValue('Đang kiểm kệ');
  await inventoryBar(page).getByRole('tab', { name: 'Kho cửa hàng', exact: true }).click();
  await page.getByRole('button', { name: 'Bỏ nháp và chuyển', exact: true }).click();
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');
  expect(new URL(page.url()).searchParams.get('tab')).toBe('store');
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
});

test('store accounts keep their stock by default and read the warehouse without Admin tools', async ({
  page,
}, testInfo) => {
  const measured: Record<string, BarMetrics> = {};
  const log = await mockApi(page, 'STORE');
  await page.goto('/inventory');
  const width = viewportWidth(page);
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');
  measured.primary = await measureBar(inventoryBar(page));
  expectProminent(measured.primary, 'primary', ['Kho tổng', 'Kho cửa hàng'], width);
  measured.store = await measureBar(storeBar(page));
  expectProminent(measured.store, 'secondary', STORE_LABELS, width);
  expect(log.requests.some((entry) => entry.includes('/warehouse-inventory'))).toBe(false);

  await inventoryBar(page).getByRole('tab', { name: 'Kho tổng', exact: true }).click();
  await expectSelected(page, inventoryBar(page), 'Kho tổng');
  expect(new URL(page.url()).searchParams.get('tab')).toBe('warehouse');
  await expect(page.locator('.warehouse-stock-table tbody tr')).toHaveCount(24);
  await expect(warehouseBar(page).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: 'Thao tác' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Điều chỉnh tồn/ })).toHaveCount(0);
  await page.reload();
  await expectSelected(page, inventoryBar(page), 'Kho tổng');
  await page.goBack();
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');

  // Admin-only scopes fall back instead of opening by a deep link.
  await page.goto('/inventory?tab=adjustments&kt=history');
  await expectSelected(page, inventoryBar(page), 'Kho cửa hàng');
  await page.goto('/inventory?tab=warehouse&kt=adjustments');
  await expectSelected(page, warehouseBar(page), 'Tồn hiện tại');
  expect(
    log.requests.some((path) =>
      /warehouse-adjustments|warehouse-shortage-checks|outbound-requests|receipt-adjustments/.test(
        path,
      ),
    ),
  ).toBe(false);

  await page.goto('/allocations');
  await expect(allocationBar(page).getByRole('tab')).toHaveCount(1);
  measured['STORE:allocations'] = await measureBar(allocationBar(page));
  expectDefault(measured['STORE:allocations'], 'primary');
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
  await attach(testInfo, 'store-inventory-tabs', measured);
});

test('wholesale desk reads only the warehouse stock, responsive and without Admin tools', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'WHOLESALE');
  await page.goto('/inventory?tab=store&ch=ledger');
  await expect(page.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' })).toBeVisible();
  await expect(page.locator('.warehouse-stock-table tbody tr')).toHaveCount(24);
  await expect(inventoryBar(page).getByRole('tab')).toHaveCount(1);
  await expectSelected(page, inventoryBar(page), 'Kho tổng');
  await expect(warehouseBar(page).getByRole('tab')).toHaveCount(1);
  await expect(storeBar(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Điều chỉnh tồn/ })).toHaveCount(0);
  expect(
    log.requests.some((path) =>
      /store-inventory-bags|warehouse-adjustments|warehouse-shortage-checks|outbound-requests/.test(
        path,
      ),
    ),
  ).toBe(false);
  for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expectDocumentContained(page);
    await page.screenshot({
      path: testInfo.outputPath(`wholesale-warehouse-${width}.png`),
      fullPage: true,
    });
  }
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
});

test('loading, empty, error and retry keep the tab bars and their size', async ({ page }) => {
  await mockApi(page, 'ADMIN');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mode: 'pending' | 'empty' | 'error' | 'data' = 'pending';
  await page.route('**/api/v1/warehouse-inventory?*', async (route) => {
    if (mode === 'pending') await pending;
    if (mode === 'error') return route.fulfill({ status: 500, json: { message: 'Fixture' } });
    if (mode === 'data') return route.fallback();
    return route.fulfill({ json: { data: [], pagination: emptyPage } });
  });
  await page.goto('/inventory');
  await expect(page.getByText('Đang tải tồn kho tổng…')).toBeVisible();
  const loading = [await measureBar(inventoryBar(page)), await measureBar(warehouseBar(page))];
  mode = 'empty';
  release();
  await expect(page.getByText('Đang tải tồn kho tổng…')).toHaveCount(0);
  await expect(page.locator('.warehouse-stock-table tbody tr')).toHaveCount(0);
  const empty = [await measureBar(inventoryBar(page)), await measureBar(warehouseBar(page))];
  mode = 'error';
  await page.reload();
  await expect(page.getByText('Không tải được tồn kho tổng.', { exact: false })).toBeVisible();
  const failed = [await measureBar(inventoryBar(page)), await measureBar(warehouseBar(page))];
  mode = 'data';
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.locator('.warehouse-stock-table tbody tr')).toHaveCount(24);
  const loaded = [await measureBar(inventoryBar(page)), await measureBar(warehouseBar(page))];
  const sizes = (bars: BarMetrics[]) =>
    bars.map((metrics) => metrics.tabs.map(({ width, height }) => [width, height]));
  expect(sizes(empty)).toEqual(sizes(loading));
  expect(sizes(failed)).toEqual(sizes(loading));
  expect(sizes(loaded)).toEqual(sizes(loading));
  expectProminent(loading[0]!, 'primary', INVENTORY_LABELS, viewportWidth(page));
  expectProminent(loading[1]!, 'secondary', WAREHOUSE_LABELS, viewportWidth(page));
});

test('keyboard navigation keeps the focused tab visible inside a scrolling bar', async ({
  page,
}, testInfo) => {
  await mockApi(page, 'ADMIN');
  await page.setViewportSize({ width: 360, height: 800 });
  // A deep link to the last sub-tab scrolls only the bar so the selection is visible.
  await page.goto('/inventory?tab=warehouse&kt=adjustments');
  const tablist = warehouseBar(page);
  await expectSelected(page, tablist, 'Lịch sử điều chỉnh');
  const metrics = await measureBar(tablist);
  expect(metrics.scrollWidth, 'sub-tabs overflow the 360px bar').toBeGreaterThan(
    metrics.clientWidth,
  );
  await expectVisibleInBar(tablist, 'Lịch sử điều chỉnh');
  await expectDocumentContained(page);

  await page.goto('/inventory?tab=warehouse');
  const first = tablist.getByRole('tab', { name: 'Tồn hiện tại', exact: true });
  await first.focus();
  const pageScroll = await page.evaluate(() => scrollY);
  const steps: { key: string; selected: string; focused: boolean; scrollY: number }[] = [];
  for (const [key, label] of [
    ['End', 'Lịch sử điều chỉnh'],
    ['Home', 'Tồn hiện tại'],
    ['ArrowLeft', 'Lịch sử điều chỉnh'],
    ['ArrowRight', 'Tồn hiện tại'],
    ['ArrowRight', 'Kiểm hàng thiếu'],
    ['Enter', 'Kiểm hàng thiếu'],
    [' ', 'Kiểm hàng thiếu'],
  ] as const) {
    await page.keyboard.press(key === ' ' ? 'Space' : key);
    const tab = tablist.getByRole('tab', { name: label, exact: true });
    await expectSelected(page, tablist, label);
    await expect(tab).toBeFocused();
    await expectVisibleInBar(tablist, label);
    expect(await tab.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    steps.push({
      key,
      selected: label,
      focused: true,
      scrollY: await page.evaluate(() => scrollY),
    });
  }
  // Moving along the bar never scrolls the page itself.
  for (const step of steps) expect(Math.abs(step.scrollY - pageScroll)).toBeLessThanOrEqual(1);
  // The focus ring is drawn inside the tab, so the bar's overflow cannot cut it.
  const focused = tablist.getByRole('tab', { name: 'Kiểm hàng thiếu', exact: true });
  const ring = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  });
  expect(ring.style).not.toBe('none');
  expect(Number.parseFloat(ring.offset)).toBeLessThanOrEqual(-Number.parseFloat(ring.width));
  // Roving tabindex: Tab enters the bar on the selected tab and leaves it on the next stop.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(tablist.getByRole('tab', { name: 'Kiểm hàng thiếu', exact: true })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('keyboard-360.png'),
    animations: 'disabled',
  });
  await attach(testInfo, 'keyboard-steps', { env: await environment(page, testInfo), steps });
});

const MATRIX = [360, 390, 412, 620, 621, 768, 819, 820, 821, 1366, 1440, 1920, 2560];
const MATRIX_HEIGHT: Record<number, number> = {
  360: 800,
  390: 844,
  412: 915,
  768: 1024,
  1366: 768,
  1440: 900,
  1920: 1080,
  2560: 1440,
};

test('viewport matrix keeps prominent bars sized, contained and scrollable', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-1440',
    'The width matrix resizes one browser; the mobile project covers touch emulation.',
  );
  const log = await mockApi(page, 'ADMIN');
  const results = [];
  for (const [route, bars] of [
    ['/allocations', [['primary', ALLOCATION_LABELS, allocationBar]]],
    [
      '/inventory?tab=warehouse',
      [
        ['primary', INVENTORY_LABELS, inventoryBar],
        ['secondary', WAREHOUSE_LABELS, warehouseBar],
      ],
    ],
  ] as const) {
    await page.goto(route);
    for (const width of MATRIX) {
      await page.setViewportSize({ width, height: MATRIX_HEIGHT[width] ?? 900 });
      await page.evaluate(() => document.fonts.ready);
      await expectDocumentContained(page);
      const row: Record<string, unknown> = { route, ...(await environment(page, testInfo)) };
      for (const [level, labels, locate] of bars) {
        const tablist = locate(page);
        const metrics = await measureBar(tablist);
        expectProminent(metrics, level, labels, width);
        // The bar itself stays inside the viewport; extra tabs scroll within it.
        expect(metrics.left).toBeGreaterThanOrEqual(-1);
        expect(metrics.right).toBeLessThanOrEqual(width + 1);
        // First and last tabs can be reached and clicked, then the selection is restored.
        const lastLabel = labels[labels.length - 1]!;
        await tablist.getByRole('tab', { name: lastLabel, exact: true }).click();
        await expectSelected(page, tablist, lastLabel);
        await expectVisibleInBar(tablist, lastLabel);
        await tablist.getByRole('tab', { name: labels[0], exact: true }).click();
        await expectSelected(page, tablist, labels[0]);
        await expectVisibleInBar(tablist, labels[0]);
        const panel = await page
          .locator(
            `[id="${await tablist.getByRole('tab', { name: labels[0], exact: true }).getAttribute('aria-controls')}"]`,
          )
          .boundingBox();
        const list = await tablist.boundingBox();
        // Content starts below the bar instead of overlapping it.
        expect(panel!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
        row[level] = {
          fontSize: metrics.tabs[0]!.fontSize,
          fontWeight: metrics.tabs.map((tab) => tab.fontWeight),
          heights: metrics.tabs.map((tab) => tab.height),
          widths: metrics.tabs.map((tab) => Math.round(tab.width * 10) / 10),
          padding: metrics.tabs[0]!.padding,
          scrollWidth: metrics.scrollWidth,
          clientWidth: metrics.clientWidth,
          scrolls: metrics.scrollWidth > metrics.clientWidth,
        };
      }
      results.push(row);
      if ([390, 1440, 2560].includes(width)) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: testInfo.outputPath(
            `${route === '/allocations' ? 'allocations' : 'inventory'}-${width}.png`,
          ),
          animations: 'disabled',
        });
      }
    }
  }
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
  await attach(testInfo, 'prominent-tabs-matrix', results);
});

test('real 200% browser zoom keeps the prominent bars readable and contained', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.skip(
    testInfo.project.name !== 'desktop-1440',
    'Browser zoom applies to the desktop browser only.',
  );
  await withBrowserZoom(testInfo, async (page, setZoom) => {
    const log = await mockApi(page, 'ADMIN');
    const results = [];
    for (const [route, bars] of [
      ['/allocations', [['primary', ALLOCATION_LABELS, allocationBar]]],
      [
        '/inventory?tab=warehouse',
        [
          ['primary', INVENTORY_LABELS, inventoryBar],
          ['secondary', WAREHOUSE_LABELS, warehouseBar],
        ],
      ],
    ] as const) {
      await page.goto(`http://127.0.0.1:4175${route}`);
      await expect(page.locator('[role="tablist"]').first()).toBeVisible();
      for (const factor of [1, 2]) {
        expect(await setZoom(factor)).toBe(factor);
        await expectDocumentContained(page);
        const cssWidth = await page.evaluate(() => innerWidth);
        const row: Record<string, unknown> = {
          route,
          zoom: factor,
          ...(await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio }))),
        };
        for (const [level, labels, locate] of bars) {
          const metrics = await measureBar(locate(page));
          expectProminent(metrics, level, labels, cssWidth);
          row[level] = metrics.tabs.map(({ label, fontSize, fontWeight, width, height }) => ({
            label,
            fontSize,
            fontWeight,
            width,
            height,
          }));
        }
        results.push(row);
        await page.screenshot({
          path: testInfo.outputPath(
            `${route === '/allocations' ? 'allocations' : 'inventory'}-zoom-${factor}.png`,
          ),
          animations: 'disabled',
        });
      }
    }
    expect(log.mutations).toEqual([]);
    expect(log.unexpected).toEqual([]);
    await attach(testInfo, 'prominent-tabs-zoom', results);
  });
});

test('allocation policy is read-only and manual reload clears a recovered worker error', async ({
  page,
}, testInfo) => {
  const log = await mockApi(page, 'ADMIN');
  let recovered = false;
  await page.route('**/api/v1/admin/worker-status', (route) =>
    route.fulfill({
      json: {
        data: {
          worker: 'allocation',
          status: recovered ? 'HEALTHY' : 'DEGRADED',
          lastTickStartedAt: time,
          lastTickCompletedAt: time,
          lastSuccessfulTickAt: time,
          lastError: recovered ? null : 'Unsupported allocation policy idosi-round-robin-p0a-p3-v3',
          failingJobs: [],
          updatedAt: time,
        },
      },
    }),
  );
  await page.goto('/allocations?tab=create');
  const policy = page.getByLabel('Phiên bản chính sách');
  await expect(policy).toHaveValue('idosi-round-robin-p0a-p3-v1');
  await expect(policy).toHaveAttribute('readonly', '');
  await expect(page.getByRole('alert')).toContainText('Unsupported allocation policy');
  recovered = true;
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('supported-allocation-policy.png'),
    fullPage: true,
  });
  expect(log.mutations).toEqual([]);
  expect(log.unexpected).toEqual([]);
});

test('Admin can save a supported policy over legacy settings without changing other fields', async ({
  page,
}) => {
  await mockApi(page, 'ADMIN');
  // These independent integration panels may be unavailable while settings are repaired.
  await page.route('**/api/v1/admin/idosi-*', (route) =>
    route.fulfill({ status: 503, json: { message: 'Integration unavailable in this fixture' } }),
  );
  let current = {
    id: id(60),
    version: 1,
    timezone: 'Asia/Ho_Chi_Minh',
    snapshotTime: '08:00',
    cutoffTime: '09:00',
    maxRequestsPerStore: 2,
    policyVersion: 'idosi-round-robin-p0a-p3-v3',
    idosiSyncIntervalMinutes: 15,
    vatRatePercent: 0,
    createdByAccountId: null,
    requestId: 'legacy-policy-fixture',
    createdAt: time,
  };
  const writes: unknown[] = [];
  await page.route('**/api/v1/admin/operational-settings**', async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      writes.push(input);
      current = { ...current, id: id(61), version: 2, policyVersion: input.policyVersion };
    }
    await route.fulfill({
      json: {
        data: {
          current,
          history: [current],
          integration: {
            endpoint: 'https://example.invalid/idosi',
            status: 'NOT_CONFIGURED',
          },
        },
      },
    });
  });
  await page.goto('/settings');
  await expect(page.getByLabel('Phiên bản chính sách')).toHaveValue('idosi-round-robin-p0a-p3-v1');
  await expect(page.getByLabel('Phiên bản chính sách')).toHaveAttribute('readonly', '');
  const save = page.getByRole('button', { name: 'Lưu phiên bản mới' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Bản hiện tại v2.', { exact: false })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(writes).toEqual([
    {
      expectedVersion: 1,
      timezone: 'Asia/Ho_Chi_Minh',
      snapshotTime: '08:00',
      cutoffTime: '09:00',
      maxRequestsPerStore: 2,
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idosiSyncIntervalMinutes: 15,
      vatRatePercent: 0,
    },
  ]);
});

test('HTKD warehouse is read only even with privileged deep links', async ({ page }, testInfo) => {
  const log = await mockApi(page, 'HTKD');
  await page.goto('/inventory?tab=adjustments&kt=history');
  await expect(page.getByRole('region', { name: 'Tồn kho tổng theo mặt hàng' })).toBeVisible();
  await expect(inventoryBar(page).getByRole('tab')).toHaveCount(2);
  await expect(warehouseBar(page).getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Điều chỉnh tồn/ })).toHaveCount(0);
  expect(
    log.requests.some((path) =>
      /warehouse-adjustments|warehouse-shortage-checks|outbound-requests/.test(path),
    ),
  ).toBe(false);
  for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expectDocumentContained(page);
  }
  await page.screenshot({ path: testInfo.outputPath('htkd-warehouse.png'), fullPage: true });
});

test('Admin wait list has nine columns, server pages, cancellation history and URL state', async ({
  page,
}, testInfo) => {
  await mockApi(page, 'ADMIN');
  const ticket = {
    id: id(800),
    code: 'PC-0000800',
    sessionId: id(801),
    mergedOrderId: null,
    storeId: storeIds[0],
    storeName: stores[0]!.name,
    productId: id(10),
    productName: 'Mặt hàng phiếu chờ',
    sku: 'WAIT-UI',
    priority: 'P0B',
    requested: { kind: 'UNIT', quantity: 5 },
    fulfilled: { kind: 'UNIT', quantity: 2 },
    remaining: { kind: 'UNIT', quantity: 3 },
    status: 'WAITING',
    createdAt: '2026-10-05T17:00:00.000Z',
    updatedAt: time,
    resolutionReason: null as string | null,
    resolvedAt: null as string | null,
    cancellationKind: null as string | null,
    latestOffer: null,
  };
  const queries: URLSearchParams[] = [];
  await page.route('**/api/v1/wait-tickets?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    return route.fulfill({
      json: {
        data: [ticket],
        pagination: {
          page: Number(q.get('page') ?? 1),
          pageSize: 20,
          totalItems: 21,
          totalPages: 2,
        },
      },
    });
  });
  await page.route('**/api/v1/wait-tickets/*/cancel', async (route) => {
    ticket.status = 'CANCELLED';
    ticket.resolutionReason = route.request().postDataJSON().reason;
    ticket.resolvedAt = time;
    ticket.cancellationKind = 'ADMIN_CANCELLED';
    return route.fulfill({ json: { data: ticket } });
  });
  await page.goto('/allocations?tab=history');
  expect(queries).toHaveLength(0);
  await allocationBar(page).getByRole('tab', { name: 'Danh sách phiếu chờ', exact: true }).click();
  const table = page.locator('.wait-ticket-table');
  await expect(table.locator('th')).toHaveCount(9);
  await expect(table).toContainText('Chưa phát sinh phiếu ưu tiên');
  await expect(table).toContainText('06/10/2026 00:00:00');
  await page.getByRole('button', { name: 'Sau', exact: true }).click();
  await expect(table.locator('tbody td').first()).toHaveText('21');
  expect(queries.at(-1)?.get('page')).toBe('2');
  await page.reload();
  await expect(table.locator('tbody td').first()).toHaveText('21');
  expect(queries.at(-1)?.get('projection')).toBe('TABLE');
  await page.getByRole('searchbox', { name: 'Mã phiếu chờ / ưu tiên' }).fill('PC-0000800');
  await page.getByRole('button', { name: 'Lọc phiếu', exact: true }).click();
  await expect(page).toHaveURL(/wt.q=PC-0000800/);
  await expect(table.locator('tbody td').first()).toHaveText('1');
  await page.goBack();
  await expect(table.locator('tbody td').first()).toHaveText('21');
  await page.goForward();
  await expect(page).toHaveURL(/wt.q=PC-0000800/);
  await expect(table.locator('tbody td').first()).toHaveText('1');
  await table.getByRole('button', { name: 'Hủy phiếu chờ', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('PC-0000800');
  await dialog.getByLabel('Lý do hủy').fill('Không còn nhu cầu sau đối soát');
  await dialog.getByRole('button', { name: 'Hủy phiếu chờ', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(table).toContainText('Đã bị hủy');
  await expect(table).toContainText('Không còn nhu cầu sau đối soát');
  await expect(table.getByRole('button', { name: 'Hủy phiếu chờ', exact: true })).toHaveCount(0);
  for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expectDocumentContained(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(table.locator('th').first()).toBeVisible();
    expect(await table.evaluate((el) => getComputedStyle(el).display)).toBe('table');
    const reachable = await table.evaluate((el) => {
      const region = el.parentElement!;
      region.scrollLeft = region.scrollWidth;
      const last = el.querySelector('th:last-child')!.getBoundingClientRect();
      const bounds = region.getBoundingClientRect();
      const fits = last.right <= bounds.right + 1 && last.left >= bounds.left - 1;
      region.scrollLeft = 0;
      return fits;
    });
    expect(reachable).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`wait-list-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});

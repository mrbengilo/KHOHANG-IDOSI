import { expect, test, type Page } from '@playwright/test';
import { InboundStatisticsQuerySchema, type InboundStatisticsQuery } from '@idosi/contracts';
import {
  summarizeInboundStatistics,
  type InboundAggregate,
  type InboundStore,
} from '@idosi/database';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stores: InboundStore[] = [
  { id: id(1), code: 'A', name: 'Cửa hàng A', kind: 'RETAIL' },
  { id: id(2), code: 'C', name: 'Cửa hàng C', kind: 'WHOLESALE' },
];
const rows: InboundAggregate[] = [
  {
    storeId: id(1),
    productId: id(3),
    sku: 'NAM',
    productName: 'Đồ nam',
    source: 'WAREHOUSE',
    bagQuantity: '30',
    weightGrams: '430000',
    bagsComplete: true,
    weightComplete: true,
  },
  {
    storeId: id(1),
    productId: id(3),
    sku: 'NAM',
    productName: 'Đồ nam',
    source: 'PARTNER',
    bagQuantity: '5',
    weightGrams: '70000',
    bagsComplete: true,
    weightComplete: true,
  },
  {
    storeId: id(2),
    productId: id(4),
    sku: 'VEST',
    productName: 'Áo vest',
    source: 'WAREHOUSE',
    bagQuantity: '1',
    weightGrams: '45000',
    bagsComplete: true,
    weightComplete: true,
  },
];
const timestamp = '2026-09-15T00:00:00.000Z';
const mockAdminSession = (page: Page) =>
  page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        data: {
          id: id(9),
          createdAt: timestamp,
          lastSeenAt: timestamp,
          expiresAt: '2099-01-01T00:00:00.000Z',
          principal: {
            accountId: id(8),
            assignedStoreIds: [],
            displayName: 'Admin',
            role: 'ADMIN',
            status: 'ACTIVE',
            storeId: null,
            username: 'admin',
          },
        },
      },
    }),
  );
test('Admin filters, source breakdown, charts, retry and responsive tables', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockAdminSession(page);
  let releaseSlow: (() => void) | undefined;
  let slowStarted: (() => void) | undefined;
  const slowRequest = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  let fail = false,
    missing = false;
  await page.route('**/api/v1/reports/inbound-statistics?*', async (route) => {
    if (fail)
      return route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL_ERROR', message: 'Test error', requestId: 'test' } },
      });
    const query = InboundStatisticsQuerySchema.parse(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    if (query.month === '2000-02') {
      slowStarted?.();
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
    }
    const input =
      query.month === '2000-01'
        ? []
        : missing
          ? rows.map((r) => ({ ...r, weightComplete: false }))
          : rows;
    return route.fulfill({ json: { data: summarizeInboundStatistics(query, input, stores) } });
  });
  await page.goto('/inbound-statistics');
  await expect(
    page.getByRole('heading', { name: 'Thống kê nhập hàng', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.inbound-overview')).toContainText('36 bao · 545 kg');
  await page
    .getByRole('combobox', { name: 'Chi tiết theo nguồn', exact: true })
    .selectOption('PARTNER');
  await expect(page.locator('.inbound-overview')).toContainText('36 bao · 545 kg');
  await expect(page.locator('.inbound-ranking')).toContainText('5 bao · 70 kg');
  await page.getByRole('button', { name: 'Đồ nam: 5 bao · 70 kg', exact: true }).first().focus();
  await expect(page.getByRole('tooltip')).toContainText('Đối tác khác: 5 bao · 70 kg');
  await page
    .getByRole('combobox', { name: 'Loại cửa hàng', exact: true })
    .selectOption('WHOLESALE');
  await expect(page.locator('.inbound-overview')).toContainText('1 bao · 45 kg');
  await expect(page.locator('.inbound-ranking')).toContainText('Không có dữ liệu');
  await page.getByRole('combobox', { name: 'Loại cửa hàng', exact: true }).selectOption('');
  await page
    .getByRole('combobox', { name: 'Chi tiết theo nguồn', exact: true })
    .selectOption('ALL');
  await page.getByLabel('Tìm mặt hàng', { exact: true }).fill('vest');
  await expect(page.getByLabel('Bảng mặt hàng').locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('.inbound-overview')).toContainText('36 bao · 545 kg');
  await page.getByLabel('Tìm mặt hàng', { exact: true }).fill('');
  for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await expect(page.getByLabel('Bảng mặt hàng')).toBeVisible();
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: testInfo.outputPath(`inbound-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
  }
  missing = true;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByText('Dữ liệu chưa đầy đủ.', { exact: false }).first()).toBeVisible();
  missing = false;
  fail = true;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible({
    timeout: 20000,
  });
  fail = false;
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.locator('.inbound-overview')).toContainText('36 bao · 545 kg');
  await page.getByLabel('Tháng', { exact: true }).fill('2000-02');
  await slowRequest;
  await expect(page.locator('.inbound-overview')).toContainText('36 bao · 545 kg');
  await expect(page.getByRole('status')).toContainText('Bên dưới vẫn là báo cáo trước:');
  await expect(page.getByRole('status')).toContainText('Chưa phải kết quả của bộ lọc mới.');
  await expect(page.locator('.inbound-results')).toHaveAttribute('inert', '');
  await page.getByLabel('Tháng', { exact: true }).fill('2000-01');
  await expect(page.locator('.inbound-overview')).toContainText('0 bao · 0 kg');
  releaseSlow?.();
  await expect(page.getByLabel('Tháng', { exact: true })).toHaveValue('2000-01');
  await expect(page.locator('.inbound-overview')).toContainText('0 bao · 0 kg');
  expect(errors).toEqual([]);
});

// Store-detail regression: "Xem chi tiết" used to rewrite the page-wide store filter, so the
// store list collapsed to the clicked row and the button could not close anything.
const detailStores: InboundStore[] = [
  { id: id(101), code: 'ALP', name: 'Cửa hàng Alpha', kind: 'RETAIL' },
  { id: id(102), code: 'BET', name: 'Cửa hàng Beta', kind: 'WHOLESALE' },
  { id: id(103), code: 'TRG', name: 'Cửa hàng Trống', kind: 'RETAIL' },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: id(110 + index),
    code: `F0${index + 1}`,
    name: `Cửa hàng phụ 0${index + 1}`,
    kind: 'RETAIL' as const,
  })),
];
const [alpha, beta, emptyStore] = detailStores as [InboundStore, InboundStore, InboundStore];
const aggregate = (
  store: InboundStore,
  product: number,
  source: InboundAggregate['source'],
  bags: number,
  kilograms: number,
): InboundAggregate => ({
  storeId: store.id,
  productId: id(200 + product),
  sku: `SP${String(product).padStart(2, '0')}`,
  productName: `Mặt hàng ${String(product).padStart(2, '0')}`,
  source,
  bagQuantity: String(bags),
  weightGrams: String(kilograms * 1000),
  bagsComplete: true,
  weightComplete: true,
});
// Alpha: 12 SKUs, 81 bao / 810 kg (kho 78/780, đối tác 3/30). Beta: 9/90. Toàn phạm vi: 99/909.
const detailAggregates: InboundAggregate[] = [
  ...Array.from({ length: 12 }, (_, index) =>
    aggregate(alpha, index + 1, 'WAREHOUSE', index + 1, (index + 1) * 10),
  ),
  aggregate(alpha, 1, 'PARTNER', 3, 30),
  aggregate(beta, 20, 'WAREHOUSE', 7, 70),
  aggregate(beta, 21, 'PARTNER', 2, 20),
  ...detailStores.slice(3).map((store) => aggregate(store, 1, 'WAREHOUSE', 1, 1)),
];

async function mockDetailReport(page: Page) {
  await mockAdminSession(page);
  const held = new Map<string, Promise<void>>();
  const state = {
    requests: [] as InboundStatisticsQuery[],
    fulfilled: [] as InboundStatisticsQuery[],
    failStoreId: undefined as string | undefined,
    incompleteStoreId: undefined as string | undefined,
    extraAlphaBag: false,
  };
  await page.route('**/api/v1/reports/inbound-statistics?*', async (route) => {
    const query = InboundStatisticsQuerySchema.parse(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    state.requests.push(query);
    const gate = query.storeId ? held.get(query.storeId) : undefined;
    if (gate) await gate;
    const input = [
      ...detailAggregates,
      ...(state.extraAlphaBag ? [aggregate(alpha, 1, 'WAREHOUSE', 1, 5)] : []),
    ].map((row) =>
      row.storeId === state.incompleteStoreId ? { ...row, weightComplete: false } : row,
    );
    const failed = query.storeId !== undefined && query.storeId === state.failStoreId;
    state.fulfilled.push(query);
    await route.fulfill(
      failed
        ? {
            status: 500,
            json: { error: { code: 'INTERNAL_ERROR', message: 'Lỗi thử', requestId: 'test' } },
          }
        : { json: { data: summarizeInboundStatistics(query, input, detailStores) } },
    );
  });
  /** Holds every request for one store until the returned release function runs. */
  const hold = (storeId: string) => {
    let release!: () => void;
    held.set(
      storeId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      held.delete(storeId);
      release();
    };
  };
  return { state, hold };
}

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // Mocked HTTP 500 responses are expected network errors, not application errors.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text());
  });
  return errors;
}

const storeTable = (page: Page) => page.getByLabel('Bảng cửa hàng', { exact: true });
const parentStoreRows = (page: Page) =>
  storeTable(page).locator(':scope > table > tbody > tr > th[scope="row"]');
const storeRow = (page: Page, store: InboundStore) =>
  storeTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: store.name }) });
const toggle = (page: Page, store: InboundStore) => storeRow(page, store).getByRole('button');
const detailRows = (page: Page) =>
  storeTable(page).locator(':scope > table > tbody > tr.inbound-store-detail-row');
const detailRegion = (page: Page, store: InboundStore) =>
  page.getByRole('region', { name: `Chi tiết cửa hàng ${store.code} · ${store.name}` });
const storeFilter = (page: Page) => page.getByRole('combobox', { name: 'Cửa hàng', exact: true });
const select = (page: Page, name: string, value: string) =>
  page.getByRole('combobox', { name, exact: true }).selectOption(value);
const nextFrame = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

/** Everything owned by the parent report; opening a detail must leave all of it untouched. */
async function parentSnapshot(page: Page) {
  return {
    controls: await page
      .locator('.inbound-filters')
      .locator('select, input')
      .evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value)),
    overview: await page.locator('.inbound-overview').innerText(),
    groups: await page.getByLabel('Bảng loại cửa hàng', { exact: true }).innerText(),
    ranking: await page.locator('.inbound-ranking').innerText(),
    charts: await page.locator('.inbound-charts').innerText(),
    stores: await parentStoreRows(page).allInnerTexts(),
    storeTotal: await storeTable(page).locator(':scope > table > tfoot').innerText(),
    storePager: await page
      .getByRole('navigation', { name: 'Phân trang cửa hàng', exact: true })
      .innerText(),
    products: await page.getByLabel('Bảng mặt hàng', { exact: true }).innerText(),
    productPager: await page
      .getByRole('navigation', { name: 'Phân trang mặt hàng', exact: true })
      .innerText(),
  };
}

test('Xem chi tiết opens inline, keeps the store list and collapses again', async ({ page }) => {
  const errors = trackErrors(page);
  const { state } = await mockDetailReport(page);
  await page.goto('/inbound-statistics');
  await expect(parentStoreRows(page)).toHaveCount(12);
  const before = await parentSnapshot(page);
  const url = page.url();
  const requestCount = state.fulfilled.length;
  const tableWidth = () => storeTable(page).evaluate((element) => element.scrollWidth);
  const closedWidth = await tableWidth();

  await toggle(page, alpha).click();
  await expect.poll(() => state.fulfilled.length).toBe(requestCount + 1);
  // The old handler set the page-wide store filter to Alpha and reloaded the whole report.
  await expect(storeFilter(page), 'global store filter must stay unchanged').toHaveValue('');
  await expect(parentStoreRows(page)).toHaveCount(12);
  await expect(detailRegion(page, alpha)).toBeVisible();
  expect(await parentSnapshot(page)).toEqual(before);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Opening a detail must not widen the content-sized store table.
  expect(await tableWidth()).toBe(closedWidth);
  // Exactly one request, scoped to Alpha, with page 1 and no inherited searches.
  expect(state.requests.slice(requestCount)).toEqual([
    expect.objectContaining({
      storeId: alpha.id,
      storeKind: 'RETAIL',
      storePage: 1,
      productPage: 1,
      storeSearch: '',
      productSearch: '',
    }),
  ]);

  const alphaToggle = toggle(page, alpha);
  await expect(alphaToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(alphaToggle).toHaveAccessibleName('Thu gọn chi tiết ALP · Cửa hàng Alpha');
  const region = detailRegion(page, alpha);
  await expect(region).toHaveAttribute('id', (await alphaToggle.getAttribute('aria-controls'))!);
  await expect(detailRows(page)).toHaveCount(1);
  expect(
    await storeRow(page, alpha).evaluate((row) =>
      row.nextElementSibling?.classList.contains('inbound-store-detail-row'),
    ),
  ).toBe(true);
  await expect(detailRows(page).locator(':scope > td')).toHaveAttribute(
    'colspan',
    String(await storeTable(page).locator(':scope > table > thead > tr > th').count()),
  );
  await expect(region).toContainText('Nguồn: Tất cả');
  await expect(region).toContainText('81 bao · 810 kg');
  await expect(region.locator('tbody > tr')).toHaveCount(12);
  // Share uses Alpha's own total (12/81), not the parent's 12/99.
  await expect(region.getByRole('row', { name: /SP12/ })).toContainText('14.81%');
  await expect(region.locator('tfoot')).toContainText('81');

  await alphaToggle.click();
  await expect(detailRows(page)).toHaveCount(0);
  await expect(alphaToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(alphaToggle).toHaveAccessibleName('Xem chi tiết ALP · Cửa hàng Alpha');
  await expect(alphaToggle).toBeFocused();
  expect(await parentSnapshot(page)).toEqual(before);

  await alphaToggle.click();
  await expect(region).toBeVisible();
  await toggle(page, beta).click();
  await expect(detailRows(page)).toHaveCount(1);
  await expect(region).toHaveCount(0);
  await expect(alphaToggle).toHaveAttribute('aria-expanded', 'false');
  const betaRegion = detailRegion(page, beta);
  await expect(betaRegion).toContainText('9 bao · 90 kg');
  await expect(betaRegion.locator('tbody > tr')).toHaveCount(2);
  await expect(betaRegion).not.toContainText('SP01');

  const betaToggle = toggle(page, beta);
  await betaToggle.focus();
  await page.keyboard.press('Space');
  await expect(detailRows(page)).toHaveCount(0);
  await expect(betaToggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(betaRegion).toBeVisible();
  await expect(betaToggle).toBeFocused();
  expect(await parentSnapshot(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('detail keeps parent paging, searches and sort; it pages on its own', async ({ page }) => {
  const errors = trackErrors(page);
  const { state } = await mockDetailReport(page);
  await page.goto('/inbound-statistics');
  await select(page, 'Số dòng mỗi trang', '10');
  await select(page, 'Sắp xếp theo', 'weight');
  await select(page, 'Thứ tự', 'asc');
  await page.getByLabel('Tìm cửa hàng', { exact: true }).fill('Cửa hàng');
  await page.getByLabel('Tìm mặt hàng', { exact: true }).fill('Mặt hàng');
  const storePager = page.getByRole('navigation', { name: 'Phân trang cửa hàng', exact: true });
  const productPager = page.getByRole('navigation', { name: 'Phân trang mặt hàng', exact: true });
  await storePager.getByRole('button', { name: 'Sau', exact: true }).click();
  await expect(storePager).toContainText('Trang 2/2');
  await expect(productPager).toContainText('14 dòng · Trang 1/2');
  await expect(parentStoreRows(page)).toHaveCount(2);
  const before = await parentSnapshot(page);
  const requestCount = state.requests.length;

  await toggle(page, alpha).click();
  const region = detailRegion(page, alpha);
  await expect(region.locator('tbody > tr')).toHaveCount(10);
  expect(state.requests.slice(requestCount)).toEqual([
    expect.objectContaining({
      storeId: alpha.id,
      pageSize: 10,
      sortBy: 'weight',
      sortDirection: 'asc',
      storePage: 1,
      productPage: 1,
      storeSearch: '',
      productSearch: '',
    }),
  ]);
  const detailPager = region.getByRole('navigation', {
    name: 'Phân trang mặt hàng của cửa hàng ALP',
  });
  await expect(detailPager).toContainText('12 dòng · Trang 1/2');
  await detailPager.getByRole('button', { name: 'Sau', exact: true }).click();
  await expect(detailPager).toContainText('Trang 2/2');
  await expect(region.locator('tbody > tr')).toHaveCount(2);
  expect(state.requests.at(-1)).toMatchObject({ storeId: alpha.id, productPage: 2 });
  expect(await parentSnapshot(page)).toEqual(before);

  await toggle(page, alpha).click();
  await expect(detailRows(page)).toHaveCount(0);
  expect(await parentSnapshot(page)).toEqual(before);
  await toggle(page, alpha).click();
  await expect(detailPager).toContainText('Trang 1/2');

  // Changing any parent control closes the detail; the parent filter logic is unchanged.
  await select(page, 'Chi tiết theo nguồn', 'PARTNER');
  await expect(detailRows(page)).toHaveCount(0);
  await expect(storePager).toContainText('Trang 1/2');
  // Partner weight ascending puts Beta (20 kg) and Alpha (30 kg) on page 2.
  await storePager.getByRole('button', { name: 'Sau', exact: true }).click();
  await expect(storePager).toContainText('Trang 2/2');
  await toggle(page, beta).click();
  await expect(detailRegion(page, beta)).toContainText('Nguồn: Đối tác khác');
  await page.getByLabel('Tìm cửa hàng', { exact: true }).fill('Beta');
  await expect(detailRows(page)).toHaveCount(0);
  await expect(parentStoreRows(page)).toHaveCount(1);

  // The main store dropdown still filters the whole report, as before.
  await page.getByLabel('Tìm cửa hàng', { exact: true }).fill('');
  await storeFilter(page).selectOption(beta.id);
  await expect(page.locator('.inbound-overview')).toContainText('9 bao · 90 kg');
  await expect(parentStoreRows(page)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('late, failed and refreshed detail responses stay in their own scope', async ({ page }) => {
  test.setTimeout(60000);
  const errors = trackErrors(page);
  const { state, hold } = await mockDetailReport(page);
  await page.goto('/inbound-statistics');
  await expect(parentStoreRows(page)).toHaveCount(12);
  const fulfilledFor = (storeId: string) =>
    state.fulfilled.filter((query) => query.storeId === storeId).length;

  // Collapse while loading: the late response must not reopen the panel.
  let release = hold(alpha.id);
  await toggle(page, alpha).click();
  await expect(detailRegion(page, alpha).getByRole('status')).toContainText(
    'Đang tải chi tiết cửa hàng ALP',
  );
  await toggle(page, alpha).click();
  await expect(detailRows(page)).toHaveCount(0);
  release();
  await expect.poll(() => fulfilledFor(alpha.id)).toBe(1);
  await nextFrame(page);
  await expect(detailRows(page)).toHaveCount(0);
  await expect(toggle(page, alpha)).toHaveAttribute('aria-expanded', 'false');

  // A answers after B: B's panel only ever shows B.
  await select(page, 'Chi tiết theo nguồn', 'WAREHOUSE');
  await expect(page.getByRole('combobox', { name: 'Chi tiết theo nguồn' })).toHaveValue(
    'WAREHOUSE',
  );
  release = hold(alpha.id);
  await toggle(page, alpha).click();
  await toggle(page, beta).click();
  const betaRegion = detailRegion(page, beta);
  await expect(betaRegion).toContainText('7 bao · 70 kg');
  release();
  await expect.poll(() => fulfilledFor(alpha.id)).toBe(2);
  await nextFrame(page);
  await expect(detailRows(page)).toHaveCount(1);
  await expect(betaRegion).not.toContainText('SP01');
  await expect(betaRegion.locator('tbody > tr')).toHaveCount(1);

  // A parent change while the detail is loading closes it for good.
  await select(page, 'Thứ tự', 'asc');
  await expect(parentStoreRows(page)).toHaveCount(12);
  release = hold(alpha.id);
  await toggle(page, alpha).click();
  await select(page, 'Sắp xếp theo', 'weight');
  await expect(detailRows(page)).toHaveCount(0);
  release();
  await expect.poll(() => fulfilledFor(alpha.id)).toBe(3);
  await nextFrame(page);
  await expect(detailRows(page)).toHaveCount(0);

  // Error: the store list stays usable, collapse works, retry reloads only the detail.
  await select(page, 'Chi tiết theo nguồn', 'ALL');
  await expect(parentStoreRows(page)).toHaveCount(12);
  state.failStoreId = beta.id;
  await toggle(page, beta).click();
  const alert = betaRegion.getByRole('alert');
  await expect(alert).toContainText('Không tải được chi tiết cửa hàng BET', { timeout: 15000 });
  await expect(parentStoreRows(page)).toHaveCount(12);
  await expect(page.locator('.inbound-results')).not.toHaveAttribute('inert', '');
  await toggle(page, beta).click();
  await expect(detailRows(page)).toHaveCount(0);
  await toggle(page, beta).click();
  await expect(alert).toBeVisible({ timeout: 15000 });
  state.failStoreId = undefined;
  const beforeRetry = state.requests.length;
  await alert.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(betaRegion).toContainText('9 bao · 90 kg');
  expect(state.requests.slice(beforeRetry).map((query) => query.storeId)).toEqual([beta.id]);

  // Làm mới reloads the parent and the open detail in the same scope.
  await toggle(page, alpha).click();
  const alphaRegion = detailRegion(page, alpha);
  await expect(alphaRegion).toContainText('81 bao · 810 kg');
  state.extraAlphaBag = true;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(alphaRegion).toContainText('82 bao · 815 kg');
  await expect(page.locator('.inbound-overview')).toContainText('100 bao · 914 kg');
  await expect(toggle(page, alpha)).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('detail empty, incomplete, source, period and store-kind scopes', async ({ page }) => {
  const errors = trackErrors(page);
  const { state } = await mockDetailReport(page);
  state.incompleteStoreId = alpha.id;
  await page.goto('/inbound-statistics');
  await expect(parentStoreRows(page)).toHaveCount(12);

  await toggle(page, alpha).click();
  const alphaRegion = detailRegion(page, alpha);
  await expect(alphaRegion.getByRole('status')).toContainText('chưa đầy đủ');
  await expect(alphaRegion.getByRole('row', { name: /SP12/ })).toContainText(
    'Đã biết · thiếu dữ liệu',
  );
  await expect(alphaRegion.getByRole('row', { name: /SP12/ })).toContainText('Chưa xác định');
  await expect(alphaRegion.getByRole('row', { name: /SP12/ })).toContainText('14.81%');

  await toggle(page, emptyStore).click();
  const emptyRegion = detailRegion(page, emptyStore);
  await expect(emptyRegion).toContainText(
    'Cửa hàng TRG · Cửa hàng Trống không có dữ liệu nhập trong kỳ',
  );
  await expect(emptyRegion).toContainText('nguồn Tất cả');
  await expect(emptyRegion.locator('table')).toHaveCount(0);
  state.incompleteStoreId = undefined;

  for (const [source, label, total] of [
    ['PARTNER', 'Đối tác khác', '3 bao · 30 kg'],
    ['WAREHOUSE', 'Kho', '78 bao · 780 kg'],
  ] as const) {
    await select(page, 'Chi tiết theo nguồn', source);
    await toggle(page, alpha).click();
    await expect(alphaRegion).toContainText(`Nguồn: ${label}`);
    await expect(alphaRegion).toContainText(total);
    expect(state.requests.at(-1)).toMatchObject({ storeId: alpha.id, source });
  }

  await select(page, 'Loại cửa hàng', 'WHOLESALE');
  await expect(parentStoreRows(page)).toHaveCount(1);
  await toggle(page, beta).click();
  await expect(detailRegion(page, beta)).toContainText('7 bao · 70 kg');
  expect(state.requests.at(-1)).toMatchObject({ storeId: beta.id, storeKind: 'WHOLESALE' });

  await select(page, 'Loại cửa hàng', 'RETAIL');
  await select(page, 'Kỳ thống kê', 'DAY');
  const day = await page.getByLabel('Ngày', { exact: true }).inputValue();
  await toggle(page, alpha).click();
  await expect(alphaRegion).toContainText(`Kỳ: ${day}`);
  const last = state.requests.at(-1)!;
  expect(last).toMatchObject({ storeId: alpha.id, storeKind: 'RETAIL', periodType: 'DAY' });
  expect(last.date).toBe(day);
  expect(last.month).toBeUndefined();
  expect(errors).toEqual([]);
});

test('open detail fits every viewport without page overflow', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const errors = trackErrors(page);
  await mockDetailReport(page);
  await page.goto('/inbound-statistics');
  await select(page, 'Số dòng mỗi trang', '10');
  await toggle(page, alpha).click();
  const region = detailRegion(page, alpha);
  await expect(region.locator('tbody > tr')).toHaveCount(10);
  for (const width of [360, 390, 412, 768, 1366, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await storeTable(page).evaluate((element) => {
      element.scrollLeft = 0;
    });
    await region.scrollIntoViewIfNeeded();
    const box = (await region.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    const pager = region.getByRole('navigation');
    const parts = await pager
      .locator(':scope > *')
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect),
      );
    for (const [index, a] of parts.entries())
      for (const b of parts.slice(index + 1))
        expect(
          a.right <= b.left + 0.5 ||
            b.right <= a.left + 0.5 ||
            a.bottom <= b.top + 0.5 ||
            b.bottom <= a.top + 0.5,
          `pager items overlap at ${width}px`,
        ).toBe(true);
    await pager.getByRole('button', { name: 'Sau', exact: true }).click({ trial: true });
    await toggle(page, alpha).click({ trial: true });
    if ([390, 1440].includes(width)) {
      await storeRow(page, alpha).evaluate((row) => row.scrollIntoView({ block: 'center' }));
      await page.screenshot({
        path: testInfo.outputPath(`inbound-detail-open-${width}.png`),
        animations: 'disabled',
      });
      await page.screenshot({
        path: testInfo.outputPath(`inbound-detail-open-${width}-full.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
  }
  expect(errors).toEqual([]);
});

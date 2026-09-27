import { expect, test } from '@playwright/test';
import { InboundStatisticsQuerySchema } from '@idosi/contracts';
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
test('Admin filters, source breakdown, charts, retry and responsive tables', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/auth/session', (route) =>
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

import { expect, test } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-09-20T18:30:00.000Z';
const pagination = { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };
const products = [
  { id: id(1), name: 'Đầm', status: 'ACTIVE' },
  {
    id: id(2),
    name: 'Quần dài nữ — mặt hàng ngừng hoạt động vẫn hiển thị đầy đủ trong lịch sử nhập',
    status: 'INACTIVE',
  },
].map((product, index) => ({
  ...product,
  sku: `TEST-${index}`,
  measurement: 'UNIT',
  unitLabel: 'cái',
  createdAt: timestamp,
  updatedAt: timestamp,
}));
const receipt = {
  id: id(3),
  referenceCode: 'PN00001-21/09/2026',
  supplierName: 'Nhà cung cấp kiểm thử lịch sử',
  status: 'COST_PENDING',
  totalWeightKg: null,
  cost: null,
  version: 1,
  receivedByAccountId: id(4),
  receivedByDisplayName: 'Người nhập khác người xem',
  receivedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  bags: [id(1), id(1), id(2)].map((productId, index) => ({
    id: id(10 + index),
    receiptId: id(3),
    productId,
    bagCode: `TEST-${index}`,
    weightKg: null,
    createdAt: timestamp,
  })),
};

test('inbound history preserves product details, required markers and compact responsive layout', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        data: {
          id: id(5),
          createdAt: timestamp,
          lastSeenAt: timestamp,
          expiresAt: '2099-09-20T18:30:00.000Z',
          principal: {
            accountId: id(4),
            assignedStoreIds: [],
            displayName: 'Admin kiểm thử',
            role: 'ADMIN',
            status: 'ACTIVE',
            storeId: null,
            username: 'admin.test',
          },
        },
      },
    }),
  );
  await page.route('**/api/v1/products?*', (route) =>
    route.fulfill({ json: { data: products, pagination: { ...pagination, totalItems: 2 } } }),
  );
  await page.route('**/api/v1/product-conversions?*', (route) =>
    route.fulfill({
      json: { data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } },
    }),
  );
  await page.route('**/api/v1/inbound-receipts?*', (route) =>
    route.fulfill({ json: { data: [receipt], pagination } }),
  );
  await page.goto('/warehouse-inbound');
  const card = page.locator('.document-history');
  await expect(card).toContainText('Đầm');
  await expect(card).toContainText(products[1].name);
  await expect(card.locator('tbody tr')).toHaveCount(2);
  await expect(card.locator('tbody tr').first().locator('td').nth(4)).toHaveText('2');
  await expect(card.locator('tbody tr').first().locator('td').nth(5)).toHaveText('3');
  await expect(card.locator('tbody tr').first().locator('td').nth(0)).toHaveText(
    '01:30:00 21/09/2026',
  );
  await expect(card).toContainText('Người nhập khác người xem');
  await expect(card.locator('tbody [rowspan="2"]')).toHaveCount(5);
  await expect(page.getByLabel('Nhà cung cấp', { exact: true })).toHaveAttribute('required', '');
  await expect(
    page
      .locator('label')
      .filter({ has: page.getByLabel('Nhà cung cấp', { exact: true }) })
      .locator('.inbound-required'),
  ).toHaveText('*');
  await expect(page.getByLabel(/Khối lượng/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Đầm', exact: true }).check();
  await expect(page.getByRole('spinbutton')).toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'Tăng số bao Đầm' }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  await page.getByRole('button', { name: 'Giảm số bao Đầm' }).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Giảm số bao Đầm' })).toBeDisabled();
  // VAT moved to HTKD's store receipt review; the warehouse receipt has no VAT entry.
  await expect(page.getByLabel(/VAT/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /VAT/ })).toHaveCount(0);
  await expect(card.getByText(/Cập nhật VAT/)).toHaveCount(0);
  await expect(page.getByText('Chốt chi phí theo hóa đơn', { exact: true })).toHaveCount(0);
  for (const width of [360, 375, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(card).toHaveCSS('overflow-x', 'auto');
    expect((await card.boundingBox())!.width).toBeLessThanOrEqual(width);
    const firstRow = card.locator('tbody tr').first();
    const nameBox = (await firstRow.locator('td').nth(3).boundingBox())!;
    const quantityBox = (await firstRow.locator('td').nth(4).boundingBox())!;
    expect(Math.abs(nameBox.y - quantityBox.y)).toBeLessThan(2);
    if ([375, 768, 1440].includes(width)) {
      await card.screenshot({ path: testInfo.outputPath(`inbound-history-${width}.png`) });
    }
  }
  await page.route('**/api/v1/inbound-receipts?*', (route) =>
    route.fulfill({
      json: { data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } },
    }),
  );
  await page.getByRole('button', { name: 'Làm mới phiếu nhập' }).click();
  await expect(page.getByText('Chưa có phiếu nhập.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

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
  const card = page.locator('.inbound-receipt');
  await expect(card).toContainText('Đầm');
  await expect(card).toContainText(products[1].name);
  await expect(card.getByRole('row', { name: 'Đầm 2 bao' })).toBeVisible();
  await expect(card.getByRole('row', { name: 'Tổng · 2 mặt hàng 3 bao' })).toBeVisible();
  await expect(card.locator('time')).toContainText('01:30');
  await expect(card.locator('time')).toContainText('21/09/2026');
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
  await card.getByText('Cập nhật VAT · 8%', { exact: true }).click();
  await card.getByText('Chốt chi phí theo hóa đơn', { exact: true }).click();
  await expect(card.locator('.inbound-required')).toHaveCount(5);
  for (const width of [360, 375, 390, 412, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const firstRow = card.locator('tbody tr').first();
    const nameBox = (await firstRow.locator('th').boundingBox())!;
    const quantityBox = (await firstRow.locator('td').boundingBox())!;
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

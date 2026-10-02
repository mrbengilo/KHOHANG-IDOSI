import type { Page } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timestamp = '2026-09-27T03:00:00.000Z';
const pagination = (count: number) => ({
  page: 1,
  pageSize: 50,
  totalItems: count,
  totalPages: count ? 1 : 0,
});
export const layoutProducts = Array.from({ length: 24 }, (_, index) => ({
  id: id(index + 10),
  name: `Áo khoác nữ dài tay chất liệu cotton — mặt hàng kiểm thử ${index + 1}`,
  sku: `LAYOUT-${index + 1}`,
  measurement: 'UNIT',
  unitLabel: 'cái',
  status: 'ACTIVE',
  createdAt: timestamp,
  updatedAt: timestamp,
}));

export async function mockLayoutData(page: Page) {
  await page.route('**/api/v1/products?*', (route) =>
    route.fulfill({ json: { data: layoutProducts, pagination: pagination(24) } }),
  );
  await page.route('**/api/v1/product-conversions?*', (route) =>
    route.fulfill({ json: { data: [], pagination: pagination(0) } }),
  );
  await page.route('**/api/v1/warehouse-inventory?*', (route) =>
    route.fulfill({
      json: {
        data: layoutProducts.map((product) => ({
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          onHandBags: 1234567,
          reservedBags: 123,
          availableBags: 1234444,
          dispatchedBags: 987654,
          balanceVersion: 3,
          productActive: true,
        })),
        pagination: pagination(24),
      },
    }),
  );
  await page.route('**/api/v1/inbound-receipts?*', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: id(100),
            referenceCode: 'PN00001-27/09/2026',
            supplierName:
              'Nhà cung cấp hàng may mặc tại Thành phố Hồ Chí Minh — tên dài để kiểm tra bố cục',
            status: 'COST_PENDING',
            totalWeightKg: null,
            cost: null,
            version: 1,
            receivedByAccountId: id(2),
            receivedByDisplayName: 'Người nhập kiểm thử',
            receivedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
            bags: layoutProducts.slice(0, 4).map((product, index) => ({
              id: id(110 + index),
              receiptId: id(100),
              productId: product.id,
              bagCode: `LAYOUT-${index}`,
              weightKg: null,
              createdAt: timestamp,
            })),
          },
        ],
        pagination: pagination(1),
      },
    }),
  );
}

/** Admin session payload as returned by `/auth/session` and `/auth/login`. */
export function layoutAdminSession(displayName = 'Layout test') {
  return {
    id: id(1),
    createdAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: '2099-09-27T03:00:00.000Z',
    principal: {
      accountId: id(2),
      assignedStoreIds: [],
      displayName,
      role: 'ADMIN',
      status: 'ACTIVE',
      storeId: null,
      username: 'layout.test',
    },
  };
}

export async function mockLayoutAdmin(page: Page, displayName?: string) {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { data: layoutAdminSession(displayName) } }),
  );
  await mockLayoutData(page);
}

import { expect, test, type Page } from '@playwright/test';

const mockGroup = {
  code: 'MIEN_NAM',
  createdAt: '2026-09-17T00:00:00.000Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Miền Nam',
  status: 'ACTIVE',
  updatedAt: '2026-09-17T00:00:00.000Z',
  version: 1,
} as const;

const mockStore = {
  address: 'Quận 1, TP.HCM',
  code: 'DS_Q1',
  createdAt: '2026-09-17T00:00:00.000Z',
  groupId: mockGroup.id,
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'RETAIL',
  name: 'DS Quận 1',
  status: 'ACTIVE',
  updatedAt: '2026-09-17T00:00:00.000Z',
  version: 2,
} as const;

async function mockStoreLifecycle(page: Page) {
  await page.route('**/api/v1/auth/session', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        data: {
          createdAt: '2026-09-17T00:00:00.000Z',
          expiresAt: '2099-09-17T00:00:00.000Z',
          id: '33333333-3333-4333-8333-333333333333',
          lastSeenAt: '2026-09-17T00:00:00.000Z',
          principal: {
            accountId: '44444444-4444-4444-8444-444444444444',
            assignedStoreIds: [],
            displayName: 'Admin UI',
            role: 'ADMIN',
            status: 'ACTIVE',
            storeId: null,
            username: 'admin.ui',
          },
        },
      },
    }),
  );
  await page.route('**/api/v1/store-groups?*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        data: [mockGroup],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      },
    }),
  );
  await page.route('**/api/v1/stores?*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        data: [mockStore],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      },
    }),
  );
}

test('admin can review the dashboard and updated product catalog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Tổng quan/i })).toBeVisible();

  await page.getByRole('link', { name: 'Danh mục & quy đổi' }).click();
  await expect(page.getByRole('heading', { name: 'Danh mục & quy đổi bán hàng' })).toBeVisible();
  await expect(page.getByText('25/25 mặt hàng')).toBeVisible();
  await expect(page.getByText('1 cái × 3 = 3,000 kg')).toBeVisible();
});

test('catalog dialog traps focus, closes with Escape, and restores its trigger', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/catalog');
  const trigger = page.getByRole('button', { exact: true, name: 'Thêm mặt hàng' }).first();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Thêm mặt hàng và hệ số' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Mã SKU')).toBeFocused();

  const closeButton = dialog.getByRole('button', { name: 'Đóng' });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: /Lưu phiên bản/ })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('mobile navigation remains usable at 390px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await page.goto('/');
  await page.getByRole('button', { name: 'Mở menu' }).click();
  const primaryNavigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
  await expect(primaryNavigation).toBeVisible();
  await primaryNavigation.getByRole('link', { name: 'Đặt hàng' }).click();
  await expect(
    page.getByRole('heading', { exact: true, name: 'Đặt hàng & kết quả' }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);

  const undersizedTargets = await page
    .locator('button:visible, a:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width < 44 || box.height < 44),
    );
  expect(undersizedTargets).toEqual([]);
});

test('store administration stays responsive with visible button feedback at 390px', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await mockStoreLifecycle(page);
  await page.goto('/stores');

  await expect(page.getByRole('heading', { name: 'Cửa hàng & nhóm' })).toBeVisible();
  await expect(page.getByText('DS_Q1')).toBeVisible();
  const addGroup = page.getByRole('button', { name: 'Thêm nhóm' });
  expect(
    await addGroup.evaluate((element) => getComputedStyle(element).transitionProperty),
  ).toContain('transform');
  await addGroup.click();
  await expect(page.locator('#store-group-editor')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);

  const undersizedTargets = await page
    .locator('button:visible, a:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width < 44 || box.height < 44),
    );
  expect(undersizedTargets).toEqual([]);
});

test('wholesale routes fail closed for retail-only operations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/');
  await page.getByLabel('Chế độ kiểm thử vai trò').selectOption('STORE_WHOLESALE');
  await expect(page.getByRole('heading', { name: 'Tổng quan khách sỉ' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Nhận hàng' })).toHaveCount(0);

  await page.goto('/receive');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Tổng quan khách sỉ' })).toBeVisible();
});

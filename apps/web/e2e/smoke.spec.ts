import { expect, test, type Page } from '@playwright/test';

const mockGroup = {
  code: 'MIEN_NAM',
  createdAt: '2026-09-17T00:00:00.000Z',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'NhomCuaHangMienNamKhongCoKhoangTrangDeKiemTraXuongDong',
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
  name: 'CuaHangQuanMotKhongCoKhoangTrangDeKiemTraXuongDongAnToan',
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
  await expect(page.getByText('1 cái × 3 = 3 kg')).toBeVisible();
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

  const requiredLabels = dialog.locator('label:has(:required) > .field-label');
  expect(await requiredLabels.count()).toBeGreaterThan(0);
  for (const label of await requiredLabels.all()) {
    const marker = await label.evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return { content: style.content, color: style.color };
    });
    expect(marker.content).toContain('*');
    expect(marker.color).not.toBe(
      await label.evaluate((element) => getComputedStyle(element).color),
    );
  }
  // Markers follow native validity, including fields that become optional.
  const skuInput = dialog.getByLabel('Mã SKU');
  await skuInput.evaluate((element: HTMLInputElement) => {
    element.required = false;
  });
  await expect(
    dialog.locator('label:has(input:not(:required)) > .field-label').first(),
  ).toBeVisible();
  expect(
    await skuInput.evaluate(
      (element) =>
        getComputedStyle(element.closest('label')!.querySelector('.field-label')!, '::after')
          .content,
    ),
  ).not.toContain('*');
  await skuInput.evaluate((element: HTMLInputElement) => {
    element.required = true;
  });

  const controls = dialog.locator('button, input, select, textarea');
  await controls.evaluateAll((elements) => {
    elements.forEach((element) => {
      (
        element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      ).disabled = true;
    });
  });
  await page.keyboard.press('Tab');
  await expect(dialog).toBeFocused();
  await controls.evaluateAll((elements) => {
    elements.forEach((element) => {
      (
        element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      ).disabled = false;
    });
  });
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: /Lưu phiên bản/ })).toBeFocused();

  const closeButton = dialog.getByRole('button', { name: 'Đóng' });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: /Lưu phiên bản/ })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('catalog dialog restores focus to the page heading after its trigger is removed', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only assertion');
  await page.goto('/catalog');
  await page.getByRole('button', { exact: true, name: 'Ngừng hệ số' }).first().click();

  const dialog = page.getByRole('dialog', { name: /Ngừng hệ số của/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Xác nhận ngừng' }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Danh mục & quy đổi bán hàng' }),
  ).toBeFocused();
});

test('mobile navigation remains usable at 390px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await page.addInitScript(() => localStorage.setItem('idosi-demo-role:v2', 'HTKD'));
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

test('store administration stays responsive with visible button feedback at 390px and 360px', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'mobile-only assertion');
  await mockStoreLifecycle(page);
  await page.goto('/stores');

  await expect(page.getByRole('heading', { name: 'Cửa hàng & nhóm' })).toBeVisible();
  await expect(page.getByText('DS_Q1')).toBeVisible();
  const addGroup = page.getByRole('button', { name: 'Thêm nhóm' });
  const addStore = page.getByRole('button', { name: 'Thêm cửa hàng' });
  await expect(addGroup).toBeVisible();
  await expect(addStore).toBeVisible();
  expect(
    await addGroup.evaluate((element) => getComputedStyle(element).transitionProperty),
  ).toContain('transform');
  await addGroup.click();
  await expect(page.locator('#store-group-editor')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.setViewportSize({ width: 360, height: 800 });
  await expect(addGroup).toBeVisible();
  await expect(addStore).toBeVisible();

  const [addGroupBox, addStoreBox] = await Promise.all([
    addGroup.boundingBox(),
    addStore.boundingBox(),
  ]);
  expect(addGroupBox).not.toBeNull();
  expect(addStoreBox).not.toBeNull();
  expect(addGroupBox!.x).toBeGreaterThanOrEqual(0);
  expect(addStoreBox!.x).toBeGreaterThanOrEqual(0);
  expect(addGroupBox!.x + addGroupBox!.width).toBeLessThanOrEqual(360);
  expect(addStoreBox!.x + addStoreBox!.width).toBeLessThanOrEqual(360);
  expect(addStoreBox!.y).toBeGreaterThanOrEqual(addGroupBox!.y + addGroupBox!.height);

  const unbrokenNames = page
    .locator('.store-lifecycle-table strong')
    .filter({ hasText: /KhongCoKhoangTrangDeKiemTraXuongDong/ });
  await expect(unbrokenNames).toHaveCount(3);
  const overflowingNames = await unbrokenNames.evaluateAll((elements) =>
    elements.filter((element) => element.scrollWidth > element.clientWidth),
  );
  expect(overflowingNames).toEqual([]);
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

  await page.getByRole('button', { name: 'Đóng biểu mẫu' }).click();
  await page.getByRole('button', { name: `Chỉnh sửa cửa hàng ${mockStore.code}` }).click();
  const storeEditor = page.locator('#store-editor');
  await expect(storeEditor).toBeInViewport();
  await expect(storeEditor.getByLabel('Tên cửa hàng')).toBeFocused();
  await storeEditor.getByLabel('Trạng thái').selectOption('INACTIVE');
  const dangerousSave = storeEditor.getByRole('button', { name: 'Xác nhận ngừng' });
  await expect(dangerousSave).toHaveClass(/button--danger/u);
  const dismissedConfirmation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain(mockStore.code);
    await dialog.dismiss();
  });
  await dangerousSave.click();
  await dismissedConfirmation;
  await expect(storeEditor).toBeVisible();
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

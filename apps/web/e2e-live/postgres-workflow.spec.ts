import { expect, test, type Page } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:3100';
const adminUsername = process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin';
const adminPassword =
  process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production';
const runSuffix = (process.env.LIVE_E2E_RUN_SUFFIX ?? 'local').replace(/[^A-Za-z0-9.-]/gu, '-');

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Đăng nhập Kho hàng IDOSI' })).toBeVisible();
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu').fill(password);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/auth/login` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
}

test('production UI persists operations in PostgreSQL and enforces the store role', async ({
  page,
}, testInfo) => {
  await login(page, adminUsername, adminPassword);
  await expect(page.getByRole('heading', { name: 'Tổng quan điều hành' })).toBeVisible();
  await expect(page.getByLabel('Chế độ kiểm thử vai trò')).toHaveCount(0);

  const allocationResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.request().method() === 'GET',
  );
  await page.getByRole('link', { name: 'Phân bổ hàng hóa' }).click();
  const allocationResponse = await allocationResponsePromise;
  expect(allocationResponse.status()).toBe(200);
  const allocationPayload = (await allocationResponse.json()) as { data: unknown[] };
  expect(allocationPayload.data.length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Giám sát phân bổ hàng hóa' })).toBeVisible();
  const allocationResults = page.getByRole('region', { name: 'Kết quả phân bổ đã lưu' });
  await expect(allocationResults.getByRole('table')).toBeVisible();
  await expect(
    allocationResults.getByText('ALLOCATED_BY_PRIORITY_ROUND_ROBIN').first(),
  ).toBeVisible();

  const createSessionButton = page.getByRole('button', { name: 'Tạo phiên mới' });
  expect(
    await createSessionButton.evaluate((element) => getComputedStyle(element).transitionProperty),
  ).toContain('transform');
  await createSessionButton.hover();
  await expect
    .poll(() => createSessionButton.evaluate((element) => getComputedStyle(element).boxShadow))
    .not.toBe('none');
  await createSessionButton.click();

  const businessDate = `2099-12-${String(20 + testInfo.retry).padStart(2, '0')}`;
  const sessionForm = page.locator('.allocation-session-form');
  await sessionForm.getByLabel('Ngày nghiệp vụ').fill(businessDate);
  await sessionForm.getByLabel('Mở nhận đơn').fill('00:00');
  await sessionForm.getByLabel('Đóng nhận đơn / snapshot').fill('08:00');
  await sessionForm.getByLabel('Bắt đầu phân bổ').fill('09:00');
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/order-sessions` &&
      response.request().method() === 'POST',
  );
  await sessionForm.getByRole('button', { name: 'Tạo phiên đã lên lịch' }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  await expect(page.getByText(`Đã tạo phiên ngày ${businessDate}`)).toBeVisible();

  const sessionRow = page.getByRole('row').filter({ hasText: businessDate });
  await expect(sessionRow.getByText('Đã lên lịch')).toBeVisible();
  const scopedResultsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.url().includes('sessionId=') &&
      response.request().method() === 'GET',
  );
  await sessionRow.getByRole('button', { name: `Xem kết quả phiên ${businessDate}` }).click();
  expect((await scopedResultsPromise).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Kết quả phân bổ đã lưu' })).toBeFocused();
  await expect(page.getByText('Chưa có kết quả phân bổ phù hợp')).toBeVisible();
  await sessionRow.getByRole('button', { name: 'Hủy phiên' }).click();
  const cancellationForm = page.locator('.allocation-cancel-form');
  await cancellationForm
    .getByLabel('Lý do hủy')
    .fill('Kiểm thử live UI, API và PostgreSQL trong CI');
  const cancelResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/transition') && response.request().method() === 'POST',
  );
  await cancellationForm.getByRole('button', { name: 'Xác nhận hủy phiên' }).click();
  expect((await cancelResponsePromise).status()).toBe(200);
  await expect(sessionRow.getByText('Đã hủy')).toBeVisible();

  const persistedSessions = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/order-sessions?dateFrom=${businessDate}&dateTo=${businessDate}&page=1&pageSize=20`,
    );
  expect(persistedSessions.status()).toBe(200);
  const persistedPayload = (await persistedSessions.json()) as {
    data: Array<{ businessDate: string; status: string }>;
  };
  expect(persistedPayload.data).toContainEqual(
    expect.objectContaining({ businessDate, status: 'CANCELLED' }),
  );

  await page.getByRole('link', { name: 'Tài khoản' }).click();
  await expect(page.getByRole('heading', { name: 'Tài khoản & phân quyền' })).toBeVisible();
  await page.getByRole('button', { name: 'Thêm tài khoản' }).click();
  const accountForm = page.locator('#admin-create-account');
  const storeUsername = `live.store.${runSuffix}.${testInfo.retry}`.slice(0, 80);
  const storePassword = 'Live-store-password-2026!';
  await accountForm.getByLabel('Tên đăng nhập').fill(storeUsername);
  await accountForm.getByLabel('Tên hiển thị').fill('Live PostgreSQL Store');
  await accountForm.getByLabel('Vai trò').selectOption('STORE');
  await accountForm.getByLabel('Cửa hàng').selectOption({ label: 'DS_BMT · DS BMT' });
  await accountForm.getByLabel('Mật khẩu ban đầu').fill(storePassword);
  await accountForm.getByLabel('Nhập lại mật khẩu').fill(storePassword);
  const accountResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/admin/accounts` &&
      response.request().method() === 'POST',
  );
  await accountForm.getByRole('button', { exact: true, name: 'Tạo tài khoản' }).click();
  expect((await accountResponsePromise).status()).toBe(201);
  await expect(page.getByText(`Đã tạo tài khoản ${storeUsername}.`)).toBeVisible();

  const logoutResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/auth/logout` &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  expect((await logoutResponsePromise).status()).toBe(200);
  await login(page, storeUsername, storePassword);
  await expect(page.getByRole('heading', { name: 'Tổng quan cửa hàng' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tài khoản' })).toHaveCount(0);

  const forbiddenAdminApi = await page
    .context()
    .request.get(`${apiOrigin}/api/v1/admin/accounts?page=1&pageSize=20`);
  expect(forbiddenAdminApi.status()).toBe(403);
  await page.goto('/users');
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole('heading', { name: 'Tổng quan cửa hàng' })).toBeVisible();
});

test('production allocation results remain usable at 390px', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await login(page, adminUsername, adminPassword);
  const initialResultsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.request().method() === 'GET',
  );
  await page.goto('/allocations');
  expect((await initialResultsPromise).status()).toBe(200);

  const allocationResults = page.getByRole('region', { name: 'Kết quả phân bổ đã lưu' });
  await expect(allocationResults).toBeVisible();
  const filteredResultsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.url().includes('status=ALLOCATED') &&
      response.request().method() === 'GET',
  );
  await allocationResults.getByLabel('Lọc kết quả theo trạng thái').selectOption('ALLOCATED');
  expect((await filteredResultsPromise).status()).toBe(200);
  await expect(allocationResults.locator('.badge').filter({ hasText: 'Đã cấp đủ' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth))
    .toBe(true);

  const undersizedTargets = await allocationResults
    .locator('button:visible, select:visible')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width < 44 || box.height < 44),
    );
  expect(undersizedTargets).toEqual([]);
});

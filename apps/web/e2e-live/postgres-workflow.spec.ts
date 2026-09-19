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

function hoChiMinhBusinessDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to resolve the Ho Chi Minh business date');
  return `${year}-${month}-${day}`;
}

async function ensureOpenOrderSession(page: Page): Promise<string> {
  const businessDate = hoChiMinhBusinessDate();
  const existingResponse = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/order-sessions?dateFrom=${businessDate}&dateTo=${businessDate}&page=1&pageSize=20`,
    );
  expect(existingResponse.status()).toBe(200);
  const existing = (await existingResponse.json()) as {
    data: Array<{ id: string; status: string; version: number }>;
  };
  const openSession = existing.data.find((session) => session.status === 'OPEN');
  if (openSession) return openSession.id;

  let targetSession = existing.data.find((session) => session.status === 'SCHEDULED');
  if (!targetSession) {
    const createResponse = await page.context().request.post(`${apiOrigin}/api/v1/order-sessions`, {
      data: {
        allocationStartsAt: `${businessDate}T23:59:59+07:00`,
        businessDate,
        requestClosesAt: `${businessDate}T23:59:58+07:00`,
        requestOpensAt: `${businessDate}T00:00:00+07:00`,
      },
      headers: { 'idempotency-key': `live-open-session-${runSuffix}` },
    });
    expect([200, 201]).toContain(createResponse.status());
    const created = (await createResponse.json()) as {
      data: { id: string; status: string; version: number };
    };
    if (created.data.status === 'OPEN') return created.data.id;
    targetSession = created.data;
  }

  const openResponse = await page
    .context()
    .request.post(`${apiOrigin}/api/v1/order-sessions/${targetSession.id}/transition`, {
      data: { expectedVersion: targetSession.version, status: 'OPEN' },
      headers: { 'idempotency-key': `live-open-session-transition-${runSuffix}` },
    });
  expect(openResponse.status()).toBe(200);
  const opened = (await openResponse.json()) as { data: { id: string; status: string } };
  expect(opened.data.status).toBe('OPEN');
  return opened.data.id;
}

test('production UI persists operations in PostgreSQL and enforces the store role', async ({
  page,
}, testInfo) => {
  await login(page, adminUsername, adminPassword);
  await expect(page.getByRole('heading', { name: 'Tổng quan điều hành' })).toBeVisible();
  await expect(page.getByLabel('Chế độ kiểm thử vai trò')).toHaveCount(0);

  await page.getByRole('link', { name: 'Cửa hàng & nhóm' }).click();
  await expect(page.getByRole('heading', { name: 'Cửa hàng & nhóm' })).toBeVisible();
  const lifecycleToken = `${runSuffix}-${testInfo.retry}-${Date.now().toString(36)}`
    .replace(/[^A-Za-z0-9]/gu, '')
    .slice(-16)
    .toUpperCase();
  const groupCode = `E2E_G_${lifecycleToken}`;
  const storeCode = `E2E_S_${lifecycleToken}`;
  const groupName = `Nhóm live ${lifecycleToken}`;
  const updatedGroupName = `${groupName} mới`;
  const storeName = `Cửa hàng live ${lifecycleToken}`;
  const updatedStoreName = `${storeName} mới`;
  const addGroupButton = page.getByRole('button', { name: 'Thêm nhóm' });
  expect(
    await addGroupButton.evaluate((element) => getComputedStyle(element).transitionProperty),
  ).toContain('transform');
  await addGroupButton.click();
  const groupEditor = page.locator('#store-group-editor');
  await groupEditor.getByLabel('Mã nhóm').fill(groupCode);
  await groupEditor.getByLabel('Tên nhóm').fill(groupName);
  const createGroupResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/store-groups' &&
      response.request().method() === 'POST',
  );
  await groupEditor.getByRole('button', { name: 'Tạo nhóm' }).click();
  expect((await createGroupResponse).status()).toBe(201);
  await expect(page.getByText(`Đã tạo nhóm ${groupCode}.`)).toBeVisible();

  let groupRow = page.getByRole('row').filter({ hasText: groupCode });
  await groupRow.getByRole('button', { name: `Chỉnh sửa nhóm ${groupCode}` }).click();
  await page.locator('#store-group-editor').getByLabel('Tên nhóm').fill(updatedGroupName);
  const updateGroupResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/store-groups/') &&
      response.request().method() === 'PATCH',
  );
  await page.locator('#store-group-editor').getByRole('button', { name: 'Lưu thay đổi' }).click();
  expect((await updateGroupResponse).status()).toBe(200);
  await expect(page.getByText(`Đã cập nhật nhóm ${groupCode} lên phiên bản 1.`)).toBeVisible();

  await page.getByRole('button', { name: 'Thêm cửa hàng' }).click();
  const storeEditor = page.locator('#store-editor');
  await storeEditor.getByLabel('Mã cửa hàng').fill(storeCode);
  await storeEditor.getByLabel('Tên cửa hàng').fill(storeName);
  await storeEditor.getByLabel('Nhóm cửa hàng').selectOption({
    label: `${groupCode} · ${updatedGroupName}`,
  });
  await storeEditor.getByLabel('Địa chỉ').fill('390 Responsive Street');
  const createStoreResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/stores' &&
      response.request().method() === 'POST',
  );
  await storeEditor.getByRole('button', { name: 'Tạo cửa hàng' }).click();
  expect((await createStoreResponse).status()).toBe(201);
  await expect(page.getByText(`Đã tạo cửa hàng ${storeCode}.`)).toBeVisible();

  let storeRow = page.getByRole('row').filter({ hasText: storeCode });
  await storeRow.getByRole('button', { name: `Chỉnh sửa cửa hàng ${storeCode}` }).click();
  await page.locator('#store-editor').getByLabel('Tên cửa hàng').fill(updatedStoreName);
  const updateStoreResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/stores/') &&
      response.request().method() === 'PATCH',
  );
  await page.locator('#store-editor').getByRole('button', { name: 'Lưu thay đổi' }).click();
  expect((await updateStoreResponse).status()).toBe(200);
  await expect(page.getByText(`Đã cập nhật cửa hàng ${storeCode} lên phiên bản 1.`)).toBeVisible();

  storeRow = page.getByRole('row').filter({ hasText: storeCode });
  const disableStoreResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/stores/') &&
      response.request().method() === 'PATCH',
  );
  const confirmStoreDeactivation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain(storeCode);
    await dialog.accept();
  });
  await storeRow.getByRole('button', { name: `Ngừng cửa hàng ${storeCode}` }).click();
  await confirmStoreDeactivation;
  expect((await disableStoreResponse).status()).toBe(200);
  await expect(page.getByText(`Cửa hàng ${storeCode}: ngừng hoạt động.`)).toBeVisible();

  groupRow = page.getByRole('row').filter({ hasText: groupCode });
  const disableGroupResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/store-groups/') &&
      response.request().method() === 'PATCH',
  );
  const confirmGroupDeactivation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain(groupCode);
    await dialog.accept();
  });
  await groupRow.getByRole('button', { name: `Ngừng nhóm ${groupCode}` }).click();
  await confirmGroupDeactivation;
  expect((await disableGroupResponse).status()).toBe(200);
  await expect(page.getByText(`Nhóm ${groupCode}: ngừng hoạt động.`)).toBeVisible();

  const persistedGroupsResponse = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/store-groups?page=1&pageSize=20&search=${encodeURIComponent(groupCode)}`,
    );
  expect(persistedGroupsResponse.status()).toBe(200);
  const persistedGroups = (await persistedGroupsResponse.json()) as {
    data: Array<{ code: string; name: string; status: string; version: number }>;
  };
  expect(persistedGroups.data).toContainEqual(
    expect.objectContaining({
      code: groupCode,
      name: updatedGroupName,
      status: 'INACTIVE',
      version: 2,
    }),
  );
  const persistedStoresResponse = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/stores?page=1&pageSize=20&search=${encodeURIComponent(storeCode)}`,
    );
  expect(persistedStoresResponse.status()).toBe(200);
  const persistedStores = (await persistedStoresResponse.json()) as {
    data: Array<{ code: string; name: string; status: string; version: number }>;
  };
  expect(persistedStores.data).toContainEqual(
    expect.objectContaining({
      code: storeCode,
      name: updatedStoreName,
      status: 'INACTIVE',
      version: 2,
    }),
  );

  const allocationResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.request().method() === 'GET',
  );
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('link', { name: 'Phân bổ hàng hóa' })
    .click();
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
  const sessionResultsButton = sessionRow.getByRole('button', {
    name: `Xem kết quả phiên ${businessDate}`,
  });
  await sessionResultsButton.click();
  expect((await scopedResultsPromise).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Kết quả phân bổ đã lưu' })).toBeFocused();
  await expect(page.getByText('Chưa có kết quả phân bổ phù hợp')).toBeVisible();
  const repeatedScopedResultsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.url().includes('sessionId=') &&
      response.request().method() === 'GET',
  );
  await sessionResultsButton.click();
  expect((await repeatedScopedResultsPromise).status()).toBe(200);
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
  const htkdForm = page.locator('#admin-create-account');
  const htkdUsername = `live.htkd.${runSuffix}.${testInfo.retry}`.slice(0, 80);
  const htkdPassword = 'Live-htkd-password-2026!';
  await htkdForm.getByLabel('Tên đăng nhập').fill(htkdUsername);
  await htkdForm.getByLabel('Tên hiển thị').fill('Live PostgreSQL HTKD');
  await htkdForm.getByLabel('Vai trò').selectOption('HTKD');
  await htkdForm.getByLabel('Mật khẩu ban đầu').fill(htkdPassword);
  await htkdForm.getByLabel('Nhập lại mật khẩu').fill(htkdPassword);
  const htkdResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/admin/accounts` &&
      response.request().method() === 'POST',
  );
  await htkdForm.getByRole('button', { exact: true, name: 'Tạo tài khoản' }).click();
  const htkdResponse = await htkdResponsePromise;
  expect(htkdResponse.status()).toBe(201);
  const htkdAccount = (await htkdResponse.json()) as { data: { id: string } };
  const htkdRow = page.getByRole('row').filter({ hasText: htkdUsername });
  await expect(htkdRow).toBeVisible();
  await htkdRow.getByRole('button', { name: 'Phân công cửa hàng' }).click();
  await expect(page.getByRole('heading', { name: 'Phân công cửa hàng HTKD' })).toBeVisible();
  await page.getByRole('checkbox', { name: /DS_BMT/u }).check();
  await page.getByRole('checkbox', { name: /DS_CT/u }).check();
  await page.getByLabel('Lý do thay đổi').fill('Kiểm thử phân công HTKD với PostgreSQL');
  const assignResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/admin/accounts/${htkdAccount.data.id}/assignments`) &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Lưu phân công' }).click();
  expect((await assignResponsePromise).status()).toBe(200);
  await expect(page.getByText('Đã lưu 2 cửa hàng đang phụ trách.')).toBeVisible();

  const persistedAssignments = await page
    .context()
    .request.get(`${apiOrigin}/api/v1/admin/accounts/${htkdAccount.data.id}/assignments`);
  expect(persistedAssignments.status()).toBe(200);
  const persistedAssignmentPayload = (await persistedAssignments.json()) as {
    data: { assignments: Array<{ storeId: string }> };
  };
  expect(persistedAssignmentPayload.data.assignments).toHaveLength(2);

  await page.getByRole('button', { name: 'Bỏ chọn tất cả' }).click();
  await page.getByLabel('Lý do thay đổi').fill('Thu hồi toàn bộ phạm vi kiểm thử');
  const clearResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/admin/accounts/${htkdAccount.data.id}/assignments`) &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Lưu phân công' }).click();
  expect((await clearResponsePromise).status()).toBe(200);
  await expect(page.getByText('Đã thu hồi toàn bộ quyền theo cửa hàng.')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng biểu mẫu phân công cửa hàng' }).click();

  const storeUsername = `live.store.${runSuffix}`.slice(0, 80);
  const storePassword = 'Live-store-password-2026!';
  const existingAccountResponse = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/admin/accounts?search=${encodeURIComponent(storeUsername)}&page=1&pageSize=20`,
    );
  expect(existingAccountResponse.status()).toBe(200);
  const existingAccountPayload = (await existingAccountResponse.json()) as {
    data: Array<{ username: string }>;
  };
  const accountExists = existingAccountPayload.data.some(
    (account) => account.username === storeUsername,
  );
  if (!accountExists) {
    await page.getByRole('button', { name: 'Thêm tài khoản' }).click();
    const accountForm = page.locator('#admin-create-account');
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
  }
  const openSessionId = await ensureOpenOrderSession(page);

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

  await page.getByRole('link', { name: 'Đặt hàng' }).click();
  await expect(
    page.getByRole('heading', { exact: true, name: 'Đặt hàng & kết quả' }),
  ).toBeVisible();
  const lineNote = `REF-${runSuffix}-${testInfo.retry}-${'X'.repeat(180)}`;
  await page.getByRole('checkbox').first().check();
  await expect(page.getByRole('button', { name: /^Giảm số bao/ })).toBeDisabled();
  await page.getByRole('button', { name: /^Tăng số bao/ }).click();
  await page.getByLabel(/^Ghi chú mặt hàng/).fill(lineNote);
  await expect(page.getByText(`2 bao • ${lineNote}`)).toBeVisible();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('checkbox').nth(1).uncheck();
  await expect(page.getByRole('spinbutton')).toHaveCount(1);
  for (const width of [360, 390, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth <= innerWidth))
      .toBe(true);
    const checkbox = (await page.getByRole('checkbox').first().boundingBox())!;
    const quantity = (await page.getByRole('spinbutton').boundingBox())!;
    expect(
      Math.abs(checkbox.y + checkbox.height / 2 - quantity.y - quantity.height / 2),
    ).toBeLessThan(2);
    expect(quantity.x).toBeGreaterThan(checkbox.x + checkbox.width);
  }

  const orderResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/order-requests` &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Gửi yêu cầu đặt hàng' }).click();
  const orderResponse = await orderResponsePromise;
  expect(orderResponse.status()).toBe(201);
  const orderPayload = (await orderResponse.json()) as {
    data: { id: string; lines: Array<{ note?: string }>; storeId: string };
  };
  expect(orderPayload.data.lines).toContainEqual(expect.objectContaining({ note: lineNote }));
  expect(orderPayload.data.lines).toHaveLength(1);
  await expect(
    page.getByText('Đã gửi yêu cầu. Kho chỉ giữ hàng sau khi chạy phân bổ.'),
  ).toBeVisible();

  const orderCard = page.locator('.request-history-card').filter({ hasText: lineNote });
  await expect(orderCard).toHaveCount(1);
  await orderCard.locator('summary').click();
  await expect(orderCard.getByText(lineNote)).toBeVisible();
  await page.setViewportSize({ height: 844, width: 390 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const cancellationTrigger = orderCard.getByRole('button', { name: 'Hủy yêu cầu' });
  expect((await cancellationTrigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await cancellationTrigger.click();
  const cancellationReason = `Live cancellation ${runSuffix}-${testInfo.retry}`;
  await orderCard.getByLabel('Lý do hủy').fill(cancellationReason);
  const confirmCancellation = orderCard.getByRole('button', { name: 'Xác nhận hủy' });
  expect(
    await confirmCancellation.evaluate((button) => {
      const label = button.querySelector<HTMLElement>('.button__content');
      return label ? getComputedStyle(label).color === getComputedStyle(button).color : false;
    }),
  ).toBe(true);
  const cancelOrderResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/api/v1/order-requests/${orderPayload.data.id}/cancel` &&
      response.request().method() === 'POST',
  );
  await confirmCancellation.click();
  expect((await cancelOrderResponsePromise).status()).toBe(200);
  await expect(orderCard.getByText('Đã hủy')).toBeVisible();
  await expect(page.getByText('Đã hủy yêu cầu đặt hàng.')).toBeVisible();

  const persistedOrders = await page
    .context()
    .request.get(
      `${apiOrigin}/api/v1/order-requests?storeId=${orderPayload.data.storeId}&sessionId=${openSessionId}&page=1&pageSize=20`,
    );
  expect(persistedOrders.status()).toBe(200);
  const persistedOrderPayload = (await persistedOrders.json()) as {
    data: Array<{
      cancellationReason?: string | null;
      id: string;
      lines: Array<{ note?: string }>;
      status: string;
    }>;
  };
  expect(persistedOrderPayload.data).toContainEqual(
    expect.objectContaining({
      cancellationReason,
      id: orderPayload.data.id,
      lines: expect.arrayContaining([expect.objectContaining({ note: lineNote })]),
      status: 'CANCELLED',
    }),
  );

  const forbiddenAdminApi = await page
    .context()
    .request.get(`${apiOrigin}/api/v1/admin/accounts?page=1&pageSize=20`);
  expect(forbiddenAdminApi.status()).toBe(403);
  const storeAllocationResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`${apiOrigin}/api/v1/allocations?`) &&
      response.request().method() === 'GET',
  );
  await page
    .getByRole('navigation', { name: 'Điều hướng mobile' })
    .getByRole('link', { name: 'Phân bổ hàng hóa' })
    .click();
  expect((await storeAllocationResponsePromise).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Giám sát phân bổ hàng hóa' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Kết quả phân bổ đã lưu' })).toBeVisible();
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
  await expect(
    allocationResults.locator('.badge').filter({ hasText: 'Đã cấp đủ' }).first(),
  ).toBeVisible();
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

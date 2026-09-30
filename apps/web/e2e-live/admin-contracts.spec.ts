import { expect, test } from '@playwright/test';
import {
  ListStoreOrderRequestsResponseSchema,
  ListReceiptsResponseSchema,
  ListWaitTicketsResponseSchema,
  ListPriorityOffersResponseSchema,
  ListOrderSessionsResponseSchema,
  ListWarehouseOutboundRequestsResponseSchema,
  MonthlyOperationalReportResponseSchema,
} from '@idosi/contracts';

test('Admin list responses obey their runtime contracts with accumulated workflow data', async ({
  request,
  page,
}, testInfo) => {
  const api = 'http://127.0.0.1:3100/api/v1';
  const credentials = {
    username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
    password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
  };
  expect((await request.post(`${api}/auth/login`, { data: credentials })).status()).toBe(200);
  for (const [path, schema] of [
    ['order-requests', ListStoreOrderRequestsResponseSchema],
    ['store-receipts', ListReceiptsResponseSchema],
    ['wait-tickets', ListWaitTicketsResponseSchema],
    ['priority-offers', ListPriorityOffersResponseSchema],
    ['order-sessions', ListOrderSessionsResponseSchema],
    ['outbound-requests', ListWarehouseOutboundRequestsResponseSchema],
  ] as const) {
    const response = await request.get(`${api}/${path}?pageSize=100`);
    expect(response.status()).toBe(200);
    const payload = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      await testInfo.attach(`${path}-issues`, {
        body: JSON.stringify(parsed.error.issues, null, 2),
        contentType: 'application/json',
      });
    expect.soft(parsed.success, path).toBe(true);
    for (let pageNumber = 2; pageNumber <= (payload.pagination?.totalPages ?? 1); pageNumber++) {
      const next = await request.get(`${api}/${path}?pageSize=100&page=${pageNumber}`);
      const nextParsed = schema.safeParse(await next.json());
      if (!nextParsed.success)
        await testInfo.attach(`${path}-${pageNumber}-issues`, {
          body: JSON.stringify(nextParsed.error.issues, null, 2),
          contentType: 'application/json',
        });
      expect.soft(nextParsed.success, `${path} page ${pageNumber}`).toBe(true);
    }
  }
  const today = new Date();
  const report = await request.get(
    `${api}/reports/monthly?scopeKind=ALL&year=${today.getFullYear()}&month=${today.getMonth() + 1}`,
  );
  const parsedReport = MonthlyOperationalReportResponseSchema.safeParse(await report.json());
  if (!parsedReport.success)
    await testInfo.attach('report-issues', {
      body: JSON.stringify(parsedReport.error.issues, null, 2),
      contentType: 'application/json',
    });
  expect.soft(parsedReport.success, 'monthly report').toBe(true);
  await page.setViewportSize({ width: 821, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('.app-main')).toBeVisible();
  await page.goto('/users');
  await expect(page.locator('.admin-table tbody tr').first()).toBeVisible();
  await testInfo.attach('users-boxes', {
    body: JSON.stringify(
      await page.locator('.app-main *').evaluateAll((elements) =>
        elements
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 30)
          .map((el) => ({
            tag: el.tagName,
            className: el.className,
            text: el.textContent?.slice(0, 100),
            rect: el.getBoundingClientRect().toJSON(),
            overflow: getComputedStyle(el).overflowX,
          })),
      ),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('users-821.png'), fullPage: true });
  expect
    .soft(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(822);
});

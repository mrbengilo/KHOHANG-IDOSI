import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Response } from '@playwright/test';
import { routeAccessPolicies, canAccessRoute } from '../src/lib/access';

const api = 'http://127.0.0.1:3100/api/v1';
const admin = {
  username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
  password: process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
};

async function signIn(page: Page, credentials: typeof admin) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(credentials.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('.app-main')).toBeVisible();
}

test('all registered route guards and reachable table layouts across four roles', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  expect((await request.post(`${api}/auth/login`, { data: admin })).status()).toBe(200);
  const groups = await request.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
  const groupId = (await groups.json()).data[0].id;
  const token = randomUUID().slice(0, 8);
  const stores: string[] = [];
  for (const [index, kind] of ['RETAIL', 'RETAIL', 'WHOLESALE'].entries()) {
    const response = await request.post(`${api}/stores`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        code: `AUDIT_${token}_${index}`,
        name: `Cửa hàng kiểm thử phạm vi ${index} ${token}`,
        groupId,
        kind,
      },
    });
    expect(response.status()).toBe(201);
    stores.push((await response.json()).data.id);
  }
  const identities: {
    role: 'ADMIN' | 'HTKD' | 'STORE' | 'WHOLESALE';
    credentials: typeof admin;
  }[] = [{ role: 'ADMIN', credentials: admin }];
  for (const role of ['HTKD', 'STORE', 'WHOLESALE'] as const) {
    const credentials = {
      username: `audit.${role.toLowerCase()}.${token}`,
      password: `Test-only-${randomUUID()}!`,
    };
    const response = await request.post(`${api}/admin/accounts`, {
      data: {
        ...credentials,
        displayName: `Audit ${role}`,
        role,
        ...(role === 'STORE' ? { storeId: stores[0] } : {}),
      },
    });
    expect(response.status()).toBe(201);
    if (role === 'HTKD') {
      const accountId = (await response.json()).data.id;
      const assigned = await request.put(`${api}/admin/accounts/${accountId}/assignments`, {
        data: {
          expectedSessionVersion: 0,
          storeIds: [stores[0], stores[2]],
          reason: 'Phạm vi kiểm thử route',
        },
      });
      expect(assigned.status()).toBe(200);
    }
    identities.push({ role, credentials });
  }
  const observations: unknown[] = [];
  try {
    for (const { role, credentials } of identities) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await signIn(page, credentials);
      for (const route of Object.keys(routeAccessPolicies)) {
        const allowed = canAccessRoute(route, role, role === 'STORE' ? 'RETAIL' : null);
        const responses: { method: string; path: string; status: number }[] = [];
        const record = (response: Response) => {
          if (response.url().includes('/api/v1/'))
            responses.push({
              method: response.request().method(),
              path: new URL(response.url()).pathname,
              status: response.status(),
            });
        };
        page.on('response', record);
        await page.goto(`http://127.0.0.1:4174${route}`);
        await expect(page.locator('.app-main')).toBeVisible();
        if (!allowed) {
          await expect(page).toHaveURL('http://127.0.0.1:4174/');
          observations.push({
            role,
            route,
            action: 'direct route guard',
            status: 'PASS',
            allowed: false,
          });
          page.off('response', record);
          continue;
        }
        await expect(page.locator('.page-header')).toBeVisible();
        // A settled render is needed before inspecting real table boxes, including lazy pages.
        await page.waitForLoadState('networkidle');
        const tabs = await page.getByRole('tab').allTextContents();
        const tableChecks = [];
        const initialErrorCount = testInfo.errors.length;
        for (const width of [360, 390, 412, 768, 819, 820, 821, 1024, 1366, 1440, 1920, 2560]) {
          await page.setViewportSize({ width, height: 900 });
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
            const escaped = await page.locator('.app-main *').evaluateAll((elements) =>
              elements
                .filter((element) => {
                  const box = element.getBoundingClientRect();
                  if (box.right <= innerWidth + 1) return false;
                  for (
                    let ancestor = element.parentElement;
                    ancestor;
                    ancestor = ancestor.parentElement
                  ) {
                    if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(ancestor).overflowX))
                      return false;
                  }
                  return true;
                })
                .slice(0, 20)
                .map((element) => ({
                  tag: element.tagName,
                  className: element.className,
                  text: element.textContent?.slice(0, 160),
                  width: element.getBoundingClientRect().width,
                })),
            );
            await testInfo.attach(`overflow-${role}-${route.replaceAll('/', '')}-${width}`, {
              body: JSON.stringify(escaped, null, 2),
              contentType: 'application/json',
            });
          }
          expect
            .soft(
              await page.evaluate(() => document.documentElement.scrollWidth),
              `${role} ${route} ${width}`,
            )
            .toBeLessThanOrEqual(width + 1);
          tableChecks.push(
            await page.locator('table').evaluateAll((tables) =>
              tables.map((table) => ({
                caption: table.getAttribute('aria-label'),
                headers: Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent),
                rows: table.querySelectorAll('tbody tr').length,
                width: table.getBoundingClientRect().width,
                viewport: innerWidth,
                cells: Array.from(
                  table.querySelectorAll('tbody tr:first-child > td, tbody tr:first-child > th'),
                )
                  .slice(0, 12)
                  .map((cell) => {
                    const box = cell.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(cell);
                    const content = range.getBoundingClientRect();
                    return {
                      text: cell.textContent?.slice(0, 120),
                      width: box.width,
                      x: box.x,
                      contentLeft: content.left,
                      contentRight: content.right,
                      font: getComputedStyle(cell).fontSize,
                      align: getComputedStyle(cell).textAlign,
                    };
                  }),
              })),
            ),
          );
        }
        const alerts = await page.getByRole('alert').allTextContents();
        // Toggle only the new density classes on the same DOM/data to avoid comparing
        // different fixtures after live workflow tests have added stores and documents.
        const densityComparison = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table'));
          const measure = () =>
            tables.map((table) => ({
              headers: Array.from(table.querySelectorAll('thead th')).map(
                (cell) => cell.textContent,
              ),
              text: table.textContent,
              rows: table.querySelectorAll('tbody tr').length,
              width: table.getBoundingClientRect().width,
              rowHeight: table.querySelector('tbody tr')?.getBoundingClientRect().height ?? 0,
              cells: Array.from(
                table.querySelectorAll('tbody tr:first-child > td, tbody tr:first-child > th'),
              )
                .slice(0, 12)
                .map((cell) => ({
                  width: cell.getBoundingClientRect().width,
                  font: getComputedStyle(cell).fontSize,
                  align: getComputedStyle(cell).textAlign,
                })),
            }));
          const after = measure();
          const nodes = Array.from(
            document.querySelectorAll(
              '.table-density, .warehouse-stock-table, .document-history--compact',
            ),
          );
          const classes = nodes.map((node) => node.className);
          const warehouseNames = Array.from(
            document.querySelectorAll<HTMLElement>('.warehouse-stock-table tr > :first-child'),
          );
          const styles = warehouseNames.map((node) => node.getAttribute('style'));
          try {
            nodes.forEach((node) =>
              node.classList.remove(
                'table-density',
                'table-density--metrics',
                'warehouse-stock-table',
                'document-history--compact',
              ),
            );
            warehouseNames.forEach((node) => {
              node.style.width = '28%';
            });
            return { viewport: innerWidth, before: measure(), after };
          } finally {
            nodes.forEach((node, index) => {
              node.className = classes[index]!;
            });
            warehouseNames.forEach((node, index) => {
              const style = styles[index];
              if (style === null || style === undefined) node.removeAttribute('style');
              else node.setAttribute('style', style);
            });
          }
        });
        expect
          .soft(densityComparison.after.map((table) => ({ rows: table.rows, text: table.text })))
          .toEqual(
            densityComparison.before.map((table) => ({ rows: table.rows, text: table.text })),
          );
        expect.soft(alerts, `${role} ${route} load errors`).toEqual([]);
        observations.push({
          role,
          route,
          action: 'initial route render and responsive bounds',
          status: testInfo.errors.length === initialErrorCount ? 'PASS' : 'FAIL',
          tabs,
          buttons: await page.getByRole('button').allTextContents(),
          tables: tableChecks,
          densityComparison,
          responses,
          alerts,
        });
        const tabPaths = new Map(tabs.map((name) => [name, [name]]));
        for (const [name, path] of tabPaths) {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(`http://127.0.0.1:4174${route}`);
          await page.waitForLoadState('networkidle');
          for (const parent of path.slice(0, -1)) {
            await page.getByRole('tab', { name: parent, exact: true }).click();
            await page.waitForLoadState('networkidle');
          }
          const tab = page.getByRole('tab', { name, exact: true });
          if (!(await tab.isEnabled())) {
            observations.push({
              role,
              route,
              action: `tab: ${name}`,
              status: 'BLOCKED',
              reason: 'disabled for the current fixture state',
            });
            continue;
          }
          const errorsBefore = testInfo.errors.length;
          await tab.click();
          await page.waitForLoadState('networkidle');
          for (const discovered of await page.getByRole('tab').allTextContents()) {
            if (!tabPaths.has(discovered)) tabPaths.set(discovered, [...path, discovered]);
          }
          for (const width of [360, 821, 1440, 2560]) {
            await page.setViewportSize({ width, height: 900 });
            expect
              .soft(
                await page.evaluate(() => document.documentElement.scrollWidth),
                `${role} ${route} tab ${name} ${width}`,
              )
              .toBeLessThanOrEqual(width + 1);
          }
          expect
            .soft(await page.getByRole('alert').allTextContents(), `${role} ${route} tab ${name}`)
            .toEqual([]);
          observations.push({
            role,
            route,
            action: `tab: ${name}`,
            status: testInfo.errors.length === errorsBefore ? 'PASS' : 'FAIL',
            buttons: await page.getByRole('button').allTextContents(),
            tableHeaders: await page.locator('table thead').allTextContents(),
            tableMetrics: await page.locator('table').evaluateAll((tables) =>
              tables.map((table) => ({
                headers: Array.from(table.querySelectorAll('thead th')).map(
                  (cell) => cell.textContent,
                ),
                rows: table.querySelectorAll('tbody tr').length,
                width: table.getBoundingClientRect().width,
                viewport: innerWidth,
                cells: Array.from(table.querySelectorAll('tbody tr:first-child > td')).map(
                  (cell) => ({
                    text: cell.textContent,
                    width: cell.getBoundingClientRect().width,
                    font: getComputedStyle(cell).fontSize,
                    align: getComputedStyle(cell).textAlign,
                  }),
                ),
              })),
            ),
          });
        }
        page.off('response', record);
      }
      expect.soft(errors).toEqual([]);
      await context.close();
    }
  } finally {
    await testInfo.attach('route-audit', {
      body: JSON.stringify(observations, null, 2),
      contentType: 'application/json',
    });
  }
});

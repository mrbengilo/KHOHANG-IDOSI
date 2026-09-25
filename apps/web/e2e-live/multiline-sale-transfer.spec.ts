import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  createDatabase,
  products,
  storeInventoryBags,
  createStorePartnerInbound,
  createStoreSorting,
} from '@idosi/database';
import { eq } from 'drizzle-orm';
import { tabApi } from './tab-api';
const api = 'http://127.0.0.1:3100/api/v1';
test('one multi-product Sale document is created, displayed and received against PostgreSQL', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  if (!process.env.DATABASE_URL) throw new Error('Isolated PostgreSQL required');
  const client = createDatabase({ connectionString: process.env.DATABASE_URL, max: 2 });
  const token = randomUUID().slice(0, 8);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    expect(
      (
        await page.request.post(api + '/auth/login', {
          data: {
            username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
            password:
              process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
          },
        })
      ).status(),
    ).toBe(200);
    const groupId = (
      await (await page.request.get(api + '/store-groups?status=ACTIVE&pageSize=100')).json()
    ).data[0].id;
    const accounts = [];
    for (const name of ['source', 'destination']) {
      const response = await page.request.post(api + '/stores', {
        headers: { 'idempotency-key': randomUUID() },
        data: {
          code: 'MULTI_' + name + '_' + token,
          name: 'Multiline ' + name,
          kind: 'RETAIL',
          groupId,
        },
      });
      expect(response.status()).toBe(201);
      const store = (await response.json()).data;
      const login = {
        username: 'multi.' + name + '.' + token,
        password: 'Test-only-' + randomUUID() + '!',
      };
      const user = await page.request.post(api + '/admin/accounts', {
        data: { ...login, displayName: 'Actor ' + name, role: 'STORE', storeId: store.id },
      });
      expect(user.status()).toBe(201);
      accounts.push({ store, login, user: (await user.json()).data });
    }
    const [source, destination] = accounts;
    const items = await client.db
      .insert(products)
      .values(
        ['Đầm', 'Jeans'].map((name, index) => ({
          sku: 'MULTI' + token + index,
          slug: 'multi' + token + index,
          name: name + ' ' + token,
        })),
      )
      .returning();
    await createStorePartnerInbound(client.db, {
      storeId: source!.store.id,
      requestId: randomUUID(),
      partnerName: 'Test supplier',
      receivedAt: new Date(),
      note: null,
      lines: items.map((item) => ({ productId: item.id, quantity: 1, bagWeightsKg: ['200.000'] })),
      createdByUserId: source!.user.id,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const bags = await client.db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, source!.store.id));
    for (const bag of bags)
      await createStoreSorting(client.db, {
        storeId: source!.store.id,
        inventoryBagId: bag.id,
        expectedInventoryVersion: bag.version,
        reason: 'SALE',
        weightKg: '200.000',
        actorUserId: source!.user.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
    await page.request.post(api + '/auth/logout');
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(source!.login.username);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(source!.login.password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/transfers');
    await expect(page.getByRole('heading', { name: 'Điều chuyển từ Sale sau lọc' })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Cửa hàng nhận', exact: true })
      .selectOption(destination!.store.id);
    for (const [index, item] of items.entries()) {
      await page.getByLabel('Mặt hàng Sale sau lọc').selectOption(item.id);
      await page.getByRole('button', { name: 'Thêm mặt hàng', exact: true }).click();
      const line = page.getByRole('group', { name: item.name, exact: true });
      await line.getByLabel('Số lượng (bao)').fill(index === 0 ? '2' : '1');
      await line.getByLabel('Bao 1 · ' + item.name + ' (kg)').fill(index === 0 ? '30' : '50');
      if (index === 0) await line.getByLabel('Bao 2 · ' + item.name + ' (kg)').fill('50');
    }
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/sorted-sale-transfers') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Điều chuyển', exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    const transfer = (await response.json()).data;
    expect(transfer.lines).toHaveLength(2);
    const listed = await (await tabApi(page).get(api + '/sorted-sale-transfers?pageSize=1')).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].lines).toHaveLength(2);
    expect(listed.hasMore).toBe(false);
    const nextPage = await (
      await tabApi(page).get(api + '/sorted-sale-transfers?page=2&pageSize=1')
    ).json();
    expect(nextPage.data).toHaveLength(0);
    const history = page.getByRole('region', { name: 'Lịch sử điều chuyển Sale', exact: true });
    const body = history.locator('tbody').filter({ hasText: transfer.transferNumber });
    await expect(body.locator('tr')).toHaveCount(2);
    await expect(body.locator('tr').first().locator('td').nth(7)).toHaveText('3');
    await expect(body.locator('tr').first().locator('td').nth(8)).toHaveText('130 kg');
    await expect(body.locator('tr').first().locator('td').nth(9)).toHaveText('Actor source');
    for (const width of [360, 390, 412, 768, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if ([390, 1440].includes(width))
        await page.screenshot({
          path: testInfo.outputPath('multiline-' + width + '.png'),
          fullPage: true,
          animations: 'disabled',
        });
    }
    await history.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await history.screenshot({
      path: testInfo.outputPath('multiline-totals.png'),
      animations: 'disabled',
    });
    await page.reload();
    await expect(body.locator('tr')).toHaveCount(2);
    await tabApi(page).post(api + '/auth/logout');
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill(destination!.login.username);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(destination!.login.password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/transfers');
    await body.getByRole('button', { name: 'Xác nhận đã nhận', exact: true }).click();
    await expect(body.getByText('Đã nhận', { exact: true })).toBeVisible();
    await page.reload();
    await expect(body.getByText('Đã nhận', { exact: true })).toBeVisible();
    await expect(body).toContainText('Actor source');
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});

import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { db, users, sessions, closeDatabase } from '@idosi/database';
import { createSupplierFixture } from '../../../packages/database/tests/fixtures/supplier';
import {
  createProduct,
  openingStock,
  publishPendingResult,
  respond,
  balanceOf,
} from '../../../packages/database/tests/fixtures/reshare';
import { hashSessionToken } from '../../api/dist/security.js';
import { tabApi } from './tab-api';

async function authenticate(page: Page, userId: string) {
  const token = randomUUID(),
    tabId = randomUUID().replaceAll('-', '');
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    userTokenVersion: user!.tokenVersion,
    expiresAt: new Date(Date.now() + 3600000),
  });
  await page.addInitScript((id) => sessionStorage.setItem('idosi-auth-tab-id:v1', id), tabId);
  await page.context().addCookies([
    {
      name: `idosi_session_${tabId}`,
      value: token,
      url: 'http://127.0.0.1:4174',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
test.afterAll(async () => closeDatabase());
for (const width of [1440, 390])
  test(`emergency order main flow and server scope at ${width}px`, async ({
    page,
    browser,
  }, testInfo) => {
    const fx = await createSupplierFixture(),
      male = await createProduct('Khẩn nam'),
      female = await createProduct('Khẩn nữ'),
      zero = await createProduct('Khẩn hết');
    await openingStock(male, 1);
    await openingStock(female, 1);
    const granted = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: male, quantity: 1 }],
      shipment: false,
    });
    await respond(granted.decisionId, fx.storeUserA, 'ACCEPT');
    // This HTKD is assigned to B, but the emergency action must also accept A.
    await authenticate(page, fx.otherHtkdId);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/priority-orders');
    await page.getByRole('button', { name: 'Tạo đơn ưu tiên khẩn cấp', exact: true }).click();
    await page.getByRole('combobox', { name: /^Cửa hàng/ }).selectOption(fx.storeA);
    await page.getByRole('checkbox').check();
    const checkbox = await page.getByRole('checkbox').boundingBox();
    expect(checkbox!.width).toBeLessThanOrEqual(24);
    expect(checkbox!.height).toBeLessThanOrEqual(24);
    await page.getByRole('combobox', { name: /^Mặt hàng/ }).selectOption(zero);
    await expect(
      page.getByText('Tồn khả dụng = 0, không thể đặt mặt hàng này.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Số bao', { exact: true })).toBeDisabled();
    await page.getByRole('combobox', { name: /^Mặt hàng/ }).selectOption(female);
    await expect(page.getByText('Tồn khả dụng: 1 bao', { exact: true })).toBeVisible();
    await page.getByLabel('Số bao', { exact: true }).fill('2');
    await expect(
      page.getByText('Kho chỉ còn 1 bao khả dụng, chỉ được đặt tối đa 1 bao.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm mặt hàng', exact: true })).toBeDisabled();
    await page.getByLabel('Số bao', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Thêm mặt hàng', exact: true }).click();
    await expect(
      page.getByText('Tổng đơn: 2 bao (1 đã cấp + 1 đặt thêm)', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.getByRole('region', { name: 'Soạn đơn ưu tiên khẩn cấp' }).screenshot({
      path: testInfo.outputPath(`priority-preview-${width}.png`),
    });
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/priority-orders'),
    );
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/priority-orders'),
    );
    await page.getByRole('button', { name: 'Gửi đơn ưu tiên khẩn cấp', exact: true }).click();
    const command = await sent;
    const submitted = await response;
    expect(submitted.status()).toBe(201);
    const order = (await submitted.json()).data;
    const card = page.locator(`article[id="${order.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.getByText(/Tổng 2 bao/)).toBeVisible();
    await expect(card.getByText(/RE lập ngay:/)).toContainText('1 bao');
    expect(await balanceOf(female)).toEqual({ onHand: 0, reserved: 0 });
    const replay = await tabApi(page).post('http://127.0.0.1:3100/api/v1/priority-orders', {
      data: command.postDataJSON(),
      headers: { 'idempotency-key': command.headers()['idempotency-key']! },
    });
    expect(replay.status()).toBe(201);
    expect(replay.headers()['idempotency-replayed']).toBe('true');
    const changed = await tabApi(page).post('http://127.0.0.1:3100/api/v1/priority-orders', {
      data: { ...command.postDataJSON(), notes: 'changed' },
      headers: { 'idempotency-key': command.headers()['idempotency-key']! },
    });
    expect(changed.status()).toBe(409);
    const noKey = await tabApi(page).post('http://127.0.0.1:3100/api/v1/priority-orders', {
      data: command.postDataJSON(),
    });
    expect(noKey.status()).toBe(400);
    await card.screenshot({
      path: testInfo.outputPath(`priority-result-${width}.png`),
    });
    const storeContext = await browser.newContext({ viewport: { width, height: 900 } }),
      store = await storeContext.newPage();
    try {
      await authenticate(store, fx.storeUserA);
      await store.goto('/priority-orders');
      await expect(
        store.getByRole('article').getByText('Đơn ưu tiên khẩn cấp', { exact: true }),
      ).toBeVisible();
      await expect(
        store.getByRole('button', { name: 'Tạo đơn ưu tiên khẩn cấp', exact: true }),
      ).toHaveCount(0);
      const api = tabApi(store),
        base = 'http://127.0.0.1:3100/api/v1/priority-orders';
      expect((await api.get(`${base}/context?storeId=${fx.storeA}`)).status()).toBe(403);
      expect((await api.get(`${base}?storeId=${fx.storeB}`)).status()).toBe(403);
      expect(
        (await api.post(base, { data: {}, headers: { 'idempotency-key': randomUUID() } })).status(),
      ).toBe(403);
      const own = await (await api.get(base)).json();
      expect(own.data).toHaveLength(1);
      expect(own.data[0].totalQuantity).toBe(2);
      await store.goto('/receive');
      await store.getByRole('button', { name: 'Nhận hàng', exact: true }).click();
      await expect(store.getByText(/Đơn ưu tiên khẩn cấp · UK-/)).toBeVisible();
    } finally {
      await storeContext.close();
    }
  });

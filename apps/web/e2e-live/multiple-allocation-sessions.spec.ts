import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import {
  applyWarehouseMovement,
  createDatabase,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
} from '@idosi/database';
import { inArray } from 'drizzle-orm';

import { tabApi } from './tab-api';

const api = 'http://127.0.0.1:3100/api/v1';

interface AllocationJobRepository {
  captureSnapshotAndCreateOffers(
    session: unknown,
    now: Date,
  ): Promise<{ replayed: boolean; resourceId: string }>;
  expireOffersAndFinalizeAllocation(
    session: unknown,
    now: Date,
  ): Promise<{ replayed: boolean; resourceId: string }>;
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/u);
}

const vn = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);

test('Admin runs three independent sessions on one day; history and results never mix', async ({
  page,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'Requires the live PostgreSQL database.');
  const client = createDatabase({ connectionString: databaseUrl, max: 2 });
  const db = client.db;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const token = randomUUID().replaceAll('-', '').slice(0, 10);
    // A far-future business date keeps this day's sessions apart from the shared calendar.
    const day = new Date(
      Date.UTC(2097, 0, 1) + (Number.parseInt(token.slice(0, 6), 16) % 360) * 86_400_000,
    );
    const date = day.toISOString().slice(0, 10);
    const [dd, mm, yyyy] = [date.slice(8, 10), date.slice(5, 7), date.slice(0, 4)];
    const minute = String(Number.parseInt(token.slice(6, 8), 16) % 50).padStart(2, '0');

    const adminUsername = process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin';
    const adminPassword =
      process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production';
    await login(page, adminUsername, adminPassword);
    const http = tabApi(page);
    const adminId = (await (await http.get(`${api}/auth/session`)).json()).data.principal
      .accountId as string;
    const groups = await http.get(`${api}/store-groups?status=ACTIVE&pageSize=100`);
    const groupId = (await groups.json()).data[0].id as string;
    const storesCreated: { id: string; code: string; name: string }[] = [];
    for (const name of ['A', 'B']) {
      const created = await http.post(`${api}/stores`, {
        headers: { 'idempotency-key': randomUUID() },
        data: {
          code: `MS_${name}_${token}`,
          name: `Cửa hàng phiên ${name} ${token}`,
          kind: 'RETAIL',
          groupId,
        },
      });
      expect(created.status()).toBe(201);
      storesCreated.push((await created.json()).data);
    }
    const [storeA, storeB] = storesCreated as [
      (typeof storesCreated)[number],
      (typeof storesCreated)[number],
    ];
    const htkdUsername = `htkd.ms.${token}`;
    const htkdPassword = `Test-only-${randomUUID()}!`;
    const htkd = await http.post(`${api}/admin/accounts`, {
      data: {
        username: htkdUsername,
        password: htkdPassword,
        displayName: 'HTKD nhiều phiên',
        role: 'HTKD',
      },
    });
    expect(htkd.status()).toBe(201);
    const assigned = await http.put(
      `${api}/admin/accounts/${(await htkd.json()).data.id}/assignments`,
      {
        data: {
          expectedSessionVersion: 0,
          storeIds: [storeA.id],
          reason: 'Phân công kiểm thử nhiều phiên',
        },
      },
    );
    expect(assigned.status()).toBe(200);
    const productRows = await db
      .insert(products)
      .values(
        ['X', 'Y'].map((name) => ({
          sku: `MS-${name}-${token}`,
          slug: `ms-${name.toLowerCase()}-${token}`,
          name: `Hàng nhiều phiên ${name} ${token}`,
        })),
      )
      .returning();
    const [x, y] = productRows as [(typeof productRows)[number], (typeof productRows)[number]];
    for (const product of productRows) {
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product.id,
          eventType: 'opening_balance',
          onHandDelta: 20,
          reservedDelta: 0,
          sourceType: 'live_e2e_multi_session',
          sourceId: randomUUID(),
        }),
      );
    }
    // The system's default session of that day (08:00 / 09:00).
    const [s1] = await db
      .insert(orderSessions)
      .values({
        code: '',
        kind: 'default',
        businessDate: date,
        status: 'draft',
        openedAt: vn(date, '00:00'),
        inventorySnapshotDueAt: vn(date, '08:00'),
        requestDeadlineAt: vn(date, '09:00'),
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
      })
      .returning();

    // 1. Admin adds two extra sessions from the "Tạo phiên mới" tab.
    await page.goto('/allocations?tab=create');
    const form = page.locator('.allocation-session-form');
    const createSession = async (close: string, allocate: string) => {
      await form.getByLabel('Ngày nghiệp vụ').fill(date);
      await form.getByLabel('Mở nhận đơn').fill('00:00');
      await form.getByLabel('Chốt nhận đơn / chụp tồn').fill(close);
      await form.getByLabel('Bắt đầu phân bổ').fill(allocate);
      const response = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === '/api/v1/order-sessions' &&
          candidate.request().method() === 'POST',
      );
      await form.getByRole('button', { name: 'Tạo phiên bổ sung' }).click();
      return response;
    };
    const s2Response = await createSession(`10:${minute}`, `11:${minute}`);
    expect(s2Response.status()).toBe(201);
    const s2 = (await s2Response.json()).data as { id: string; code: string };
    await expect(page.getByRole('status').filter({ hasText: s2.code })).toContainText(
      `${dd}/${mm}/${yyyy} · chốt 10:${minute}`,
    );
    const s3Response = await createSession(`14:${minute}`, `15:${minute}`);
    expect(s3Response.status()).toBe(201);
    const s3 = (await s3Response.json()).data as { id: string; code: string };
    const daySessions = page.getByRole('region', { name: `Phiên của ngày ${dd}/${mm}/${yyyy}` });
    const items = daySessions.getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText(s1!.code);
    await expect(items.nth(0)).toContainText('Phiên mặc định');
    await expect(items.nth(1)).toContainText(s2.code);
    await expect(items.nth(2)).toContainText(s3.code);
    await expect(daySessions.getByText('Phiên bổ sung')).toHaveCount(2);
    expect(new Set([s1!.code, s2.code, s3.code]).size).toBe(3);

    // A session closing at the same instant as another would never receive orders.
    const duplicate = await createSession(`10:${minute}`, `12:${minute}`);
    expect(duplicate.status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText('chốt nhận đơn đúng thời điểm này');
    await expect(items).toHaveCount(3);

    for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 390 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath(`create-session-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // 2. Fixture orders land in their own sessions; the worker runs every session on its times.
    await db
      .update(orderSessions)
      .set({ status: 'open' })
      .where(inArray(orderSessions.id, [s1!.id, s2.id, s3.id]));
    const queue = async (
      sessionId: string,
      storeId: string,
      requestNumber: number,
      at: string,
      lines: readonly (readonly [string, number])[],
    ) => {
      const [request] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: sessionId,
          storeId,
          requestNumber,
          status: 'submitted',
          submittedAt: vn(date, at),
          requestedByUserId: adminId,
        })
        .returning();
      await db.insert(orderRequestItems).values(
        lines.map(([productId, quantity]) => ({
          orderRequestId: request!.id,
          productId,
          requestedQuantity: quantity,
        })),
      );
      return request!;
    };
    const a1 = await queue(s1!.id, storeA.id, 1, '07:00', [
      [x.id, 2],
      [y.id, 1],
    ]);
    const a2 = await queue(s1!.id, storeA.id, 2, '07:10', [[x.id, 3]]);
    const a3 = await queue(s2.id, storeA.id, 1, `09:${minute}`, [[x.id, 4]]);
    const b1 = await queue(s2.id, storeB.id, 1, `09:${minute}`, [[x.id, 1]]);
    const workerModule = (await import(
      pathToFileURL(resolve(process.cwd(), '../worker/dist/postgres-repository.js')).href
    )) as { PostgresAllocationJobRepository: new (client: unknown) => AllocationJobRepository };
    const worker = new workerModule.PostgresAllocationJobRepository(client);
    const sessionRows = await db
      .select()
      .from(orderSessions)
      .where(inArray(orderSessions.id, [s1!.id, s2.id, s3.id]));
    const scheduled = (id: string) => {
      const row = sessionRows.find((candidate) => candidate.id === id)!;
      return {
        id: row.id,
        businessDate: row.businessDate,
        snapshotDueAt: row.inventorySnapshotDueAt,
        finalDueAt: row.requestDeadlineAt,
        policyVersion: row.policyVersion,
      };
    };
    const runAll = async () => {
      const replays: boolean[] = [];
      for (const id of [s1!.id, s2.id, s3.id]) {
        const session = scheduled(id);
        replays.push(
          (await worker.captureSnapshotAndCreateOffers(session, session.snapshotDueAt)).replayed,
        );
        replays.push(
          (
            await worker.expireOffersAndFinalizeAllocation(
              session,
              new Date(session.finalDueAt.getTime() + 1_000),
            )
          ).replayed,
        );
      }
      return replays;
    };
    expect(await runAll()).toEqual([false, false, false, false, false, false]);

    const documentLines = async (sessionId: string, storeId: string) => {
      const response = await http.get(
        `${api}/session-documents?sessionId=${sessionId}&storeId=${storeId}&page=1&pageSize=20`,
      );
      expect(response.status()).toBe(200);
      const data = (await response.json()).data as {
        lines: { productId: string; requestedQuantity: number }[];
      }[];
      return Object.fromEntries(
        data
          .flatMap((document) => document.lines)
          .map((line) => [line.productId, line.requestedQuantity]),
      );
    };
    expect(await documentLines(s1!.id, storeA.id)).toEqual({ [x.id]: 5, [y.id]: 1 });
    expect(await documentLines(s2.id, storeA.id)).toEqual({ [x.id]: 4 });
    expect(await documentLines(s3.id, storeA.id)).toEqual({});

    // 3. Order history keeps every original request with its own session.
    await page.goto('/allocations?tab=history');
    const history = page.getByRole('region', { name: 'Lịch sử đặt hàng theo cửa hàng' });
    // Scoped to the filter form: once rows render, their document buttons are labelled
    // "… của Cửa hàng …" and would also match a bare getByLabel('Cửa hàng').
    await history
      .getByRole('form', { name: 'Bộ lọc lịch sử đặt hàng' })
      .getByLabel('Cửa hàng')
      .selectOption(storeA.id);
    await expect(page).toHaveURL(new RegExp(`ls\\.store=${storeA.id}`, 'u'));
    const rows = history.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(a3.code);
    await expect(rows.nth(0)).toContainText(s2.code);
    await expect(rows.nth(1)).toContainText(a2.code);
    await expect(rows.nth(2)).toContainText(a1.code);
    await expect(rows.nth(2)).toContainText(s1!.code);
    await expect(rows.nth(2)).toContainText('2 bao');
    await expect(rows.nth(2)).toContainText('1 bao');
    await expect(rows.nth(2)).toContainText('Đã gộp');
    await page.reload();
    await expect(history.locator('tbody tr')).toHaveCount(3);

    for (const width of [360, 390, 412, 768, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      const table = await history.locator('.responsive-table').evaluate((element) => ({
        client: element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(table.right).toBeLessThanOrEqual(width + 1);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`order-history-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // The merged request opens the document of its own session and store.
    await rows
      .nth(2)
      .getByRole('button', { name: `Xem chứng từ phiên ${s1!.code} của ${storeA.name}` })
      .click();
    await expect(page.getByRole('heading', { name: 'Kết quả phân bổ đã lưu' })).toBeFocused();
    await expect(page.getByLabel('Lọc kết quả theo phiên')).toHaveValue(s1!.id);
    await expect(page.getByLabel('Lọc kết quả theo cửa hàng')).toHaveValue(storeA.id);
    await expect(page.locator('.session-document').first()).toContainText(s1!.code);

    // 4. A restart replays every job; nothing is added and nothing moves between sessions.
    expect(await runAll()).toEqual([true, true, true, true, true, true]);
    expect(await documentLines(s1!.id, storeA.id)).toEqual({ [x.id]: 5, [y.id]: 1 });
    expect(await documentLines(s2.id, storeA.id)).toEqual({ [x.id]: 4 });

    // 5. HTKD sees only the assigned store and cannot schedule sessions.
    await http.post(`${api}/auth/logout`);
    await login(page, htkdUsername, htkdPassword);
    await page.goto(`/allocations?tab=history&ls.session=${s2.id}`);
    await expect(page.getByRole('tab', { name: 'Tạo phiên mới' })).toHaveCount(0);
    const htkdRows = page
      .getByRole('region', { name: 'Lịch sử đặt hàng theo cửa hàng' })
      .locator('tbody tr');
    await expect(htkdRows).toHaveCount(1);
    await expect(htkdRows.first()).toContainText(a3.code);
    await expect(page.getByText(b1.code)).toHaveCount(0);
    const htkdHttp = tabApi(page);
    expect((await htkdHttp.get(`${api}/order-history?storeId=${storeB.id}`)).status()).toBe(403);
    const forbiddenCreate = await htkdHttp.post(`${api}/order-sessions`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        businessDate: date,
        requestOpensAt: vn(date, '00:00').toISOString(),
        requestClosesAt: vn(date, `16:${minute}`).toISOString(),
        allocationStartsAt: vn(date, `17:${minute}`).toISOString(),
      },
    });
    expect(forbiddenCreate.status()).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});

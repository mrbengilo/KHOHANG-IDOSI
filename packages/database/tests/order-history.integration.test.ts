import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  db,
  listOrderHistory,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  storeGroups,
  stores,
  users,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('original order history', () => {
  afterAll(() => closeDatabase());

  /** Three stores, two same-day sessions, multi-line requests, a cancellation and a merge. */
  async function fixture() {
    const token = randomUUID().replaceAll('-', '');
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!admin || !group) throw new Error('Reference seed and admin are required.');
    const productRows = await db
      .insert(products)
      .values(
        ['X', 'Y', 'Z'].map((name) => ({
          sku: `HIST-${name}-${token}`,
          slug: `hist-${name.toLowerCase()}-${token}`,
          name: `Lịch sử ${name} ${'rất dài '.repeat(4)}${token.slice(0, 4)}`,
        })),
      )
      .returning();
    const [x, y, z] = productRows as [
      (typeof productRows)[number],
      (typeof productRows)[number],
      (typeof productRows)[number],
    ];
    const storeRows = await db
      .insert(stores)
      .values(
        ['A', 'B', 'C'].map((name) => ({
          code: `HIST-${name}-${token}`,
          name: `Cửa hàng ${name}`,
          groupId: group.id,
          kind: 'retail' as const,
        })),
      )
      .returning();
    const [a, b, c] = storeRows as [
      (typeof storeRows)[number],
      (typeof storeRows)[number],
      (typeof storeRows)[number],
    ];
    const date = new Date(
      Date.UTC(2040, 0, 1) + (Number.parseInt(token.slice(0, 8), 16) % 10_000) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const session = async (close: string) => {
      const [row] = await db
        .insert(orderSessions)
        .values({
          code: '',
          kind: 'manual',
          businessDate: date,
          status: 'open',
          openedAt: new Date(`${date}T00:00:00+07:00`),
          inventorySnapshotDueAt: new Date(`${date}T${close}:00+07:00`),
          requestDeadlineAt: new Date(`${date}T${close}:30+07:00`),
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      return row!;
    };
    const s1 = await session('08:00');
    const s2 = await session('10:00');
    // Submitted the evening before the business date: submission day ≠ session day.
    const base = new Date(`${date}T00:00:00+07:00`).getTime() - 2 * 3_600_000;
    const request = async (
      sessionId: string,
      storeId: string,
      requestNumber: number,
      minutes: number,
      lines: readonly (readonly [string, number])[],
      status: 'submitted' | 'cancelled' | 'merged' = 'submitted',
    ) => {
      const submittedAt = new Date(base + minutes * 60_000);
      const [row] = await db
        .insert(orderRequests)
        .values({
          orderSessionId: sessionId,
          storeId,
          requestNumber,
          status,
          requestedByUserId: admin.id,
          submittedAt,
          ...(status === 'cancelled'
            ? { cancelledAt: submittedAt, cancellationReason: 'Nhập nhầm số lượng' }
            : {}),
        })
        .returning();
      const items = await db
        .insert(orderRequestItems)
        .values(
          lines.map(([productId, quantity]) => ({
            orderRequestId: row!.id,
            productId,
            requestedQuantity: quantity,
          })),
        )
        .returning();
      return { ...row!, items };
    };
    const a1 = await request(s1.id, a.id, 1, 10, [
      [x.id, 2],
      [y.id, 1],
    ]);
    const a2 = await request(s1.id, a.id, 2, 20, [[x.id, 3]]);
    const b1 = await request(s1.id, b.id, 1, 30, [
      [x.id, 1],
      [y.id, 1],
      [z.id, 4],
    ]);
    const c1 = await request(s2.id, c.id, 1, 40, [[z.id, 2]], 'cancelled');
    const a3 = await request(s2.id, a.id, 1, 24 * 60 + 60, [[x.id, 4]]);
    return { admin, x, y, z, a, b, c, s1, s2, a1, a2, b1, c1, a3, date };
  }

  it('returns every original line, newest first, scoped to the given stores', async () => {
    const f = await fixture();
    const scope = [f.a.id, f.b.id, f.c.id];
    const all = await listOrderHistory(db, { page: 1, pageSize: 10, storeIds: scope });
    expect(all.pagination.totalItems).toBe(5);
    expect(all.data.map((entry) => entry.id)).toEqual(
      [f.a3, f.c1, f.b1, f.a2, f.a1].map((row) => row.id),
    );
    const a1 = all.data.find((entry) => entry.id === f.a1.id)!;
    expect(a1.lines.map((line) => [line.productId, line.requestedQuantity])).toEqual([
      [f.x.id, 2],
      [f.y.id, 1],
    ]);
    expect(a1.session).toMatchObject({ id: f.s1.id, kind: 'manual', businessDate: f.date });
    const cancelled = all.data.find((entry) => entry.id === f.c1.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('Nhập nhầm số lượng');

    // HTKD scope: other stores never appear, not even in the count.
    const onlyA = await listOrderHistory(db, { page: 1, pageSize: 10, storeIds: [f.a.id] });
    expect(onlyA.pagination.totalItems).toBe(3);
    expect(new Set(onlyA.data.map((entry) => entry.storeId))).toEqual(new Set([f.a.id]));
    expect(await listOrderHistory(db, { page: 1, pageSize: 10, storeIds: [] })).toMatchObject({
      data: [],
      pagination: { totalItems: 0 },
    });

    // An independent SQL count over the same scope agrees with the API page count.
    const [independent] = await db
      .select({ value: count() })
      .from(orderRequests)
      .where(
        and(
          inArray(orderRequests.storeId, scope),
          isNotNull(orderRequests.submittedAt),
          isNull(orderRequests.deletedAt),
        ),
      );
    expect(independent?.value).toBe(all.pagination.totalItems);
  });

  it('never cuts a multi-line request at a page boundary', async () => {
    const f = await fixture();
    const scope = [f.a.id, f.b.id, f.c.id];
    const seen = new Map<string, number>();
    for (let page = 1; page <= 3; page += 1) {
      const result = await listOrderHistory(db, { page, pageSize: 2, storeIds: scope });
      for (const entry of result.data) seen.set(entry.id, entry.lines.length);
    }
    expect(seen.size).toBe(5);
    expect(seen.get(f.b1.id)).toBe(3);
  });

  it('filters by session, status, product, code and submission dates', async () => {
    const f = await fixture();
    const scope = [f.a.id, f.b.id, f.c.id];
    const bySession = await listOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: scope,
      sessionId: f.s2.id,
    });
    expect(bySession.data.map((entry) => entry.id).sort()).toEqual([f.a3.id, f.c1.id].sort());

    const cancelled = await listOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: scope,
      status: 'cancelled',
    });
    expect(cancelled.data.map((entry) => entry.id)).toEqual([f.c1.id]);

    // The product filter selects requests but keeps all of their lines, flagging the match.
    const byProduct = await listOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: scope,
      productId: f.z.id,
    });
    expect(byProduct.data.map((entry) => entry.id).sort()).toEqual([f.b1.id, f.c1.id].sort());
    const b1 = byProduct.data.find((entry) => entry.id === f.b1.id)!;
    expect(b1.lines).toHaveLength(3);
    expect(b1.lines.filter((line) => line.matchesFilter).map((line) => line.productId)).toEqual([
      f.z.id,
    ]);

    const byCode = await listOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: scope,
      code: f.a2.code,
    });
    expect(byCode.data.map((entry) => entry.id)).toEqual([f.a2.id]);

    // a3 was submitted on the business date itself; the others the evening before.
    const dayStart = new Date(`${f.date}T00:00:00+07:00`);
    const sameDay = await listOrderHistory(db, {
      page: 1,
      pageSize: 10,
      storeIds: scope,
      submittedFrom: dayStart,
      submittedBefore: new Date(dayStart.getTime() + 86_400_000),
    });
    expect(sameDay.data.map((entry) => entry.id)).toEqual([f.a3.id]);
  });

  it('links a merged request to the document of its own session and store', async () => {
    const f = await fixture();
    const [merged] = await db
      .insert(mergedOrders)
      .values({
        orderSessionId: f.s1.id,
        storeId: f.a.id,
        version: 1,
        status: 'allocated',
        requestCount: 2,
      })
      .returning();
    const [item] = await db
      .insert(mergedOrderItems)
      .values({ mergedOrderId: merged!.id, productId: f.x.id, requestedQuantity: 5 })
      .returning();
    await db.insert(mergedOrderSources).values([
      {
        mergedOrderItemId: item!.id,
        orderRequestItemId: f.a1.items.find((line) => line.productId === f.x.id)!.id,
        requestedQuantity: 2,
      },
      {
        mergedOrderItemId: item!.id,
        orderRequestItemId: f.a2.items[0]!.id,
        requestedQuantity: 3,
      },
    ]);
    await db
      .update(orderRequests)
      .set({ status: 'merged' })
      .where(inArray(orderRequests.id, [f.a1.id, f.a2.id]));
    const history = await listOrderHistory(db, { page: 1, pageSize: 10, storeIds: [f.a.id] });
    const a1 = history.data.find((entry) => entry.id === f.a1.id)!;
    const a3 = history.data.find((entry) => entry.id === f.a3.id)!;
    expect(a1.mergedDocument).toEqual({
      orderRequestId: f.a1.id,
      mergedOrderId: merged!.id,
      sessionId: f.s1.id,
      storeId: f.a.id,
      version: 1,
    });
    expect(a1.status).toBe('merged');
    // The original quantities stay as submitted after merging.
    expect(a1.lines.map((line) => line.requestedQuantity)).toEqual([2, 1]);
    expect(a3.mergedDocument).toBeNull();
  });
});

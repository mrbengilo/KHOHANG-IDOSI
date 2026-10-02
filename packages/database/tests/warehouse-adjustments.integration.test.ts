import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyWarehouseMovement,
  auditLogs,
  closeDatabase,
  createWarehouseStockAdjustment,
  db,
  listWarehouseStockAdjustments,
  loadWarehouseBalancesAt,
  products,
  users,
  WAREHOUSE_ADJUSTMENT_SOURCE_TYPE,
  WarehouseAdjustmentAuthorizationError,
  WarehouseAdjustmentIdempotencyConflictError,
  WarehouseAdjustmentInsufficientStockError,
  WarehouseAdjustmentValidationError,
  WarehouseAdjustmentVersionConflictError,
  warehouseBalances,
  warehouseLedgerEntries,
  warehouseStockAdjustments,
} from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('audited central-warehouse stock adjustments', () => {
  afterAll(() => closeDatabase());

  async function fixture(onHand: number, reserved: number, active = true) {
    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);
    if (!admin) throw new Error('Bootstrap admin is required.');
    const token = randomUUID().replaceAll('-', '');
    const [product] = await db
      .insert(products)
      .values({
        sku: `ADJ-${token}`,
        slug: `adj-${token}`,
        name: `Adjustment product ${token.slice(0, 6)}`,
        isActive: active,
      })
      .returning();
    const [htkd] = await db
      .insert(users)
      .values({
        email: `adj.htkd.${token}`,
        displayName: 'Adjustment HTKD',
        passwordHash: admin.passwordHash,
        role: 'htkd',
      })
      .returning();
    if (onHand > 0) {
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'opening_balance',
          onHandDelta: onHand,
          reservedDelta: 0,
          sourceType: 'adjustment_test',
          sourceId: randomUUID(),
          occurredAt: new Date(Date.now() - 60_000),
        }),
      );
    }
    if (reserved > 0) {
      await db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: reserved,
          sourceType: 'adjustment_test_hold',
          sourceId: randomUUID(),
          occurredAt: new Date(Date.now() - 50_000),
        }),
      );
    }
    return { admin, htkd: htkd!, product: product! };
  }

  const balanceOf = async (productId: string) => {
    const [row] = await db
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, productId));
    return row!;
  };

  const adjust = (
    input: Partial<Parameters<typeof createWarehouseStockAdjustment>[1]> & {
      productId: string;
      actorUserId: string;
      expectedVersion: number;
    },
  ) =>
    createWarehouseStockAdjustment(db, {
      direction: 'increase',
      quantity: 1,
      reasonCode: 'count_correction',
      reason: 'Kiểm kê định kỳ',
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      ...input,
    });

  it('increases and decreases on-hand bags without touching reserved stock', async () => {
    const { admin, product } = await fixture(10, 4);
    const start = await balanceOf(product.id);
    expect([start.onHandQuantity, start.reservedQuantity, start.availableQuantity]).toEqual([
      10, 4, 6,
    ]);

    const increase = await adjust({
      productId: product.id,
      actorUserId: admin.id,
      expectedVersion: start.version,
      direction: 'increase',
      quantity: 3,
    });
    expect(increase.replayed).toBe(false);
    expect(increase.adjustment).toMatchObject({
      code: expect.stringMatching(/^DCK-\d{6}$/u),
      onHandBefore: 10,
      onHandAfter: 13,
      reservedBefore: 4,
      reservedAfter: 4,
      balanceVersionBefore: start.version,
      balanceVersionAfter: start.version + 1,
    });
    const afterIncrease = await balanceOf(product.id);
    expect([afterIncrease.onHandQuantity, afterIncrease.reservedQuantity]).toEqual([13, 4]);
    expect(afterIncrease.availableQuantity).toBe(9);

    // Taking 10 bags would eat into the 4 held bags; it is refused and nothing changes.
    await expect(
      adjust({
        productId: product.id,
        actorUserId: admin.id,
        expectedVersion: afterIncrease.version,
        direction: 'decrease',
        quantity: 10,
      }),
    ).rejects.toBeInstanceOf(WarehouseAdjustmentInsufficientStockError);
    expect((await balanceOf(product.id)).version).toBe(afterIncrease.version);

    const decrease = await adjust({
      productId: product.id,
      actorUserId: admin.id,
      expectedVersion: afterIncrease.version,
      direction: 'decrease',
      quantity: 2,
      reasonCode: 'damage',
      reason: 'Bao rách khi bốc xếp',
    });
    const afterDecrease = await balanceOf(product.id);
    expect([
      afterDecrease.onHandQuantity,
      afterDecrease.reservedQuantity,
      afterDecrease.availableQuantity,
    ]).toEqual([11, 4, 7]);

    // One document, one ledger entry and one audit row for each accepted adjustment.
    const ledger = await db
      .select()
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.productId, product.id),
          eq(warehouseLedgerEntries.sourceType, WAREHOUSE_ADJUSTMENT_SOURCE_TYPE),
        ),
      )
      .orderBy(asc(warehouseLedgerEntries.createdAt));
    expect(ledger.map((entry) => [entry.onHandDelta, entry.reservedDelta])).toEqual([
      [3, 0],
      [-2, 0],
    ]);
    expect(ledger.map((entry) => entry.sourceId).sort()).toEqual(
      [increase.adjustment.id, decrease.adjustment.id].sort(),
    );
    expect(ledger.every((entry) => entry.actorUserId === admin.id)).toBe(true);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'WAREHOUSE_STOCK_ADJUSTED'));
    const own = audits.filter((row) =>
      [increase.adjustment.id, decrease.adjustment.id].includes(row.entityId ?? ''),
    );
    expect(own).toHaveLength(2);
    expect(own.find((row) => row.entityId === decrease.adjustment.id)).toMatchObject({
      before: { onHand: 13, reserved: 4, available: 9 },
      after: { onHand: 11, reserved: 4, available: 7 },
      metadata: { delta: -2, reasonCode: 'damage', reason: 'Bao rách khi bốc xếp' },
    });

    // The balance reconciles with the whole ledger of the product.
    const [sum] = await db
      .select({
        onHand: sql<number>`sum(${warehouseLedgerEntries.onHandDelta})`.mapWith(Number),
        reserved: sql<number>`sum(${warehouseLedgerEntries.reservedDelta})`.mapWith(Number),
      })
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.productId, product.id));
    expect(sum).toEqual({ onHand: 11, reserved: 4 });

    // Documents are immutable.
    await expect(
      db
        .update(warehouseStockAdjustments)
        .set({ reason: 'sửa lại' })
        .where(eq(warehouseStockAdjustments.id, decrease.adjustment.id)),
    ).rejects.toThrow();
  });

  it('replays the same key once, refuses a reused key and a stale version', async () => {
    const { admin, product } = await fixture(5, 0);
    const start = await balanceOf(product.id);
    const key = randomUUID();
    const input = {
      productId: product.id,
      actorUserId: admin.id,
      expectedVersion: start.version,
      quantity: 2,
      idempotencyKey: key,
      requestHash: 'same-payload',
    };
    const first = await adjust(input);
    const replay = await adjust(input);
    expect(replay.replayed).toBe(true);
    expect(replay.adjustment.id).toBe(first.adjustment.id);
    expect((await balanceOf(product.id)).onHandQuantity).toBe(7);
    await expect(adjust({ ...input, requestHash: 'other-payload' })).rejects.toBeInstanceOf(
      WarehouseAdjustmentIdempotencyConflictError,
    );
    // A new key with the version read before the first adjustment is stale.
    await expect(adjust({ ...input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(
      WarehouseAdjustmentVersionConflictError,
    );
    const documents = await db
      .select()
      .from(warehouseStockAdjustments)
      .where(eq(warehouseStockAdjustments.productId, product.id));
    expect(documents).toHaveLength(1);
  });

  it('lets two administrators race on one version without losing an update', async () => {
    const { admin, product } = await fixture(8, 2);
    const [second] = await db
      .insert(users)
      .values({
        email: `adj.admin.${randomUUID()}`,
        displayName: 'Second admin',
        passwordHash: admin.passwordHash,
        role: 'admin',
      })
      .returning();
    const start = await balanceOf(product.id);
    const results = await Promise.allSettled([
      adjust({
        productId: product.id,
        actorUserId: admin.id,
        expectedVersion: start.version,
        direction: 'decrease',
        quantity: 5,
      }),
      adjust({
        productId: product.id,
        actorUserId: second!.id,
        expectedVersion: start.version,
        direction: 'decrease',
        quantity: 5,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(
      WarehouseAdjustmentVersionConflictError,
    );
    const end = await balanceOf(product.id);
    expect([end.onHandQuantity, end.reservedQuantity]).toEqual([3, 2]);
  });

  it('stays consistent with concurrent holds taken by the allocation worker', async () => {
    const { admin, product } = await fixture(6, 0);
    const start = await balanceOf(product.id);
    const results = await Promise.allSettled([
      adjust({
        productId: product.id,
        actorUserId: admin.id,
        expectedVersion: start.version,
        direction: 'decrease',
        quantity: 4,
      }),
      db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product.id,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: 4,
          sourceType: 'adjustment_race_hold',
          sourceId: randomUUID(),
        }),
      ),
    ]);
    // Whatever commits first, the other sees its effect: never on-hand < reserved.
    const end = await balanceOf(product.id);
    expect(end.reservedQuantity).toBeLessThanOrEqual(end.onHandQuantity);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
    const [sum] = await db
      .select({
        onHand: sql<number>`sum(${warehouseLedgerEntries.onHandDelta})`.mapWith(Number),
        reserved: sql<number>`sum(${warehouseLedgerEntries.reservedDelta})`.mapWith(Number),
      })
      .from(warehouseLedgerEntries)
      .where(eq(warehouseLedgerEntries.productId, product.id));
    expect(sum).toEqual({ onHand: end.onHandQuantity, reserved: end.reservedQuantity });
  });

  it('authorizes only active administrators and keeps inactive products decrease-only', async () => {
    const { admin, htkd, product } = await fixture(3, 0, false);
    const start = await balanceOf(product.id);
    await expect(
      adjust({ productId: product.id, actorUserId: htkd.id, expectedVersion: start.version }),
    ).rejects.toBeInstanceOf(WarehouseAdjustmentAuthorizationError);
    await expect(
      adjust({ productId: product.id, actorUserId: admin.id, expectedVersion: start.version }),
    ).rejects.toBeInstanceOf(WarehouseAdjustmentValidationError);
    const writeOff = await adjust({
      productId: product.id,
      actorUserId: admin.id,
      expectedVersion: start.version,
      direction: 'decrease',
      quantity: 1,
      reasonCode: 'damage',
    });
    // A mistake is corrected by a new opposite adjustment that references the old one.
    await expect(
      adjust({
        productId: product.id,
        actorUserId: admin.id,
        expectedVersion: start.version + 1,
        direction: 'decrease',
        compensatesAdjustmentId: writeOff.adjustment.id,
      }),
    ).rejects.toBeInstanceOf(WarehouseAdjustmentValidationError);
    for (const quantity of [0, -1, 1.5, Number.NaN, 100_001]) {
      await expect(
        adjust({ productId: product.id, actorUserId: admin.id, expectedVersion: 0, quantity }),
      ).rejects.toBeInstanceOf(WarehouseAdjustmentValidationError);
    }
    await expect(
      adjust({ productId: product.id, actorUserId: admin.id, expectedVersion: 0, reason: '  a ' }),
    ).rejects.toBeInstanceOf(WarehouseAdjustmentValidationError);
  });

  it('pages history newest first and filters by product, direction and time', async () => {
    const { admin, product } = await fixture(20, 0);
    let version = (await balanceOf(product.id)).version;
    for (const [direction, quantity] of [
      ['increase', 1],
      ['decrease', 2],
      ['increase', 3],
    ] as const) {
      await adjust({
        productId: product.id,
        actorUserId: admin.id,
        expectedVersion: version,
        direction,
        quantity,
      });
      version += 1;
    }
    const page1 = await listWarehouseStockAdjustments(db, {
      page: 1,
      pageSize: 2,
      productId: product.id,
    });
    expect(page1.pagination).toMatchObject({ totalItems: 3, totalPages: 2 });
    expect(page1.data.map((row) => row.quantity)).toEqual([3, 2]);
    const page2 = await listWarehouseStockAdjustments(db, {
      page: 2,
      pageSize: 2,
      productId: product.id,
    });
    expect(page2.data.map((row) => row.quantity)).toEqual([1]);
    const decreases = await listWarehouseStockAdjustments(db, {
      page: 1,
      pageSize: 10,
      productId: product.id,
      direction: 'decrease',
    });
    expect(decreases.data.map((row) => row.quantity)).toEqual([2]);
    const future = await listWarehouseStockAdjustments(db, {
      page: 1,
      pageSize: 10,
      productId: product.id,
      createdFrom: new Date(Date.now() + 86_400_000),
    });
    expect(future.data).toHaveLength(0);
  });

  it('keeps an earlier snapshot unchanged and shows the adjustment in a later one', async () => {
    const { admin, product } = await fixture(4, 0);
    const before = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adjust({
      productId: product.id,
      actorUserId: admin.id,
      expectedVersion: (await balanceOf(product.id)).version,
      quantity: 6,
    });
    const historical = await db.transaction((tx) => loadWarehouseBalancesAt(tx, before));
    const current = await db.transaction((tx) => loadWarehouseBalancesAt(tx, new Date()));
    expect(historical.find((row) => row.productId === product.id)?.onHand).toBe(4);
    expect(current.find((row) => row.productId === product.id)?.onHand).toBe(10);
  });
});

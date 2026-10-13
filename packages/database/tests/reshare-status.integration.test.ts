import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  closeDatabase,
  db,
  listReshareOrderHistory,
  reshareOrders,
  updateReshareOrderStatus,
  users,
} from '../src/index.js';
import {
  balanceOf,
  createProduct,
  ledgerTotals,
  openingStock,
  publishPendingResult,
  respond,
} from './fixtures/reshare.js';
import { createSupplierFixture, type SupplierFixture } from './fixtures/supplier.js';

const postgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
postgres('Admin Reshare status persistence and inventory invariants', () => {
  let fx: SupplierFixture;
  beforeAll(async () => {
    fx = await createSupplierFixture();
  });
  afterAll(closeDatabase);
  async function fixture(acceptedLegacy = false) {
    const productId = await createProduct('Admin acknowledgement');
    await openingStock(productId, 10);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId, quantity: 3 }],
      acceptedLegacy,
    });
    return { ...result, productId };
  }
  function command(
    decisionId: string,
    overrides: Partial<Parameters<typeof updateReshareOrderStatus>[1]> = {},
  ) {
    return {
      decisionId,
      actorUserId: fx.adminId,
      status: 'ORDERED' as const,
      expectedStatus: 'NOT_ORDERED' as const,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      ...overrides,
    };
  }
  async function read(decisionId: string, status?: 'ordered' | 'not_ordered') {
    return listReshareOrderHistory(db, {
      decisionId,
      page: 1,
      pageSize: 20,
      ...(status ? { status } : {}),
    });
  }

  it('persists both directions for an accepted legacy result without RE, filters and audits once, never changes stock', async () => {
    const result = await fixture(true);
    // Historical acceptance predating RE: no order or issue can be fabricated by this command.
    const stock = await balanceOf(result.productId);
    const ledger = await ledgerTotals(result.productId);
    const input = command(result.decisionId);
    expect((await updateReshareOrderStatus(db, input)).replayed).toBe(false);
    expect((await updateReshareOrderStatus(db, input)).replayed).toBe(true);
    expect((await read(result.decisionId, 'ordered')).data[0]).toMatchObject({
      status: 'ordered',
      order: null,
      statusControl: { version: 1, updatedByName: 'Supplier admin' },
    });
    expect((await read(result.decisionId, 'not_ordered')).pagination.totalItems).toBe(0);
    await expect(
      updateReshareOrderStatus(db, { ...input, requestHash: 'different' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(updateReshareOrderStatus(db, command(result.decisionId))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await updateReshareOrderStatus(
      db,
      command(result.decisionId, {
        status: 'NOT_ORDERED',
        expectedStatus: 'ORDERED',
        expectedVersion: 1,
      }),
    );
    expect((await read(result.decisionId, 'not_ordered')).data[0]).toMatchObject({
      status: 'not_ordered',
      statusControl: { version: 2 },
    });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, result.decisionId),
          eq(auditLogs.action, 'RESHARE_ORDER_STATUS_UPDATED'),
        ),
      );
    expect(audit).toHaveLength(2);
    expect(audit.every((row) => row.actorUserId === fx.adminId && row.actorRole === 'admin')).toBe(
      true,
    );
    expect(audit.map((row) => row.after?.status).sort()).toEqual(['not_ordered', 'ordered']);
    expect(await balanceOf(result.productId)).toEqual(stock);
    expect(await ledgerTotals(result.productId)).toEqual(ledger);
    expect(
      await db
        .select()
        .from(reshareOrders)
        .where(eq(reshareOrders.allocationDecisionId, result.decisionId)),
    ).toHaveLength(0);
  });

  it('keeps pending acceptance independent and keeps the acknowledgement when acceptance later creates RE', async () => {
    const result = await fixture();
    await updateReshareOrderStatus(db, command(result.decisionId));
    expect((await read(result.decisionId)).data[0]).toMatchObject({
      decisionStatus: 'pending',
      status: 'ordered',
      order: null,
    });
    await updateReshareOrderStatus(
      db,
      command(result.decisionId, {
        status: 'NOT_ORDERED',
        expectedStatus: 'ORDERED',
        expectedVersion: 1,
      }),
    );
    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    expect((await read(result.decisionId)).data[0]).toMatchObject({
      decisionStatus: 'accepted',
      status: 'not_ordered',
      statusControl: { version: 2 },
      order: { status: 'ordered' },
    });
    const stock = await balanceOf(result.productId);
    await updateReshareOrderStatus(db, command(result.decisionId, { expectedVersion: 2 }));
    expect(await balanceOf(result.productId)).toEqual(stock);
    expect((await read(result.decisionId, 'ordered')).pagination.totalItems).toBe(1);
  });

  it('rejects HTKD/store and a revoked Admin even on replay', async () => {
    const result = await fixture();
    for (const actorUserId of [fx.htkdId, fx.otherHtkdId, fx.storeUserA]) {
      await expect(
        updateReshareOrderStatus(db, command(result.decisionId, { actorUserId })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const other = await createSupplierFixture();
    const input = command(result.decisionId, { actorUserId: other.adminId });
    await updateReshareOrderStatus(db, input);
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, other.adminId));
    await expect(updateReshareOrderStatus(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serializes concurrent admins and rejects stale state after automatic RE creation', async () => {
    const result = await fixture();
    const other = await createSupplierFixture();
    const results = await Promise.allSettled([
      updateReshareOrderStatus(db, command(result.decisionId)),
      updateReshareOrderStatus(
        db,
        command(result.decisionId, { actorUserId: other.adminId, status: 'NOT_ORDERED' }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    const next = await fixture();
    await respond(next.decisionId, fx.storeUserA, 'ACCEPT');
    await expect(updateReshareOrderStatus(db, command(next.decisionId))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('rejects rejected and cancelled results and unknown IDs', async () => {
    const result = await fixture();
    await respond(result.decisionId, fx.storeUserA, 'REJECT');
    await expect(updateReshareOrderStatus(db, command(result.decisionId))).rejects.toMatchObject({
      code: 'ORDER_SOURCE_NOT_ELIGIBLE',
    });
    await expect(updateReshareOrderStatus(db, command(randomUUID()))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const next = await fixture();
    await respond(next.decisionId, fx.storeUserA, 'ACCEPT');
    await db
      .update(reshareOrders)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledByUserId: fx.adminId,
        cancelReason: 'Fixture cancellation',
        version: 2,
      })
      .where(eq(reshareOrders.allocationDecisionId, next.decisionId));
    await expect(
      updateReshareOrderStatus(db, command(next.decisionId, { expectedStatus: 'ORDERED' })),
    ).rejects.toMatchObject({ code: 'ORDER_SOURCE_NOT_ELIGIBLE' });
  });
});

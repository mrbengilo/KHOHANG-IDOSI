import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  closeDatabase,
  htkdAssignments,
  db,
  listReshareOrderHistory,
  listReshareStatusHistory,
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
postgres('Admin/HTKD Reshare status persistence, history and inventory invariants', () => {
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

  it('lets any active HTKD act on every store with its real role; refuses stores, locked or demoted accounts even on replay', async () => {
    const result = await fixture();
    // fx.otherHtkdId is assigned to store B only: the result of store A is still in scope.
    const byOther = command(result.decisionId, { actorUserId: fx.otherHtkdId });
    expect((await updateReshareOrderStatus(db, byOther)).replayed).toBe(false);
    await expect(
      updateReshareOrderStatus(db, command(result.decisionId, { actorUserId: fx.storeUserA })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [event] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, result.decisionId),
          eq(auditLogs.action, 'RESHARE_ORDER_STATUS_UPDATED'),
        ),
      );
    expect(event).toMatchObject({
      actorUserId: fx.otherHtkdId,
      actorRole: 'htkd',
      metadata: { actorName: 'Supplier htkd-other', reshareOrderCode: null },
    });
    // Removing every assignment keeps the module-wide right; a role change or lock ends it.
    const other = await createSupplierFixture();
    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(htkdAssignments.userId, other.htkdId));
    const unassigned = command(result.decisionId, {
      actorUserId: other.htkdId,
      status: 'NOT_ORDERED',
      expectedStatus: 'ORDERED',
      expectedVersion: 1,
    });
    expect((await updateReshareOrderStatus(db, unassigned)).replayed).toBe(false);
    await db.update(users).set({ role: 'wholesale' }).where(eq(users.id, other.htkdId));
    await expect(updateReshareOrderStatus(db, unassigned)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, fx.otherHtkdId));
    await expect(updateReshareOrderStatus(db, byOther)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const input = command(result.decisionId, {
      actorUserId: other.adminId,
      expectedVersion: 2,
    });
    await updateReshareOrderStatus(db, input);
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, other.adminId));
    await expect(updateReshareOrderStatus(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.update(users).set({ status: 'active' }).where(eq(users.id, fx.otherHtkdId));
  });

  it('keeps an append-only history with real actors, name snapshots and a stable order', async () => {
    const result = await fixture();
    const history = async (page = 1, pageSize = 20) => {
      const found = await listReshareStatusHistory(db, {
        decisionId: result.decisionId,
        page,
        pageSize,
      });
      if (!found) throw new Error('The result exists, so its history must too.');
      return found;
    };
    expect(await history()).toMatchObject({ totalItems: 0, data: [] });
    await updateReshareOrderStatus(db, command(result.decisionId, { actorUserId: fx.htkdId }));
    // Asking for the current status: no new version, no X → X event.
    const same = await updateReshareOrderStatus(
      db,
      command(result.decisionId, { expectedStatus: 'ORDERED', expectedVersion: 1 }),
    );
    expect(same.replayed ? null : same.value).toMatchObject({ version: 1, status: 'ORDERED' });
    // Stale version and validation errors leave no event.
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
    await db.update(users).set({ displayName: 'Renamed HTKD' }).where(eq(users.id, fx.htkdId));
    await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const page = await history();
    expect(page.totalItems).toBe(3);
    expect(
      page.data.map((event) => [
        event.kind,
        event.source,
        event.statusBefore,
        event.statusAfter,
        event.actorRole,
        event.actorNameSnapshot,
      ]),
    ).toEqual([
      ['created', 'acceptance', 'not_ordered', 'not_ordered', 'store', 'Supplier store-a'],
      ['status_changed', 'manual', 'ordered', 'not_ordered', 'admin', 'Supplier admin'],
      ['status_changed', 'manual', 'not_ordered', 'ordered', 'htkd', 'Supplier htkd'],
    ]);
    expect(page.data[0]!.orderCode).toMatch(/^RE-\d{6}$/u);
    expect(page.data[2]!.actorCurrentName).toBe('Renamed HTKD');
    // Pages never overlap or skip, even for events written in the same millisecond.
    const seen: Awaited<ReturnType<typeof history>>['data'][number][] = [];
    for (let index = 1; index <= 3; index += 1) seen.push(...(await history(index, 1)).data);
    expect(seen.map((event) => event.id)).toEqual(page.data.map((event) => event.id));
    expect(
      await listReshareStatusHistory(db, { decisionId: randomUUID(), page: 1, pageSize: 5 }),
    ).toBeNull();
  });

  it('rolls the status back when its history event cannot be written', async () => {
    const result = await fixture();
    const trigger = `reshare_history_fail_${result.decisionId.replaceAll('-', '')}`;
    await db.execute(
      sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if new.entity_id = '${result.decisionId}' then raise exception 'history write failed'; end if;
          return new;
        end $$;
        create trigger ${trigger} before insert on audit_logs
          for each row execute function ${trigger}();`),
    );
    try {
      await expect(updateReshareOrderStatus(db, command(result.decisionId))).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw(`drop trigger ${trigger} on audit_logs; drop function ${trigger}();`),
      );
    }
    expect((await read(result.decisionId)).data[0]).toMatchObject({
      status: 'not_ordered',
      statusControl: { version: 0, updatedAt: null },
    });
    // The same command succeeds once the history can be written again.
    expect((await updateReshareOrderStatus(db, command(result.decisionId))).replayed).toBe(false);
  });

  it('serializes a concurrent Admin and HTKD and rejects stale state after automatic RE creation', async () => {
    const result = await fixture();
    const results = await Promise.allSettled([
      updateReshareOrderStatus(db, command(result.decisionId)),
      updateReshareOrderStatus(db, command(result.decisionId, { actorUserId: fx.htkdId })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      (await listReshareStatusHistory(db, { decisionId: result.decisionId, page: 1, pageSize: 10 }))
        ?.totalItems,
    ).toBe(1);
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

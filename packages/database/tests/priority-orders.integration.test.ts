import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  db,
  closeDatabase,
  getPriorityContext,
  submitPriorityOrder,
  getPriorityOrder,
  listPriorityOrders,
  updatePriorityReshareStatus,
  users,
  reservations,
  reshareOrders,
  outboundRequests,
  withTransaction,
  withAdvisoryLock,
  STOCK_JOBS_LOCK,
  applyWarehouseMovement,
  getPriorityAvailability,
  allocationResultDecisions,
  stores,
} from '../src/index.js';
import { createSupplierFixture, mapProduct, observe } from './fixtures/supplier.js';
import {
  createProduct,
  openingStock,
  publishPendingResult,
  respond,
  balanceOf,
  ledgerTotals,
  receive,
} from './fixtures/reshare.js';
const pg = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
pg('emergency priority: approve, issue and RE without allocation session', () => {
  afterAll(closeDatabase);
  async function fixture(legacy = false) {
    const fx = await createSupplierFixture(),
      male = await createProduct('Nam'),
      female = await createProduct('Nữ');
    await openingStock(male, 1);
    await openingStock(female, 1);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: male, quantity: 1 }],
      shipment: false,
      ...(legacy ? { legacy: true } : {}),
    });
    if (!legacy) await respond(result.decisionId, fx.storeUserA, 'ACCEPT');
    const context = await getPriorityContext(db, fx.adminId, fx.storeA);
    const source = context.sources.find((s) => s.id === result.reservationIds[0])!;
    const input = {
      storeId: fx.storeA,
      sources: [{ id: source.id, revision: source.revision }],
      additionalLines: [{ productId: female, quantity: 1 }],
      notes: '',
    };
    return { fx, male, female, input, result };
  }
  async function sessions() {
    return (
      await db.execute(
        sql`select (select count(*) from order_sessions) as sessions, (select count(*) from allocation_runs) as runs,(select count(*) from allocation_result_decisions) as decisions,(select count(*) from wait_tickets) as waits, (select md5(coalesce(jsonb_agg(to_jsonb(w) order by w.id)::text,'[]')) from wait_tickets w) as wait_state, (select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.id)::text,'[]')) from store_wait_documents d) as document_state, (select md5(coalesce(jsonb_agg(to_jsonb(o) order by o.id)::text,'[]')) from daily_priority_offers o) as offer_state`,
      )
    ).rows;
  }
  it('issued male + one female commits 2 bags, RE only one new bag; no session or wait mutation; receipt does not issue twice', async () => {
    const { fx, male, female, input } = await fixture();
    const before = await sessions();
    const submitted = await submitPriorityOrder(db, fx.otherHtkdId, input, randomUUID());
    expect(submitted.data).toMatchObject({
      totalQuantity: 2,
      reshareQuantity: 1,
      status: 'dispatched',
      type: 'EMERGENCY_PRIORITY_ORDER',
    });
    expect(submitted.data.sources).toHaveLength(2);
    expect(new Set(submitted.data.sources.map((s) => s.reshareCode)).size).toBe(2);
    expect(await sessions()).toEqual(before);
    expect(await balanceOf(male)).toEqual({ onHand: 0, reserved: 0 });
    expect(await balanceOf(female)).toEqual({ onHand: 0, reserved: 0 });
    expect(await ledgerTotals(female)).toEqual(await balanceOf(female));
    expect((await getPriorityOrder(db, fx.storeUserA, submitted.data.id)).code).toBe(
      submitted.data.code,
    );
    expect((await getPriorityContext(db, fx.adminId, fx.storeA)).sources).toHaveLength(0);
    await receive(fx, {
      outboundId: submitted.data.outboundRequestId,
      storeId: fx.storeA,
      storeUserId: fx.storeUserA,
      lines: [
        { productId: male, approvedQuantity: 1, receivedQuantity: 1 },
        { productId: female, approvedQuantity: 1, receivedQuantity: 1 },
      ],
    });
    expect(await balanceOf(female)).toEqual({ onHand: 0, reserved: 0 });
    expect(await balanceOf(male)).toEqual({ onHand: 0, reserved: 0 });
  });
  it('legacy active source is issued once with added goods and shortages finalize through real receipt workflow', async () => {
    const { fx, male, female, input } = await fixture(true);
    expect(await balanceOf(male)).toEqual({ onHand: 1, reserved: 1 });
    const { data } = await submitPriorityOrder(db, fx.adminId, input, randomUUID());
    expect(data.reshareQuantity).toBe(2);
    expect(await balanceOf(male)).toEqual({ onHand: 0, reserved: 0 });
    await receive(fx, {
      outboundId: data.outboundRequestId,
      storeId: fx.storeA,
      storeUserId: fx.storeUserA,
      lines: [
        { productId: male, approvedQuantity: 1, receivedQuantity: 1 },
        { productId: female, approvedQuantity: 1, receivedQuantity: 0 },
      ],
    });
    expect(await balanceOf(female)).toEqual({ onHand: 0, reserved: 0 });
  });
  it('overstock rolls back, exact stock succeeds, same key replays, changed payload conflicts, locked user cannot replay', async () => {
    const { fx, female, input } = await fixture();
    const key = randomUUID();
    const before = await sessions();
    await expect(
      submitPriorityOrder(
        db,
        fx.adminId,
        { ...input, additionalLines: [{ productId: female, quantity: 2 }] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balanceOf(female)).toEqual({ onHand: 1, reserved: 0 });
    expect(await sessions()).toEqual(before);
    const first = await submitPriorityOrder(db, fx.adminId, input, key),
      second = await submitPriorityOrder(db, fx.adminId, input, key);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);
    await expect(
      submitPriorityOrder(db, fx.adminId, { ...input, notes: 'different' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, fx.adminId));
    await expect(submitPriorityOrder(db, fx.adminId, input, key)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('two actors racing the same source produce exactly one complete order', async () => {
    const { fx, input } = await fixture();
    const results = await Promise.allSettled([
      submitPriorityOrder(db, fx.adminId, input, randomUUID()),
      submitPriorityOrder(db, fx.otherHtkdId, input, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('stock job lock serializes submit with worker and cannot reuse a source attached by worker', async () => {
    const { fx, input, result, male } = await fixture(true);
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r));
    const worker = withTransaction(db, (tx) =>
      withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, async () => {
        locked();
        await barrier;
        await applyWarehouseMovement(tx, {
          productId: male,
          eventType: 'reservation_release',
          onHandDelta: 0,
          reservedDelta: -1,
          sourceType: 'worker_test',
          sourceId: result.runId,
        });
        await tx
          .update(reservations)
          .set({ status: 'released', releasedAt: new Date() })
          .where(eq(reservations.id, result.reservationIds[0]!));
      }),
    );
    await ready;
    const command = submitPriorityOrder(db, fx.adminId, input, randomUUID());
    release();
    await worker;
    await expect(command).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('store cannot create and cannot read another store; Reshare state has optimistic version and audit', async () => {
    const { fx, input } = await fixture();
    await expect(submitPriorityOrder(db, fx.storeUserA, input, randomUUID())).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    const { data } = await submitPriorityOrder(db, fx.adminId, input, randomUUID());
    expect(
      (await listPriorityOrders(db, fx.storeUserA, { page: 1, pageSize: 20 })).data.some(
        (r) => r.id === data.id,
      ),
    ).toBe(true);
    await expect(
      listPriorityOrders(db, fx.storeUserA, { storeId: fx.storeB, page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const changed = await updatePriorityReshareStatus(
      db,
      fx.otherHtkdId,
      data.id,
      { expectedVersion: 1, status: 'NOT_ORDERED' },
      randomUUID(),
    );
    expect(changed.data.reshareStatus).toBe('NOT_ORDERED');
    expect(changed.data.history).toHaveLength(2);
    await expect(
      updatePriorityReshareStatus(
        db,
        fx.adminId,
        data.id,
        { expectedVersion: 1, status: 'ORDERED' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('database deferred guards rollback incomplete emergency order, sources and issue', async () => {
    const { fx, input, female } = await fixture();
    // A failing audit insert occurs after issuance; trigger scoped to this fixture actor only.
    const suffix = randomUUID().replaceAll('-', '');
    await db.execute(
      sql.raw(
        `CREATE FUNCTION fail_emergency_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_user_id='${fx.adminId}' AND NEW.action='EMERGENCY_PRIORITY_ORDER_APPROVED' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_emergency_${suffix} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_emergency_${suffix}();`,
      ),
    );
    try {
      await expect(submitPriorityOrder(db, fx.adminId, input, randomUUID())).rejects.toThrow();
      expect(await balanceOf(female)).toEqual({ onHand: 1, reserved: 0 });
      expect((await getPriorityContext(db, fx.adminId, fx.storeA)).sources).toHaveLength(1);
      expect(
        await db.select().from(reshareOrders).where(eq(reshareOrders.actorUserId, fx.adminId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(outboundRequests)
          .where(eq(outboundRequests.requestedByUserId, fx.adminId)),
      ).toHaveLength(0);
    } finally {
      await db.execute(
        sql.raw(
          `DROP TRIGGER fail_emergency_${suffix} ON audit_logs; DROP FUNCTION fail_emergency_${suffix}();`,
        ),
      );
    }
    await submitPriorityOrder(db, fx.adminId, input, randomUUID());
  });
  it('different stores racing the last bag cannot oversell; losing source is still held', async () => {
    const a = await fixture(),
      b = await fixture();
    b.input.additionalLines = [{ productId: a.female, quantity: 1 }];
    let release!: () => void;
    let ready!: () => void;
    const hold = new Promise<void>((r) => (release = r)),
      locked = new Promise<void>((r) => (ready = r));
    const gate = withTransaction(db, (tx) =>
      withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, async () => {
        ready();
        await hold;
      }),
    );
    await locked;
    const both = Promise.allSettled([
      submitPriorityOrder(db, a.fx.adminId, a.input, randomUUID()),
      submitPriorityOrder(db, b.fx.adminId, b.input, randomUUID()),
    ]);
    release();
    await gate;
    const results = await both;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await balanceOf(a.female)).toEqual({ onHand: 0, reserved: 0 });
    expect(await ledgerTotals(a.female)).toEqual(await balanceOf(a.female));
    const remaining =
      (await getPriorityContext(db, a.fx.adminId, a.fx.storeA)).sources.length +
      (await getPriorityContext(db, b.fx.adminId, b.fx.storeA)).sources.length;
    expect(remaining).toBe(1);
  });
  it('zero availability is explicit; stale preview and inactive store fail without mutation', async () => {
    const { fx, input, female } = await fixture();
    await withTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: female,
        eventType: 'adjustment',
        onHandDelta: -1,
        reservedDelta: 0,
        sourceType: 'test',
        sourceId: randomUUID(),
      }),
    );
    expect(await getPriorityAvailability(db, fx.adminId, fx.storeA, female)).toMatchObject({
      availableBags: 0,
      maxAdditionalBags: 0,
      orderable: false,
      blockingReason: 'Tồn khả dụng = 0, không thể đặt mặt hàng này.',
    });
    await expect(submitPriorityOrder(db, fx.adminId, input, randomUUID())).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    await db.update(stores).set({ isActive: false }).where(eq(stores.id, fx.storeA));
    await expect(submitPriorityOrder(db, fx.adminId, input, randomUUID())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('pending decisions cannot enter context or a forged source command', async () => {
    const fx = await createSupplierFixture(),
      male = await createProduct(),
      female = await createProduct();
    await openingStock(male, 1);
    await openingStock(female, 1);
    const result = await publishPendingResult(fx, {
      storeId: fx.storeA,
      grants: [{ productId: male, quantity: 1 }],
      shipment: false,
    });
    expect((await getPriorityContext(db, fx.adminId, fx.storeA)).sources).toHaveLength(0);
    await expect(
      submitPriorityOrder(
        db,
        fx.adminId,
        {
          storeId: fx.storeA,
          sources: [{ id: result.reservationIds[0]!, revision: 'forged' }],
          additionalLines: [{ productId: female, quantity: 1 }],
          notes: '',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const [decision] = await db
      .select()
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, result.decisionId));
    expect(decision?.status).toBe('pending');
  });
  it('adding the same held SKU uses only additional availability and issues exactly the additional quantity', async () => {
    const { fx, input, male } = await fixture();
    await openingStock(male, 1);
    input.additionalLines = [{ productId: male, quantity: 1 }];
    const { data } = await submitPriorityOrder(db, fx.adminId, input, randomUUID());
    expect(data.lines).toEqual([
      expect.objectContaining({ productId: male, held: 1, additional: 1, total: 2 }),
    ]);
    expect(data.reshareQuantity).toBe(1);
    expect(await balanceOf(male)).toEqual({ onHand: 0, reserved: 0 });
  });
  it('mapped SKU is blocked until reconciled, then issues within the supplier cap', async () => {
    const { fx, input, female } = await fixture();
    await mapProduct(fx, female);
    expect(
      (await getPriorityAvailability(db, fx.adminId, fx.storeA, female)).maxAdditionalBags,
    ).toBe(0);
    await expect(submitPriorityOrder(db, fx.adminId, input, randomUUID())).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    await observe(fx, [{ productId: female, observedQuantity: 1 }], { attest: true });
    expect(
      (await getPriorityAvailability(db, fx.adminId, fx.storeA, female)).maxAdditionalBags,
    ).toBe(1);
    const { data } = await submitPriorityOrder(db, fx.adminId, input, randomUUID());
    expect(data.reshareQuantity).toBe(1);
    expect(await balanceOf(female)).toEqual({ onHand: 0, reserved: 0 });
  });
});

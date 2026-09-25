import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import {
  allocationLines,
  allocationRuns,
  auditLogs,
  applyWarehouseMovement,
  closeDatabase,
  db,
  htkdAssignments,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  reservations,
  storeGroups,
  stores,
  users,
  waitTickets,
  withSerializableTransaction,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';
import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const context = () => ({ requestId: randomUUID(), ipAddress: null, userAgent: null });

describePostgres('PostgreSQL receipt discrepancy adjustments API', () => {
  const repository = new PostgresWarehouseRepository();
  after(async () => {
    await closeDatabase();
  });

  test('store reports, HTKD verifies, admin applies; scope, idempotency and DTOs hold', async () => {
    const fx = await finalizedReceipt(repository);
    const receipt = await repository.getReceipt(fx.store, fx.receiptId);
    assert.equal(receipt.status, 'FINALIZED');
    assert.equal(receipt.adjustmentSummary.effective.goodsVnd, 3_000_000);

    const contextView = await repository.getReceiptAdjustmentContext(fx.store, fx.receiptId);
    assert.equal(contextView.bags.length, 3);
    assert.ok(contextView.bags.every((bag) => bag.effectiveCostVnd === 1_000_000));
    await assert.rejects(
      repository.getReceiptAdjustmentContext(fx.otherStore, fx.receiptId),
      (error) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      repository.getReceiptAdjustmentContext(fx.wholesale, fx.receiptId),
      (error) => error.code === 'FORBIDDEN',
    );

    const input = {
      receiptId: fx.receiptId,
      reason: 'Khui bao thấy 1 bao là jeans',
      evidenceNote: 'Ảnh gửi nhóm HTKD',
      discoveredAt: new Date().toISOString(),
      lines: [
        {
          receiptBagId: contextView.bags[0].receiptBagId,
          actualProductId: fx.jeansId,
          disposition: 'KEEP',
        },
      ],
    };
    await assert.rejects(
      repository.createReceiptAdjustment(fx.htkd, input, randomUUID(), 'h', context()),
      (error) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      repository.createReceiptAdjustment(fx.otherStore, input, randomUUID(), 'h', context()),
      (error) => error.code === 'FORBIDDEN',
    );
    const key = randomUUID();
    const created = await repository.createReceiptAdjustment(
      fx.store,
      input,
      key,
      'hash-1',
      context(),
    );
    assert.equal(created.replayed, false);
    assert.match(created.data.code, /^PSL-\d{6}$/u);
    assert.equal(created.data.status, 'PENDING_HTKD');
    assert.deepEqual(created.data.allowedActions, ['CANCEL']);
    assert.equal(created.data.lines[0].holdState, 'HELD');
    assert.equal(created.data.lines[0].bagStatus, 'QUARANTINED');
    const replay = await repository.createReceiptAdjustment(
      fx.store,
      input,
      key,
      'hash-1',
      context(),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.id, created.data.id);
    await assert.rejects(
      repository.createReceiptAdjustment(fx.store, input, key, 'other-hash', context()),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );

    const htkdView = await repository.getReceiptAdjustment(fx.htkd, created.data.id);
    assert.deepEqual(htkdView.allowedActions, ['VERIFY', 'REQUEST_INFO', 'REJECT']);
    const verifyInput = {
      action: 'VERIFY',
      expectedVersion: 0,
      cause: 'SOURCE_MISCLASSIFICATION',
      note: 'Đã đối chiếu ảnh',
      lines: [
        {
          receiptBagId: input.lines[0].receiptBagId,
          actualProductId: fx.jeansId,
          weightKg: '20.000',
          pricePerKgVnd: 40_000,
          weightChangeNote: null,
        },
      ],
      freightDeltaVnd: 0,
      handlingDeltaVnd: 0,
      vatDeltaVnd: 0,
    };
    await assert.rejects(
      repository.actOnReceiptAdjustment(
        fx.store,
        created.data.id,
        verifyInput,
        randomUUID(),
        'v',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      repository.actOnReceiptAdjustment(
        fx.otherHtkd,
        created.data.id,
        verifyInput,
        randomUUID(),
        'v',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    const verified = await repository.actOnReceiptAdjustment(
      fx.htkd,
      created.data.id,
      verifyInput,
      randomUUID(),
      'v',
      context(),
    );
    assert.equal(verified.data.status, 'PENDING_ADMIN');
    assert.equal(verified.data.money.after.goodsVnd, 2_800_000);
    assert.equal(verified.data.delta.goodsVnd, -200_000);
    await assert.rejects(
      repository.actOnReceiptAdjustment(
        fx.htkd,
        created.data.id,
        { action: 'APPLY', expectedVersion: 1, note: null },
        randomUUID(),
        'a',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      repository.actOnReceiptAdjustment(
        fx.admin,
        created.data.id,
        { action: 'APPLY', expectedVersion: 0, note: null },
        randomUUID(),
        'a',
        context(),
      ),
      (error) => error.code === 'VERSION_CONFLICT',
    );
    const applied = await repository.actOnReceiptAdjustment(
      fx.admin,
      created.data.id,
      { action: 'APPLY', expectedVersion: 1, note: 'Đồng ý' },
      randomUUID(),
      'a',
      context(),
    );
    assert.equal(applied.data.status, 'APPLIED');
    assert.equal(applied.data.lines[0].entitlement.quantity, 1);
    assert.equal(applied.data.lines[0].entitlement.waitMode, 'CREATED');
    assert.equal(applied.data.lines[0].bagStatus, 'AVAILABLE');
    const after = await repository.getReceipt(fx.store, fx.receiptId);
    assert.equal(after.adjustmentSummary.original.goodsVnd, 3_000_000);
    assert.equal(after.adjustmentSummary.effective.goodsVnd, 2_800_000);
    assert.equal(after.adjustmentSummary.appliedCount, 1);

    const storeList = await repository.listReceiptAdjustments(fx.store, { page: 1, pageSize: 20 });
    assert.deepEqual(
      storeList.data.map((row) => row.id),
      [created.data.id],
    );
    const otherList = await repository.listReceiptAdjustments(fx.otherStore, {
      page: 1,
      pageSize: 20,
    });
    assert.equal(otherList.data.length, 0);

    const [wait] = await db
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.storeId, fx.storeId), eq(waitTickets.status, 'active')));
    assert.equal(wait.priorityLevel, 'P0B');
    assert.equal(wait.remainingQuantity, 1);
  });

  test('return flow through the API: handover by store, warehouse receipt by admin only', async () => {
    const fx = await finalizedReceipt(repository);
    const contextView = await repository.getReceiptAdjustmentContext(fx.store, fx.receiptId);
    const created = await repository.createReceiptAdjustment(
      fx.store,
      {
        receiptId: fx.receiptId,
        reason: 'Khui bao thấy jeans, trả kho',
        evidenceNote: null,
        discoveredAt: new Date().toISOString(),
        lines: [
          {
            receiptBagId: contextView.bags[1].receiptBagId,
            actualProductId: fx.jeansId,
            disposition: 'RETURN',
          },
        ],
      },
      randomUUID(),
      'c',
      context(),
    );
    await repository.actOnReceiptAdjustment(
      fx.admin,
      created.data.id,
      {
        action: 'VERIFY',
        expectedVersion: 0,
        cause: 'SOURCE_MISCLASSIFICATION',
        note: 'Admin xác minh thay HTKD',
        lines: [
          {
            receiptBagId: contextView.bags[1].receiptBagId,
            actualProductId: fx.jeansId,
            weightKg: '20.000',
            pricePerKgVnd: 40_000,
            weightChangeNote: null,
          },
        ],
        freightDeltaVnd: 0,
        handlingDeltaVnd: 0,
        vatDeltaVnd: 0,
      },
      randomUUID(),
      'v',
      context(),
    );
    const applied = await repository.actOnReceiptAdjustment(
      fx.admin,
      created.data.id,
      { action: 'APPLY', expectedVersion: 1, note: null },
      randomUUID(),
      'a',
      context(),
    );
    const pending = applied.data.lines[0].returns[0];
    assert.equal(pending.status, 'PENDING_HANDOVER');
    assert.match(pending.code, /^PTH-\d{6}$/u);
    await assert.rejects(
      repository.actOnReceiptReturn(
        fx.admin,
        pending.id,
        { action: 'HANDOVER', expectedVersion: 0 },
        randomUUID(),
        'h',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    const handed = await repository.actOnReceiptReturn(
      fx.store,
      pending.id,
      { action: 'HANDOVER', expectedVersion: 0 },
      randomUUID(),
      'h',
      context(),
    );
    assert.equal(handed.data.status, 'IN_TRANSIT');
    await assert.rejects(
      repository.actOnReceiptReturn(
        fx.store,
        pending.id,
        { action: 'RECEIVE', expectedVersion: 1, outcome: 'RECEIVED', note: null },
        randomUUID(),
        'r',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    const received = await repository.actOnReceiptReturn(
      fx.admin,
      pending.id,
      { action: 'RECEIVE', expectedVersion: 1, outcome: 'RECEIVED', note: null },
      randomUUID(),
      'r',
      context(),
    );
    assert.equal(received.data.status, 'RECEIVED');
    const returns = await repository.listReceiptReturns(fx.store, { page: 1, pageSize: 20 });
    assert.equal(returns.data[0].status, 'RECEIVED');
    assert.equal(
      (await repository.listReceiptReturns(fx.otherStore, { page: 1, pageSize: 20 })).data.length,
      0,
    );
  });

  test('wholesale desk takes the store side on wholesale receipts, never the reviewer side', async () => {
    const fx = await finalizedReceipt(repository, { wholesale: true });
    const retail = await finalizedReceipt(repository);
    assert.equal(fx.store.role, 'WHOLESALE');
    await assert.rejects(
      repository.getReceiptAdjustmentContext(fx.store, retail.receiptId),
      (error) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      repository.listReceiptAdjustments(fx.store, {
        storeId: retail.storeId,
        page: 1,
        pageSize: 20,
      }),
      (error) => error.code === 'FORBIDDEN',
    );
    const contextView = await repository.getReceiptAdjustmentContext(fx.store, fx.receiptId);
    const bagLine = {
      receiptBagId: contextView.bags[0].receiptBagId,
      actualProductId: fx.jeansId,
      disposition: 'RETURN',
    };
    const input = {
      receiptId: fx.receiptId,
      reason: 'Cửa hàng sỉ khui bao thấy jeans',
      evidenceNote: 'Ảnh gửi HTKD',
      discoveredAt: new Date().toISOString(),
      lines: [bagLine],
    };
    await assert.rejects(
      repository.createReceiptAdjustment(
        fx.store,
        { ...input, receiptId: retail.receiptId },
        randomUUID(),
        'h',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    const created = await repository.createReceiptAdjustment(
      fx.store,
      input,
      randomUUID(),
      'hash-w',
      context(),
    );
    assert.equal(created.data.status, 'PENDING_HTKD');
    assert.deepEqual(created.data.allowedActions, ['CANCEL']);
    assert.equal(created.data.reportedByAccountId, fx.store.accountId);
    for (const action of [
      {
        action: 'VERIFY',
        expectedVersion: 0,
        cause: 'SOURCE_MISCLASSIFICATION',
        note: 'Tự xác minh',
        lines: [
          {
            receiptBagId: bagLine.receiptBagId,
            actualProductId: fx.jeansId,
            weightKg: '20.000',
            pricePerKgVnd: 1,
            weightChangeNote: null,
          },
        ],
        freightDeltaVnd: 0,
        handlingDeltaVnd: 0,
        vatDeltaVnd: 0,
      },
      { action: 'REQUEST_INFO', expectedVersion: 0, note: 'Tự yêu cầu' },
      { action: 'APPLY', expectedVersion: 0, note: null },
    ]) {
      await assert.rejects(
        repository.actOnReceiptAdjustment(
          fx.store,
          created.data.id,
          action,
          randomUUID(),
          'x',
          context(),
        ),
        (error) => error.code === 'FORBIDDEN',
        action.action,
      );
    }
    const asked = await repository.actOnReceiptAdjustment(
      fx.htkd,
      created.data.id,
      { action: 'REQUEST_INFO', expectedVersion: 0, note: 'Gửi thêm ảnh tem bao' },
      randomUUID(),
      'i',
      context(),
    );
    assert.equal(asked.data.status, 'NEEDS_INFO');
    const queue = await repository.listReceiptAdjustments(fx.store, {
      status: 'NEEDS_INFO',
      page: 1,
      pageSize: 100,
    });
    assert.ok(queue.data.some((row) => row.id === created.data.id));
    assert.ok(queue.data.every((row) => fx.store.assignedStoreIds.includes(row.storeId)));
    const deskView = await repository.getReceiptAdjustment(fx.store, created.data.id);
    assert.deepEqual(deskView.allowedActions, ['RESUBMIT', 'CANCEL']);
    const resubmitted = await repository.actOnReceiptAdjustment(
      fx.store,
      created.data.id,
      {
        action: 'RESUBMIT',
        expectedVersion: 1,
        reason: input.reason,
        evidenceNote: 'Ảnh tem bao đã gửi',
        discoveredAt: input.discoveredAt,
        lines: [bagLine],
      },
      randomUUID(),
      'r',
      context(),
    );
    assert.equal(resubmitted.data.status, 'PENDING_HTKD');
    await repository.actOnReceiptAdjustment(
      fx.htkd,
      created.data.id,
      {
        action: 'VERIFY',
        expectedVersion: 2,
        cause: 'SOURCE_MISCLASSIFICATION',
        note: 'Đã đối chiếu ảnh tem bao',
        lines: [
          {
            receiptBagId: bagLine.receiptBagId,
            actualProductId: fx.jeansId,
            weightKg: '20.000',
            pricePerKgVnd: 40_000,
            weightChangeNote: null,
          },
        ],
        freightDeltaVnd: 0,
        handlingDeltaVnd: 0,
        vatDeltaVnd: 0,
      },
      randomUUID(),
      'v',
      context(),
    );
    const applied = await repository.actOnReceiptAdjustment(
      fx.admin,
      created.data.id,
      { action: 'APPLY', expectedVersion: 3, note: null },
      randomUUID(),
      'a',
      context(),
    );
    assert.equal(applied.data.status, 'APPLIED');
    const receipt = await repository.getReceipt(fx.store, fx.receiptId);
    assert.equal(receipt.status, 'FINALIZED');
    assert.equal(receipt.adjustmentSummary.original.goodsVnd, 3_000_000);
    assert.equal(receipt.adjustmentSummary.effective.goodsVnd, 2_800_000);
    const pending = applied.data.lines[0].returns[0];
    assert.equal(pending.status, 'PENDING_HANDOVER');
    const returns = await repository.listReceiptReturns(fx.store, {
      status: 'PENDING_HANDOVER',
      page: 1,
      pageSize: 100,
    });
    assert.ok(returns.data.some((row) => row.id === pending.id));
    await assert.rejects(
      repository.actOnReceiptReturn(
        fx.store,
        pending.id,
        { action: 'RECEIVE', expectedVersion: 0, outcome: 'RECEIVED', note: null },
        randomUUID(),
        'r',
        context(),
      ),
      (error) => error.code === 'FORBIDDEN',
    );
    const handed = await repository.actOnReceiptReturn(
      fx.store,
      pending.id,
      { action: 'HANDOVER', expectedVersion: 0 },
      randomUUID(),
      'h',
      context(),
    );
    assert.equal(handed.data.status, 'IN_TRANSIT');

    const audits = await db
      .select({ action: auditLogs.action, actorRole: auditLogs.actorRole })
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, fx.store.accountId));
    assert.ok(audits.length >= 5);
    assert.ok(
      audits.every((row) => row.actorRole === 'wholesale'),
      JSON.stringify(audits),
    );
  });

  test('routes require a session and are documented in OpenAPI', async () => {
    // Not closed here: closing the app would close the repository pool the suite still uses.
    const app = await createApi({ repository });
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/receipt-adjustments' });
    assert.equal(unauthenticated.statusCode, 401);
    const openapi = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    for (const path of [
      '/api/v1/store-receipts/{receiptId}/adjustment-context',
      '/api/v1/receipt-adjustments',
      '/api/v1/receipt-adjustments/{adjustmentId}/actions',
      '/api/v1/receipt-returns/{returnId}/actions',
    ]) {
      assert.ok(openapi.paths[path], path);
    }
  });
});

/**
 * `wholesale: true` makes store A a wholesale store received for by a wholesale-desk account
 * whose scope is derived the way sessions derive it: every active wholesale store.
 */
async function finalizedReceipt(repository, { wholesale: wholesaleStore = false } = {}) {
  const token = randomUUID().replaceAll('-', '');
  const [group] = await db.select().from(storeGroups).limit(1);
  const [adminRow] = await db
    .select()
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
    .limit(1);
  assert.ok(group && adminRow);
  const newStore = async (name) =>
    (
      await db
        .insert(stores)
        .values({
          code: `API-ADJ-${name}-${token.slice(0, 12)}`,
          name,
          groupId: group.id,
          kind: wholesaleStore && name === 'A' ? 'wholesale' : 'retail',
        })
        .returning()
    )[0];
  const store = await newStore('A');
  const other = await newStore('B');
  const newProduct = async (name) =>
    (
      await db
        .insert(products)
        .values({ sku: `${name}-${token}`, slug: `${name}-${token}`.toLowerCase(), name })
        .returning()
    )[0];
  const dress = await newProduct('DAM');
  const jeans = await newProduct('JEANS');
  const newUser = async (role, storeId = null) =>
    (
      await db
        .insert(users)
        .values({
          email: `api-adj-${role}-${randomUUID()}@example.test`,
          passwordHash: 'integration-test-placeholder-hash',
          displayName: `API ${role}`,
          role,
          storeId,
        })
        .returning()
    )[0];
  const storeUser = wholesaleStore
    ? { ...(await newUser('wholesale')), storeId: store.id }
    : await newUser('store', store.id);
  const otherStoreUser = await newUser('store', other.id);
  const htkd = await newUser('htkd');
  const otherHtkd = await newUser('htkd');
  const wholesale = await newUser('wholesale');
  await db.insert(htkdAssignments).values([
    { userId: htkd.id, storeId: store.id },
    { userId: otherHtkd.id, storeId: other.id },
  ]);
  const principal = (row, role, extra = {}) => ({
    accountId: row.id,
    username: row.email,
    displayName: row.displayName,
    role,
    status: 'ACTIVE',
    storeId: null,
    assignedStoreIds: [],
    ...extra,
  });

  const now = new Date();
  const day = new Date(Date.UTC(2040 + Math.floor(Math.random() * 50), 0, 1));
  day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 360));
  const date = day.toISOString().slice(0, 10);
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `X-${token.slice(0, 8)}`,
      businessDate: date,
      status: 'completed',
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      completedAt: now,
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      createdByUserId: adminRow.id,
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session.id,
      businessDate: date,
      snapshotType: 'manual',
      status: 'completed',
      capturedAt: now,
      completedAt: now,
      balanceVersion: 0,
    })
    .returning();
  const [run] = await db
    .insert(allocationRuns)
    .values({
      orderSessionId: session.id,
      inventorySnapshotId: snapshot.id,
      runNumber: 1,
      status: 'completed',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session.id,
      storeId: store.id,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: now,
      requestedByUserId: adminRow.id,
    })
    .returning();
  const [item] = await db
    .insert(orderRequestItems)
    .values({ orderRequestId: order.id, productId: dress.id, requestedQuantity: 3 })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({ orderSessionId: session.id, storeId: store.id, status: 'allocated', requestCount: 1 })
    .returning();
  const [mergedItem] = await db
    .insert(mergedOrderItems)
    .values({
      mergedOrderId: merged.id,
      productId: dress.id,
      requestedQuantity: 3,
      priorityLevel: 'P1',
    })
    .returning();
  await db.insert(mergedOrderSources).values({
    mergedOrderItemId: mergedItem.id,
    orderRequestItemId: item.id,
    requestedQuantity: 3,
  });
  const [allocation] = await db
    .insert(allocationLines)
    .values({
      allocationRunId: run.id,
      mergedOrderId: merged.id,
      storeId: store.id,
      productId: dress.id,
      orderRequestItemId: item.id,
      priorityLevel: 'P1',
      roundNumber: 1,
      sequenceInRound: 1,
      requestedQuantity: 3,
      allocatedQuantity: 3,
      status: 'allocated',
      reasonCode: 'API_ADJUSTMENT_TEST',
    })
    .returning();
  const [outbound] = await db
    .insert(outboundRequests)
    .values({
      requestNumber: '',
      storeId: store.id,
      orderSessionId: session.id,
      allocationRunId: run.id,
      status: 'dispatched',
      requestedByUserId: adminRow.id,
      submittedAt: now,
      approvedAt: now,
      dispatchedAt: now,
    })
    .returning();
  const [line] = await db
    .insert(outboundRequestLines)
    .values({
      outboundRequestId: outbound.id,
      productId: dress.id,
      allocationLineId: allocation.id,
      requestedQuantity: 3,
      approvedQuantity: 3,
      reservedQuantity: 3,
      dispatchedQuantity: 3,
    })
    .returning();
  await db.insert(reservations).values({
    allocationLineId: allocation.id,
    outboundRequestLineId: line.id,
    storeId: store.id,
    productId: dress.id,
    quantity: 3,
  });
  await withSerializableTransaction(db, (tx) =>
    applyWarehouseMovement(tx, {
      productId: dress.id,
      eventType: 'receipt',
      onHandDelta: 3,
      reservedDelta: 3,
      sourceType: 'api-adjustment-fixture',
      sourceId: randomUUID(),
    }),
  );

  return buildReceipt();

  async function buildReceipt() {
    const storeActor = wholesaleStore
      ? principal(storeUser, 'WHOLESALE', {
          assignedStoreIds: (
            await db
              .select({ id: stores.id })
              .from(stores)
              .where(
                and(
                  eq(stores.kind, 'wholesale'),
                  eq(stores.isActive, true),
                  isNull(stores.deletedAt),
                ),
              )
          ).map((row) => row.id),
        })
      : principal(storeUser, 'STORE', { storeId: storeUser.storeId });
    const htkdActor = principal(htkd, 'HTKD', { assignedStoreIds: [storeUser.storeId] });
    const lines = [{ productId: dress.id, approvedUnits: 3, receivedUnits: 3 }];
    const declared = await repository.declareStoreReceipt(
      storeActor,
      { storeId: storeUser.storeId, outboundRequestId: outbound.id, lines, discrepancyNote: null },
      randomUUID(),
      randomUUID(),
      context(),
    );
    const submitted = await repository.submitStoreReceipt(
      storeActor,
      declared.data.id,
      { expectedVersion: declared.data.version, lines, discrepancyNote: null },
      randomUUID(),
      randomUUID(),
      context(),
    );
    await repository.finalizeStoreReceipt(
      htkdActor,
      declared.data.id,
      {
        expectedVersion: submitted.data.version,
        lines: [
          {
            productId: dress.id,
            approvedUnits: 3,
            receivedUnits: 3,
            bagWeightsKg: ['20.000', '20.000', '20.000'],
            pricePerKgVnd: 50_000,
          },
        ],
        freightVnd: 0,
        handlingVnd: 0,
        vat: { amountVnd: 0, ratePercent: 8 },
      },
      randomUUID(),
      randomUUID(),
      context(),
    );
    return {
      receiptId: declared.data.id,
      storeId: storeUser.storeId,
      jeansId: jeans.id,
      store: storeActor,
      otherStore: principal(otherStoreUser, 'STORE', { storeId: otherStoreUser.storeId }),
      htkd: htkdActor,
      otherHtkd: principal(otherHtkd, 'HTKD', { assignedStoreIds: [otherStoreUser.storeId] }),
      admin: principal(adminRow, 'ADMIN'),
      // A forged desk scope that names a retail store: the store's kind still keeps it out.
      wholesale: principal(wholesale, 'WHOLESALE', { assignedStoreIds: [storeUser.storeId] }),
    };
  }
}

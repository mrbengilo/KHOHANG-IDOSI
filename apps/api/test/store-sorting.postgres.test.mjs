import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import { eq } from 'drizzle-orm';
import {
  closeDatabase,
  createStorePartnerInbound,
  db,
  products,
  storeGroups,
  storeInventoryBags,
  stores,
  users,
} from '@idosi/database';

import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';

async function seedStoreWithBag(token, bagWeightsKg) {
  const [group] = await db
    .insert(storeGroups)
    .values({ code: `SB${token}`, name: `Sorting buckets ${token}` })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ groupId: group.id, code: `SB${token}`, name: `Sorting buckets ${token}` })
    .returning();
  const [admin] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  const [account] = await db
    .insert(users)
    .values({
      email: `sorting.buckets.${token.toLowerCase()}@example.invalid`,
      displayName: `Người lọc ${token}`,
      role: 'store',
      status: 'active',
      storeId: store.id,
      passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
    })
    .returning();
  const [product] = await db.select().from(products).limit(1);
  await createStorePartnerInbound(db, {
    storeId: store.id,
    partnerName: 'Sorting buckets partner',
    note: null,
    receivedAt: new Date(),
    lines: [{ productId: product.id, quantity: bagWeightsKg.length, bagWeightsKg }],
    createdByUserId: account.id,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
  });
  const [bag] = await db
    .select()
    .from(storeInventoryBags)
    .where(eq(storeInventoryBags.storeId, store.id));
  const actor = {
    accountId: account.id,
    username: account.email,
    displayName: account.displayName,
    role: 'STORE',
    status: 'ACTIVE',
    storeId: store.id,
    assignedStoreIds: [],
  };
  return { store, product, bag, actor };
}

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL store sorting repository', () => {
  after(async () => closeDatabase());

  test('returns the contract result for committed and replayed sorting, then lists history', async () => {
    const token = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    const [group] = await db
      .insert(storeGroups)
      .values({ code: `SH${token}`, name: `Sorting history ${token}` })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ groupId: group.id, code: `SH${token}`, name: `Sorting history ${token}` })
      .returning();
    const [admin] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    const [account] = await db
      .insert(users)
      .values({
        email: `sorting.history.${token.toLowerCase()}@example.invalid`,
        displayName: `Người lọc ${token}`,
        role: 'store',
        status: 'active',
        storeId: store.id,
        passwordHash: admin?.passwordHash ?? 'test-hash-placeholder-long-enough',
      })
      .returning();
    const [product] = await db.select().from(products).limit(1);
    const receivedAt = new Date();
    await createStorePartnerInbound(db, {
      storeId: store.id,
      partnerName: 'Sorting history partner',
      note: null,
      receivedAt,
      lines: [{ productId: product.id, quantity: 1, bagWeightsKg: ['10.000'] }],
      createdByUserId: account.id,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
    });
    const [bag] = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.storeId, store.id));

    const repository = new PostgresWarehouseRepository();
    const actor = {
      accountId: account.id,
      username: account.email,
      displayName: account.displayName,
      role: 'STORE',
      status: 'ACTIVE',
      storeId: store.id,
      assignedStoreIds: [],
    };
    const context = { requestId: `sorting-${token}`, ipAddress: '127.0.0.1', userAgent: 'test' };
    const charityInput = {
      storeId: store.id,
      inventoryLotId: bag.id,
      expectedInventoryVersion: bag.version,
      reason: 'CHARITY',
      weightKg: '4',
    };

    // Before the fix the database result ({ inventoryBagId }) failed the response schema after
    // the transaction had committed, so the store saw "Dữ liệu yêu cầu không hợp lệ".
    const sorted = await repository.createStoreSorting(
      actor,
      charityInput,
      `charity-${token}`,
      `charity-hash-${token}`,
      context,
    );
    assert.equal(sorted.replayed, false);
    assert.equal(sorted.data.inventoryLotId, bag.id);
    assert.equal(sorted.data.inventoryVersion, bag.version + 1);
    assert.ok(sorted.data.stockId);

    const replayed = await repository.createStoreSorting(
      actor,
      charityInput,
      `charity-${token}`,
      `charity-hash-${token}`,
      context,
    );
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.data, sorted.data);

    const cancelled = await repository.createStoreSorting(
      actor,
      {
        ...charityInput,
        expectedInventoryVersion: sorted.data.inventoryVersion,
        reason: 'CANCEL',
        weightKg: '1.5',
      },
      `cancel-${token}`,
      `cancel-hash-${token}`,
      context,
    );
    // Cancel is now a tracked holding bucket on the same lot, not an immediate write-off.
    assert.equal(cancelled.data.stockId, sorted.data.stockId);
    assert.equal(cancelled.data.inventoryLotId, bag.id);
    const [lot] = await repository.listStoreSortedStocks(actor, store.id);
    assert.equal(lot.cancelWeightKg, '1.500');
    assert.equal(lot.charityWeightKg, '4.000');

    const history = await repository.listStoreSortingHistory(actor, { page: 1, pageSize: 20 });
    assert.deepEqual(
      history.data.map((row) => [row.action, row.weightKg, row.bagCode]),
      [
        ['SORT_CANCEL', '1.500', bag.displayCode],
        ['SORT_CHARITY', '4.000', bag.displayCode],
      ],
    );
    assert.equal(history.pagination.totalItems, 2);
    assert.equal(history.data[0].actorDisplayName, account.displayName);
    assert.equal(history.data[0].productId, product.id);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const todayHistory = await repository.listStoreSortingHistory(actor, {
      page: 1,
      pageSize: 1,
      date: today,
    });
    assert.equal(todayHistory.data.length, 1);
    assert.equal(todayHistory.pagination.totalPages, 2);
    const otherDay = await repository.listStoreSortingHistory(actor, {
      page: 1,
      pageSize: 20,
      date: '2020-01-01',
    });
    assert.equal(otherDay.data.length, 0);
  });

  test('moves weight between Sale, Charity and Cancel and finalizes Cancel exactly once', async () => {
    const token = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    const { store, product, bag, actor } = await seedStoreWithBag(token, ['20.000']);
    const repository = new PostgresWarehouseRepository();
    const context = { requestId: `buckets-${token}`, ipAddress: '127.0.0.1', userAgent: 'test' };
    const sale = await repository.createStoreSorting(
      actor,
      {
        storeId: store.id,
        inventoryLotId: bag.id,
        expectedInventoryVersion: bag.version,
        reason: 'SALE',
        weightKg: '10',
      },
      `sale-${token}`,
      `sale-hash-${token}`,
      context,
    );
    await repository.createStoreSorting(
      actor,
      {
        storeId: store.id,
        inventoryLotId: bag.id,
        expectedInventoryVersion: sale.data.inventoryVersion,
        reason: 'CANCEL',
        weightKg: '2',
      },
      `cancel-${token}`,
      `cancel-hash-${token}`,
      context,
    );
    const target = { storeId: store.id, productId: product.id };

    const toCharity = await repository.moveProductSaleToCharity(
      actor,
      { ...target, weightKg: '3' },
      `s2c-${token}`,
      `s2c-hash-${token}`,
      context,
    );
    assert.equal(toCharity.data.saleWeightKg, '7.000');
    assert.equal(toCharity.data.charityWeightKg, '3.000');
    const replay = await repository.moveProductSaleToCharity(
      actor,
      { ...target, weightKg: '3' },
      `s2c-${token}`,
      `s2c-hash-${token}`,
      context,
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.data, toCharity.data);

    const toCancel = await repository.moveProductSaleToCancel(
      actor,
      { ...target, weightKg: '1' },
      `s2x-${token}`,
      `s2x-hash-${token}`,
      context,
    );
    assert.equal(toCancel.data.saleWeightKg, '6.000');
    assert.equal(toCancel.data.cancelWeightKg, '3.000');

    await assert.rejects(
      repository.moveProductSaleToCancel(
        actor,
        { ...target, weightKg: '6.001' },
        `s2x-over-${token}`,
        `s2x-over-hash-${token}`,
        context,
      ),
    );

    const back = await repository.moveProductCancelToSale(
      actor,
      { ...target, weightKg: '0.5' },
      `x2s-${token}`,
      `x2s-hash-${token}`,
      context,
    );
    assert.equal(back.data.saleWeightKg, '6.500');
    assert.equal(back.data.cancelWeightKg, '2.500');

    await assert.rejects(
      repository.finalizeProductCancel(
        actor,
        { ...target, weightKg: '1' },
        `fin-partial-${token}`,
        `fin-partial-hash-${token}`,
        context,
      ),
    );
    // Two concurrent finalizations of the full balance: exactly one succeeds.
    const settled = await Promise.allSettled([
      repository.finalizeProductCancel(
        actor,
        { ...target, weightKg: '2.5' },
        `fin-a-${token}`,
        `fin-a-hash-${token}`,
        context,
      ),
      repository.finalizeProductCancel(
        actor,
        { ...target, weightKg: '2.5' },
        `fin-b-${token}`,
        `fin-b-hash-${token}`,
        context,
      ),
    ]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    const [lot] = await repository.listStoreSortedStocks(actor, store.id);
    assert.equal(lot.cancelWeightKg, '0.000');
    assert.equal(lot.saleWeightKg, '6.500');
    assert.equal(lot.charityWeightKg, '3.000');

    const [breakdown] = await repository.listSaleBreakdown(actor, store.id);
    assert.equal(breakdown.creditedWeightKg, '10.500');
    assert.equal(breakdown.remainingWeightKg, '6.500');
    assert.equal(breakdown.movedToCharityWeightKg, '3.000');
    assert.equal(breakdown.movedToCancelWeightKg, '1.000');
    assert.equal(breakdown.soldByWeightWeightKg, '0.000');

    const history = await repository.listStoreSortingHistory(actor, { page: 1, pageSize: 20 });
    const actions = history.data.map((row) => row.action);
    for (const action of ['SALE_TO_CHARITY', 'SALE_TO_CANCEL', 'CANCEL_TO_SALE', 'CANCEL_FINALIZE'])
      assert.ok(actions.includes(action), action);
  });
});

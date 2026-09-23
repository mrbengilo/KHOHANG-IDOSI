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
    assert.equal(cancelled.data.stockId, null);
    assert.equal(cancelled.data.inventoryLotId, bag.id);

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
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  db,
  isRetryableTransactionError,
  storeGroups,
  stores,
  users,
} from '@idosi/database';

import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL store lifecycle repository', () => {
  test('commits idempotent versioned store/group changes and audit rows atomically', async () => {
    const [admin] = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .limit(1);
    if (!admin) throw new Error('The PostgreSQL lifecycle test requires a seeded active admin.');

    const repository = new PostgresWarehouseRepository();
    const actor = {
      accountId: admin.id,
      username: admin.email,
      displayName: admin.displayName,
      role: 'ADMIN',
      status: 'ACTIVE',
      storeId: null,
      assignedStoreIds: [],
    };
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const context = {
      requestId: `store-lifecycle-${suffix}`,
      ipAddress: '127.0.0.1',
      userAgent: 'postgres-lifecycle-test',
    };

    const createdGroup = await repository.createStoreGroup(
      actor,
      { code: `LIF_G_${suffix}`, name: `Lifecycle group ${suffix}` },
      `group-create-${suffix}`,
      `group-create-hash-${suffix}`,
      context,
    );
    assert.equal(createdGroup.replayed, false);
    assert.equal(createdGroup.data.version, 0);

    const replayedGroup = await repository.createStoreGroup(
      actor,
      { code: `LIF_G_${suffix}`, name: `Lifecycle group ${suffix}` },
      `group-create-${suffix}`,
      `group-create-hash-${suffix}`,
      context,
    );
    assert.equal(replayedGroup.replayed, true);
    assert.deepEqual(replayedGroup.data, createdGroup.data);

    const searchContext = { ...context, requestId: `store-search-${suffix}` };
    const literalSearchGroup = await repository.createStoreGroup(
      actor,
      { code: `LIT_${suffix}`, name: `Literal %_${suffix}` },
      `literal-search-create-${suffix}`,
      `literal-search-create-hash-${suffix}`,
      searchContext,
    );
    await repository.createStoreGroup(
      actor,
      { code: `DEC_${suffix}`, name: `Literal AX${suffix}` },
      `search-decoy-create-${suffix}`,
      `search-decoy-create-hash-${suffix}`,
      searchContext,
    );
    const literalSearch = await repository.listStoreGroups(actor, {
      page: 1,
      pageSize: 100,
      search: `%_${suffix}`,
    });
    assert.deepEqual(
      literalSearch.data.map((group) => group.id),
      [literalSearchGroup.data.id],
    );

    const createdStore = await repository.createStore(
      actor,
      {
        code: `LIF_S_${suffix}`,
        name: `Lifecycle store ${suffix}`,
        groupId: createdGroup.data.id,
        kind: 'RETAIL',
        address: null,
      },
      `store-create-${suffix}`,
      `store-create-hash-${suffix}`,
      context,
    );
    assert.equal(createdStore.replayed, false);
    assert.equal(createdStore.data.version, 0);

    await assert.rejects(
      repository.updateStoreGroup(
        actor,
        createdGroup.data.id,
        { expectedVersion: 0, status: 'INACTIVE' },
        `group-blocked-${suffix}`,
        `group-blocked-hash-${suffix}`,
        context,
      ),
      (error) => error?.code === 'CONFLICT',
    );

    const disabledStore = await repository.updateStore(
      actor,
      createdStore.data.id,
      { expectedVersion: 0, status: 'INACTIVE' },
      `store-disable-${suffix}`,
      `store-disable-hash-${suffix}`,
      context,
    );
    assert.equal(disabledStore.data.version, 1);
    assert.equal(disabledStore.data.status, 'INACTIVE');

    const concurrent = await Promise.allSettled([
      repository.updateStore(
        actor,
        createdStore.data.id,
        { expectedVersion: 1, name: `Lifecycle store A ${suffix}` },
        `store-concurrent-a-${suffix}`,
        `store-concurrent-a-hash-${suffix}`,
        context,
      ),
      repository.updateStore(
        actor,
        createdStore.data.id,
        { expectedVersion: 1, address: `Lifecycle address B ${suffix}` },
        `store-concurrent-b-${suffix}`,
        `store-concurrent-b-hash-${suffix}`,
        context,
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    const rejectedConcurrent = concurrent.find((result) => result.status === 'rejected');
    // A serializable loser may exhaust its retry budget under CI load before it can
    // observe the winning version. The API maps that SQLSTATE to a retryable 409.
    assert.ok(
      rejectedConcurrent?.reason?.code === 'VERSION_CONFLICT' ||
        isRetryableTransactionError(rejectedConcurrent?.reason),
      `Expected a version or serialization conflict, got ${rejectedConcurrent?.reason}`,
    );

    await assert.rejects(
      repository.updateStore(
        actor,
        createdStore.data.id,
        { expectedVersion: 0, name: 'stale update' },
        `store-stale-${suffix}`,
        `store-stale-hash-${suffix}`,
        context,
      ),
      (error) => error?.code === 'VERSION_CONFLICT',
    );

    const disabledGroup = await repository.updateStoreGroup(
      actor,
      createdGroup.data.id,
      { expectedVersion: 0, status: 'INACTIVE' },
      `group-blocked-${suffix}`,
      `group-blocked-hash-${suffix}`,
      context,
    );
    assert.equal(disabledGroup.data.version, 1);
    assert.equal(disabledGroup.data.status, 'INACTIVE');

    const [persistedGroup] = await db
      .select({ version: storeGroups.version, isActive: storeGroups.isActive })
      .from(storeGroups)
      .where(eq(storeGroups.id, createdGroup.data.id));
    const [persistedStore] = await db
      .select({ version: stores.version, isActive: stores.isActive })
      .from(stores)
      .where(eq(stores.id, createdStore.data.id));
    assert.deepEqual(persistedGroup, { version: 1, isActive: false });
    assert.deepEqual(persistedStore, { version: 2, isActive: false });

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.requestId, context.requestId));
    assert.deepEqual(audit.map((event) => event.action).sort(), [
      'STORE_CREATED',
      'STORE_GROUP_CREATED',
      'STORE_GROUP_UPDATED',
      'STORE_UPDATED',
      'STORE_UPDATED',
    ]);
  });
});

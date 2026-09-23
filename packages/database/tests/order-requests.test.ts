import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import {
  assertUserMayAccessStore,
  isRequestDeadlineClosed,
  OrderRequestAuthorizationError,
} from '../src/order-requests.js';
import { closeDatabase, db, storeGroups, stores, users } from '../src/index.js';

describe('order request deadline', () => {
  const deadline = new Date('2026-09-10T01:00:00.000Z');

  it('is closed at the exact cutoff', () => {
    expect(isRequestDeadlineClosed(deadline, new Date(deadline))).toBe(true);
  });

  it('remains open strictly before the cutoff', () => {
    expect(isRequestDeadlineClosed(deadline, new Date(deadline.getTime() - 1))).toBe(false);
  });
});

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
describePostgres('assertUserMayAccessStore authorization', () => {
  afterAll(() => closeDatabase());

  it('allows admin to access any store', async () => {
    const [admin] = await db.select().from(users).where((u) => u.role === 'admin').limit(1);
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!admin || !group) throw new Error('Reference data required');

    const [store] = await db
      .insert(stores)
      .values({
        code: `AUTH-ADMIN-${randomUUID().slice(0, 8)}`,
        name: 'Admin Test Store',
        groupId: group.id,
        kind: 'retail',
      })
      .returning();

    await expect(
      db.transaction((tx) => assertUserMayAccessStore(tx, admin.id, store!.id)),
    ).resolves.toBeUndefined();

    await db.delete(stores).where((s) => s.id === store!.id);
  });

  it('allows wholesale_account to access any store', async () => {
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!group) throw new Error('Reference data required');

    const [wholesaleUser] = await db
      .insert(users)
      .values({
        email: `wholesale-test-${randomUUID()}@test.local`,
        displayName: 'Wholesale Account Test',
        role: 'wholesale_account',
        status: 'active',
        passwordHash: 'test-hash-min-20-chars-long',
      })
      .returning();

    const [retailStore] = await db
      .insert(stores)
      .values({
        code: `AUTH-WS-R-${randomUUID().slice(0, 8)}`,
        name: 'Retail Store for Wholesale Test',
        groupId: group.id,
        kind: 'retail',
      })
      .returning();

    const [wholesaleStore] = await db
      .insert(stores)
      .values({
        code: `AUTH-WS-W-${randomUUID().slice(0, 8)}`,
        name: 'Wholesale Store Test',
        groupId: group.id,
        kind: 'wholesale',
      })
      .returning();

    // Wholesale account can access retail stores
    await expect(
      db.transaction((tx) => assertUserMayAccessStore(tx, wholesaleUser!.id, retailStore!.id)),
    ).resolves.toBeUndefined();

    // Wholesale account can access wholesale stores
    await expect(
      db.transaction((tx) => assertUserMayAccessStore(tx, wholesaleUser!.id, wholesaleStore!.id)),
    ).resolves.toBeUndefined();

    // Cleanup
    await db.delete(stores).where((s) => s.id === retailStore!.id);
    await db.delete(stores).where((s) => s.id === wholesaleStore!.id);
    await db.delete(users).where((u) => u.id === wholesaleUser!.id);
  });

  it('rejects store role accessing different store', async () => {
    const [group] = await db.select().from(storeGroups).limit(1);
    if (!group) throw new Error('Reference data required');

    const [ownStore] = await db
      .insert(stores)
      .values({
        code: `AUTH-ST-OWN-${randomUUID().slice(0, 8)}`,
        name: 'Own Store',
        groupId: group.id,
        kind: 'retail',
      })
      .returning();

    const [otherStore] = await db
      .insert(stores)
      .values({
        code: `AUTH-ST-OTHER-${randomUUID().slice(0, 8)}`,
        name: 'Other Store',
        groupId: group.id,
        kind: 'retail',
      })
      .returning();

    const [storeUser] = await db
      .insert(users)
      .values({
        email: `store-test-${randomUUID()}@test.local`,
        displayName: 'Store Account Test',
        role: 'store',
        storeId: ownStore!.id,
        status: 'active',
        passwordHash: 'test-hash-min-20-chars-long',
      })
      .returning();

    // Can access own store
    await expect(
      db.transaction((tx) => assertUserMayAccessStore(tx, storeUser!.id, ownStore!.id)),
    ).resolves.toBeUndefined();

    // Cannot access other store
    await expect(
      db.transaction((tx) => assertUserMayAccessStore(tx, storeUser!.id, otherStore!.id)),
    ).rejects.toBeInstanceOf(OrderRequestAuthorizationError);

    // Cleanup
    await db.delete(users).where((u) => u.id === storeUser!.id);
    await db.delete(stores).where((s) => s.id === ownStore!.id);
    await db.delete(stores).where((s) => s.id === otherStore!.id);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import {
  closeDatabase,
  db,
  htkdAssignments,
  products,
  storePartnerInbounds,
  storeInventoryBags,
  stores,
  users,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashPassword } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL partner inbound for HTKD', () => {
  const createdStoreIds = [];

  after(async () => {
    // The scratch stores only exist for this test; keep them out of every later listing.
    for (const id of createdStoreIds) {
      await db.update(stores).set({ deletedAt: new Date() }).where(eq(stores.id, id));
    }
    await closeDatabase();
  });

  test('records only for assigned retail stores and re-checks the assignment on write', async () => {
    const [template] = await db
      .select({ groupId: stores.groupId })
      .from(stores)
      .where(and(eq(stores.kind, 'retail'), isNull(stores.deletedAt)))
      .limit(1);
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(isNull(products.deletedAt))
      .limit(1);
    assert.ok(template, 'PostgreSQL fixture requires a retail store group');
    assert.ok(product, 'PostgreSQL fixture requires a product');

    const suffix = randomUUID().slice(0, 8);
    const newStore = async (label, kind) => {
      const [store] = await db
        .insert(stores)
        .values({
          groupId: template.groupId,
          code: `PI_${label}_${suffix}`,
          name: `Partner inbound ${label} ${suffix}`,
          kind,
        })
        .returning({ id: stores.id });
      assert.ok(store);
      createdStoreIds.push(store.id);
      return store.id;
    };
    const assignedStoreId = await newStore('ASSIGNED', 'retail');
    const unassignedStoreId = await newStore('UNASSIGNED', 'retail');
    const wholesaleStoreId = await newStore('WHOLESALE', 'wholesale');

    const [htkd] = await db
      .insert(users)
      .values({
        displayName: `HTKD partner inbound ${suffix}`,
        email: `htkd.partner.${suffix}`,
        passwordHash: await hashPassword('Postgres-partner-inbound-2026!'),
        role: 'htkd',
        status: 'active',
      })
      .returning();
    assert.ok(htkd);
    await db.insert(htkdAssignments).values([
      { userId: htkd.id, storeId: assignedStoreId },
      { userId: htkd.id, storeId: wholesaleStoreId },
    ]);

    const repository = new PostgresWarehouseRepository();
    // The session claims every scratch store, as a stale session could after a revocation:
    // the database write must still refuse what the live assignment does not cover.
    const actor = {
      accountId: htkd.id,
      assignedStoreIds: [assignedStoreId, unassignedStoreId, wholesaleStoreId],
      displayName: htkd.displayName,
      role: 'HTKD',
      status: 'ACTIVE',
      storeId: null,
      username: htkd.email,
    };
    const context = { requestId: randomUUID(), ipAddress: '127.0.0.1', userAgent: 'postgres-test' };
    const record = (storeId, key) =>
      repository.createStorePartnerInbound(
        actor,
        {
          storeId,
          partnerName: 'Đối tác kiểm thử',
          note: null,
          receivedAt: new Date().toISOString(),
          lines: [{ productId: product.id, quantity: 2, bagWeightsKg: ['10.000', '12.500'] }],
        },
        key,
        `hash-${key}`,
        context,
      );

    const created = await record(assignedStoreId, `assigned-${suffix}`);
    assert.equal(created.replayed, false);
    assert.equal(created.data.storeId, assignedStoreId);
    assert.equal(created.data.createdByAccountId, htkd.id);
    assert.equal(created.data.totalWeightKg, '22.500');

    await assert.rejects(record(unassignedStoreId, `unassigned-${suffix}`), (error) => {
      assert.equal(error.statusCode ?? error.status, 403);
      return true;
    });
    await assert.rejects(record(wholesaleStoreId, `wholesale-${suffix}`), (error) => {
      assert.equal(error.statusCode ?? error.status, 403);
      return true;
    });

    await db.insert(htkdAssignments).values({ userId: htkd.id, storeId: unassignedStoreId });
    await record(unassignedStoreId, `second-store-${suffix}`);
    await Promise.all([
      record(assignedStoreId, `concurrent-a-${suffix}`),
      record(assignedStoreId, `concurrent-b-${suffix}`),
    ]);

    const codesFor = async (storeId) =>
      (
        await db
          .select({
            bagCode: storeInventoryBags.bagCode,
            displayCode: storeInventoryBags.displayCode,
          })
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.storeId, storeId))
      )
        .map((bag) => {
          assert.match(bag.bagCode, /^PIB-/);
          return bag.displayCode;
        })
        .sort();
    assert.deepEqual(await codesFor(assignedStoreId), [
      'MB-00001',
      'MB-00002',
      'MB-00003',
      'MB-00004',
      'MB-00005',
      'MB-00006',
    ]);
    assert.deepEqual(await codesFor(unassignedStoreId), ['MB-00001', 'MB-00002']);
    const listed = await repository.listStoreInventoryBags(actor, {
      page: 1,
      pageSize: 20,
      storeId: assignedStoreId,
      bagCode: 'MB-00003',
    });
    assert.deepEqual(
      listed.data.map((bag) => bag.bagCode),
      ['MB-00003'],
    );

    await db
      .update(htkdAssignments)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(htkdAssignments.userId, htkd.id), eq(htkdAssignments.storeId, assignedStoreId)),
      );
    await assert.rejects(record(assignedStoreId, `revoked-${suffix}`), (error) => {
      assert.equal(error.statusCode ?? error.status, 403);
      return true;
    });

    const slips = await db
      .select({ id: storePartnerInbounds.id })
      .from(storePartnerInbounds)
      .where(eq(storePartnerInbounds.createdByUserId, htkd.id));
    assert.equal(slips.length, 4);
  });
});

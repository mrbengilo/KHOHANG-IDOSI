import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import { closeDatabase, db, storeGroups, stores, users } from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashPassword, verifyPassword } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL account conflicts', () => {
  after(async () => closeDatabase());

  test('returns a conflict for a store that already has an account', async () => {
    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
      .limit(1);
    const [group] = await db.select({ id: storeGroups.id }).from(storeGroups).limit(1);
    assert.ok(admin, 'PostgreSQL fixture requires an active administrator');
    assert.ok(group, 'PostgreSQL fixture requires a store group');

    const suffix = randomUUID().slice(0, 8);
    const [store] = await db
      .insert(stores)
      .values({ code: `ACC_${suffix}`, groupId: group.id, name: `Account conflict ${suffix}` })
      .returning();
    assert.ok(store);

    try {
      await db.insert(users).values({
        displayName: 'Existing store account',
        email: `store.existing.${suffix}`,
        passwordHash: await hashPassword('Existing-store-password-2026!'),
        role: 'store',
        status: 'active',
        storeId: store.id,
      });
      const actor = {
        accountId: admin.id,
        assignedStoreIds: [],
        displayName: admin.displayName,
        role: 'ADMIN',
        status: 'ACTIVE',
        storeId: null,
        username: admin.email,
      };
      const context = {
        ipAddress: '127.0.0.1',
        requestId: `account-conflict-${suffix}`,
        userAgent: 'postgres-account-conflict-test',
      };
      const repository = new PostgresWarehouseRepository();

      await assert.rejects(
        () =>
          repository.createAccount(
            actor,
            {
              displayName: 'Duplicate store account',
              password: 'Duplicate-store-password-2026!',
              role: 'STORE',
              storeId: store.id,
              username: `store.duplicate.${suffix}`,
            },
            context,
          ),
        (error) => error.code === 'CONFLICT' && error.statusCode === 409,
      );
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.storeId, store.id));
      assert.equal(existing.length, 1);

      const oldCredentials = await repository.findCredentials(`store.existing.${suffix}`);
      const oldToken = `${randomUUID()}-${randomUUID()}`;
      await repository.createSession(
        oldCredentials,
        oldToken,
        new Date(Date.now() + 60_000),
        context,
      );

      const locked = await repository.updateAccount(
        actor,
        existing[0].id,
        { status: 'LOCKED', expectedSessionVersion: 0 },
        context,
      );
      assert.equal(locked.status, 'LOCKED');
      await assert.rejects(
        () => repository.resolveSession(oldToken),
        (error) => error.code === 'SESSION_REVOKED',
      );
      const replacement = await repository.createAccount(
        actor,
        {
          displayName: 'Replacement store account',
          password: 'Replacement-store-password-2026!',
          role: 'STORE',
          storeId: store.id,
          username: `store.existing.${suffix}`,
        },
        context,
      );
      const newCredentials = await repository.findCredentials(`store.existing.${suffix}`);
      assert.equal(newCredentials.id, replacement.id);
      assert.equal(
        await verifyPassword('Existing-store-password-2026!', newCredentials.passwordHash),
        false,
      );
      const replacementToken = `${randomUUID()}-${randomUUID()}`;
      await repository.createSession(
        newCredentials,
        replacementToken,
        new Date(Date.now() + 60_000),
        context,
      );
      assert.equal(
        (await repository.resolveSession(replacementToken)).principal.accountId,
        replacement.id,
      );
      await assert.rejects(
        () =>
          repository.updateAccount(
            actor,
            existing[0].id,
            { status: 'ACTIVE', expectedSessionVersion: locked.sessionVersion },
            context,
          ),
        (error) => error.code === 'CONFLICT' && error.statusCode === 409,
      );
    } finally {
      await db.delete(users).where(eq(users.storeId, store.id));
      await db.delete(stores).where(eq(stores.id, store.id));
    }
  });
});

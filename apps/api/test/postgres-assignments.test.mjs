import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import {
  auditLogs,
  closeDatabase,
  db,
  htkdAssignments,
  sessions,
  stores,
  users,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashPassword } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL HTKD assignments', () => {
  after(async () => closeDatabase());

  test('serializes audited replacements, covers wholesale stores and revokes sessions', async () => {
    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
      .limit(1);
    const retailStores = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.kind, 'retail'), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(2);
    const [wholesaleStore] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.kind, 'wholesale'), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1);
    assert.ok(admin, 'PostgreSQL fixture requires an active administrator');
    assert.equal(retailStores.length, 2, 'PostgreSQL fixture requires two active retail stores');
    assert.ok(wholesaleStore, 'PostgreSQL fixture requires an active wholesale store');

    const suffix = randomUUID();
    const [target] = await db
      .insert(users)
      .values({
        displayName: `HTKD assignment test ${suffix}`,
        email: `htkd.assignment.${suffix}`,
        passwordHash: await hashPassword('Postgres-assignment-test-2026!'),
        role: 'htkd',
        status: 'active',
      })
      .returning();
    assert.ok(target);
    const [session] = await db
      .insert(sessions)
      .values({
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: '127.0.0.1',
        lastSeenAt: new Date(),
        tokenHash: `assignment-${suffix}`,
        userAgent: 'postgres-assignment-test',
        userId: target.id,
        userTokenVersion: 0,
      })
      .returning();
    assert.ok(session);

    const repository = new PostgresWarehouseRepository();
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
      requestId: `postgres-assignment-${suffix}`,
      userAgent: 'postgres-assignment-test',
    };

    const originalTransaction = db.transaction;
    let assignmentReadConfig;
    db.transaction = function captureAssignmentReadConfig(callback, config) {
      if (config?.accessMode === 'read only') assignmentReadConfig = config;
      return originalTransaction.call(this, callback, config);
    };
    let initialState;
    try {
      initialState = await repository.listHtkdAssignments(actor, target.id);
    } finally {
      Reflect.deleteProperty(db, 'transaction');
    }
    assert.deepEqual(initialState, {
      assignments: [],
      htkdAccountId: target.id,
      sessionVersion: 0,
    });
    assert.deepEqual(assignmentReadConfig, {
      accessMode: 'read only',
      isolationLevel: 'repeatable read',
    });
    const assigned = await repository.replaceHtkdAssignments(
      actor,
      target.id,
      {
        expectedSessionVersion: 0,
        reason: 'Phân công địa bàn kiểm thử PostgreSQL',
        storeIds: retailStores.map((store) => store.id),
      },
      context,
    );
    assert.equal(assigned.assignments.length, 2);
    assert.equal(assigned.sessionVersion, 1);
    const [revokedSession] = await db
      .select({ revokeReason: sessions.revokeReason, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    assert.ok(revokedSession?.revokedAt);
    assert.equal(revokedSession.revokeReason, 'htkd_assignments_changed');

    const noOpReplay = await repository.replaceHtkdAssignments(
      actor,
      target.id,
      {
        expectedSessionVersion: 1,
        reason: 'Gửi lại phạm vi không đổi',
        storeIds: retailStores.map((store) => store.id),
      },
      context,
    );
    assert.equal(noOpReplay.sessionVersion, 1);

    await assert.rejects(
      () =>
        repository.replaceHtkdAssignments(
          actor,
          target.id,
          {
            expectedSessionVersion: 0,
            reason: 'Phiên bản cũ phải bị từ chối',
            storeIds: [],
          },
          context,
        ),
      (error) => error?.code === 'VERSION_CONFLICT',
    );
    // 7779fe4 opened HTKD supervision to every active store, wholesale included; only the
    // retail order/receive/transfer gates stay retail-only. This test still asserted the
    // old refusal, which is why it only failed where PostgreSQL tests run (CI).
    const withWholesale = await repository.replaceHtkdAssignments(
      actor,
      target.id,
      {
        expectedSessionVersion: 1,
        reason: 'HTKD giám sát cả cửa hàng sỉ',
        storeIds: [...retailStores.map((store) => store.id), wholesaleStore.id],
      },
      context,
    );
    assert.equal(withWholesale.assignments.length, 3);
    assert.equal(withWholesale.sessionVersion, 2);
    assert.ok(withWholesale.assignments.some((row) => row.storeId === wholesaleStore.id));

    const [clearSession] = await db
      .insert(sessions)
      .values({
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: '127.0.0.1',
        lastSeenAt: new Date(),
        tokenHash: `assignment-clear-${suffix}`,
        userAgent: 'postgres-assignment-clear-test',
        userId: target.id,
        userTokenVersion: 2,
      })
      .returning();
    assert.ok(clearSession);
    const cleared = await repository.replaceHtkdAssignments(
      actor,
      target.id,
      {
        expectedSessionVersion: 2,
        reason: 'Thu hồi toàn bộ địa bàn kiểm thử',
        storeIds: [],
      },
      { ...context, requestId: `postgres-assignment-clear-${suffix}` },
    );
    assert.deepEqual(cleared.assignments, []);
    // htkd_assignments_revoke_sessions bumps token_version once per revoked row, so
    // clearing three assignments moves the version from 2 to 5.
    assert.equal(cleared.sessionVersion, 5);
    const [revokedClearSession] = await db
      .select({ revokeReason: sessions.revokeReason, revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, clearSession.id));
    assert.ok(revokedClearSession?.revokedAt);
    assert.equal(revokedClearSession.revokeReason, 'htkd_assignments_changed');
    const activeRows = await db
      .select({ id: htkdAssignments.id })
      .from(htkdAssignments)
      .where(and(eq(htkdAssignments.userId, target.id), isNull(htkdAssignments.revokedAt)));
    assert.deepEqual(activeRows, []);
    const assignmentAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, target.id), eq(auditLogs.action, 'HTKD_ASSIGNMENTS_REPLACED')),
      );
    assert.equal(assignmentAudits.length, 3);
    const clearAudit = assignmentAudits.find(
      (audit) => audit.requestId === `postgres-assignment-clear-${suffix}`,
    );
    assert.equal(clearAudit?.before?.assignments?.length, 3);
    assert.equal(clearAudit?.after?.assignments?.length, 0);
    assert.equal(clearAudit?.metadata?.sessionsRevoked, 1);

    await db.update(users).set({ status: 'locked' }).where(eq(users.id, target.id));
    await assert.rejects(
      () => repository.listHtkdAssignments(actor, target.id),
      (error) => error?.code === 'CONFLICT',
    );
  });
});

import { randomUUID } from 'node:crypto';
import { nextOrderingWindow } from '@idosi/contracts';
import { and, asc, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from './client.js';
import { assertUserMayAccessStore, countOrderingQuota } from './order-requests.js';
import { auditLogs, operationalSettingsVersions, orderSessions, users } from './schema.js';
import { withAdvisoryLock } from './transaction.js';

/** Worker-owned calendar: quiet days still get snapshots/offers without a page visit.
 * Only today is prepared; historical catch-up never invents missed human offer windows. */
export async function ensureDailyOrderingSession(database: Database, now: Date) {
  const businessDate = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  return database.transaction((tx) =>
    withAdvisoryLock(tx, 'order-session-business-date', businessDate, async () => {
      const [existing] = await tx
        .select()
        .from(orderSessions)
        .where(and(eq(orderSessions.businessDate, businessDate), isNull(orderSessions.deletedAt)))
        .orderBy(desc(orderSessions.createdAt))
        .for('update')
        .limit(1);
      // Respect an explicit cancellation and custom schedules; never reopen a frozen cycle.
      if (
        existing &&
        (existing.status !== 'draft' || (existing.openedAt ?? existing.createdAt) > now)
      )
        return existing;
      const [settings] = await tx
        .select()
        .from(operationalSettingsVersions)
        .orderBy(desc(operationalSettingsVersions.version))
        .limit(1);
      if (!settings) throw new Error('Ordering configuration is unavailable.');
      const [session] = existing
        ? await tx
            .update(orderSessions)
            .set({ status: 'open', updatedAt: now, version: existing.version + 1 })
            .where(eq(orderSessions.id, existing.id))
            .returning()
        : await tx
            .insert(orderSessions)
            .values({
              code: `AUTO-${businessDate}-${randomUUID().slice(0, 8)}`,
              businessDate,
              status: 'open',
              openedAt: new Date(`${businessDate}T00:00:00+07:00`),
              inventorySnapshotDueAt: new Date(
                `${businessDate}T${settings.snapshotTime.slice(0, 5)}:00+07:00`,
              ),
              requestDeadlineAt: new Date(
                `${businessDate}T${settings.cutoffTime.slice(0, 5)}:00+07:00`,
              ),
              policyVersion: settings.policyVersion,
            })
            .returning();
      if (!session) throw new Error('Could not prepare the daily allocation session.');
      await tx.insert(auditLogs).values({
        action: 'ORDER_SESSION_AUTO_OPENED',
        entityType: 'order_session',
        entityId: session.id,
        after: { businessDate, requestClosesAt: session.inventorySnapshotDueAt.toISOString() },
        metadata: {
          source: 'allocation_worker',
          reason: 'Daily allocation independent of browser traffic',
        },
      });
      return session;
    }),
  );
}

/** Idempotent preparation: one shared business-date lock, no arbitrary client schedule or permissions. */
export async function prepareOrderingContext(
  database: Database,
  userId: string,
  storeId: string,
  requestId: string,
) {
  return database.transaction(async (tx) => {
    await assertUserMayAccessStore(tx, userId, storeId);
    const [actor] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
    const [settings] = await tx
      .select()
      .from(operationalSettingsVersions)
      .orderBy(desc(operationalSettingsVersions.version))
      .limit(1);
    if (!settings || !actor) throw new Error('Ordering configuration is unavailable.');
    const now = new Date();
    // Preserve an existing currently open custom schedule. New requests never reopen frozen sessions.
    const [open] = await tx
      .select()
      .from(orderSessions)
      .where(
        and(
          eq(orderSessions.status, 'open'),
          gt(orderSessions.inventorySnapshotDueAt, now),
          isNull(orderSessions.deletedAt),
        ),
      )
      .orderBy(asc(orderSessions.inventorySnapshotDueAt))
      .limit(1);
    if (open && (open.openedAt ?? open.createdAt) <= now) {
      return { session: open, usedSlots: await countOrderingQuota(tx, storeId, open.id) };
    }
    let window = nextOrderingWindow(now, settings.snapshotTime, settings.cutoffTime);
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const session = await withAdvisoryLock(
        tx,
        'order-session-business-date',
        window.businessDate,
        async () => {
          const [existing] = await tx
            .select()
            .from(orderSessions)
            .where(
              and(
                eq(orderSessions.businessDate, window.businessDate),
                ne(orderSessions.status, 'cancelled'),
                isNull(orderSessions.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (
            existing &&
            (!['draft', 'open'].includes(existing.status) || existing.inventorySnapshotDueAt <= now)
          )
            return null;
          if (existing?.status === 'open' && (existing.openedAt ?? existing.createdAt) <= now)
            return existing;
          const [row] = existing
            ? await tx
                .update(orderSessions)
                .set({
                  status: 'open',
                  openedAt: now,
                  updatedAt: now,
                  version: existing.version + 1,
                })
                .where(eq(orderSessions.id, existing.id))
                .returning()
            : await tx
                .insert(orderSessions)
                .values({
                  code: `AUTO-${window.businessDate}-${randomUUID().slice(0, 8)}`,
                  businessDate: window.businessDate,
                  status: 'open',
                  openedAt: now,
                  inventorySnapshotDueAt: new Date(window.requestClosesAt),
                  requestDeadlineAt: new Date(window.allocationStartsAt),
                  policyVersion: settings.policyVersion,
                  createdByUserId: userId,
                })
                .returning();
          if (!row) throw new Error('Could not prepare ordering session.');
          await tx.insert(auditLogs).values({
            actorUserId: userId,
            actorRole: actor.role,
            requestId,
            action: 'ORDER_SESSION_AUTO_OPENED',
            entityType: 'order_session',
            entityId: row.id,
            after: {
              businessDate: row.businessDate,
              requestClosesAt: row.inventorySnapshotDueAt.toISOString(),
              reason: 'Continuous ordering for the next allocation',
            },
          });
          return row;
        },
      );
      if (session) return { session, usedSlots: await countOrderingQuota(tx, storeId, session.id) };
      window = nextOrderingWindow(
        new Date(window.allocationStartsAt),
        settings.snapshotTime,
        settings.cutoffTime,
      );
    }
    throw new Error('No available allocation cycle within the scheduling horizon.');
  });
}

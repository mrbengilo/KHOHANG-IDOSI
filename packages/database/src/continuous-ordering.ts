import { nextOrderingWindow } from '@idosi/contracts';
import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { openDueScheduledSessions } from './order-sessions.js';
import { assertUserMayAccessStore, countOrderingQuota } from './order-requests.js';
import { auditLogs, operationalSettingsVersions, orderSessions, users } from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

/**
 * The system-owned (DEFAULT) session of one business date. Admin sessions on the same date are
 * MANUAL and never stand in for it: the latest session of a date is no longer "the" session.
 */
async function lockDefaultSession(tx: Transaction, businessDate: string) {
  const [row] = await tx
    .select()
    .from(orderSessions)
    .where(
      and(
        eq(orderSessions.businessDate, businessDate),
        eq(orderSessions.kind, 'default'),
        isNull(orderSessions.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return row;
}

/** Worker-owned calendar: quiet days still get snapshots/offers without a page visit.
 * Only today is prepared; historical catch-up never invents missed human offer windows. */
export async function ensureDailyOrderingSession(database: Database, now: Date) {
  const businessDate = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  return database.transaction(async (tx) => {
    // Admin sessions open on their own stored schedule, independently of the default one.
    await openDueScheduledSessions(tx, now, 'allocation_worker');
    return withAdvisoryLock(tx, 'order-session-business-date', businessDate, async () => {
      const existing = await lockDefaultSession(tx, businessDate);
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
              code: '',
              businessDate,
              kind: 'default',
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
        after: {
          code: session.code,
          kind: session.kind,
          businessDate,
          requestClosesAt: session.inventorySnapshotDueAt.toISOString(),
        },
        metadata: {
          source: 'allocation_worker',
          reason: 'Daily allocation independent of browser traffic',
        },
      });
      return session;
    });
  });
}

/**
 * Where a new ordinary request goes, decided by the server: the session that is accepting
 * requests now and closes first (ties: created first, then id). Without one, the DEFAULT
 * session of the next allocation cycle is opened, so ordering stays available 24/7 without an
 * Admin. A request already submitted keeps its session even if an earlier one is added later.
 */
export async function resolveOrderingSession(tx: Transaction, now: Date) {
  await openDueScheduledSessions(tx, now, 'ordering_context');
  const [accepting] = await tx
    .select()
    .from(orderSessions)
    .where(
      and(
        eq(orderSessions.status, 'open'),
        gt(orderSessions.inventorySnapshotDueAt, now),
        lte(sql`coalesce(${orderSessions.openedAt}, ${orderSessions.createdAt})`, now),
        isNull(orderSessions.deletedAt),
      ),
    )
    .orderBy(
      asc(orderSessions.inventorySnapshotDueAt),
      asc(orderSessions.createdAt),
      asc(orderSessions.id),
    )
    .limit(1);
  return accepting ?? null;
}

/** Idempotent preparation: one shared business-date lock, no arbitrary client schedule or permissions. */
export async function prepareOrderingContext(
  database: Database,
  userId: string,
  storeId: string,
  requestId: string,
  clock: () => Date = () => new Date(),
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
    const now = clock();
    const open = await resolveOrderingSession(tx, now);
    if (open) {
      return { session: open, usedSlots: await countOrderingQuota(tx, storeId, open.id) };
    }
    let window = nextOrderingWindow(now, settings.snapshotTime, settings.cutoffTime);
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const session = await withAdvisoryLock(
        tx,
        'order-session-business-date',
        window.businessDate,
        async () => {
          const existing = await lockDefaultSession(tx, window.businessDate);
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
                  code: '',
                  businessDate: window.businessDate,
                  kind: 'default',
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
              code: row.code,
              kind: row.kind,
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

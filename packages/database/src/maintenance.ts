import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/** How long records that only serve operations are kept once they stop mattering. */
export const RETENTION = {
  /** Expired or revoked sessions: kept as login evidence for a quarter. */
  sessionDays: 90,
  /** Idempotency records past their expiry (24 h) no longer replay anything. */
  idempotencyDays: 7,
} as const;

/** Rows removed per table and run, so one run never holds long locks on a busy table. */
export const MAINTENANCE_BATCH = 5_000;

export interface MaintenanceResult {
  readonly sessions: number;
  readonly idempotencyKeys: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Removes records that only served day-to-day operation and have outlived their use. Business
 * documents, ledgers, audit logs and IDOSI sync attempts (append-only evidence, guarded by a
 * trigger) are never touched: they are the immutable history.
 */
export async function pruneOperationalHistory(
  database: Database,
  now: Date,
): Promise<MaintenanceResult> {
  if (Number.isNaN(now.getTime())) throw new TypeError('Invalid maintenance instant');
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

  const sessions = await database.execute(sql`
    DELETE FROM sessions
    WHERE id IN (
      SELECT id FROM sessions
      WHERE expires_at < ${before(RETENTION.sessionDays)}::timestamptz
         OR revoked_at < ${before(RETENTION.sessionDays)}::timestamptz
      LIMIT ${MAINTENANCE_BATCH}
    )
  `);
  const idempotencyKeys = await database.execute(sql`
    DELETE FROM idempotency_keys
    WHERE id IN (
      SELECT id FROM idempotency_keys
      WHERE expires_at < ${before(RETENTION.idempotencyDays)}::timestamptz
      LIMIT ${MAINTENANCE_BATCH}
    )
  `);
  return {
    sessions: sessions.rowCount ?? 0,
    idempotencyKeys: idempotencyKeys.rowCount ?? 0,
  };
}

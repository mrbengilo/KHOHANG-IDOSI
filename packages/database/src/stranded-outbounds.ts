import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  WarehouseOutboundConflictError,
  dispatchWarehouseOutboundInTransaction,
} from './outbound-requests.js';
import { outboundRequestLines, outboundRequests, reservations } from './schema.js';
import { withSerializableTransaction } from './transaction.js';

/**
 * A stranded outbound is an allocation shipment that the 09:00 run materialized as `reserved`
 * before the worker learned to release it, so no store could ever receive it. The backfill
 * releases each one through the same dispatch path the worker now uses.
 */
export interface StrandedOutboundRecord {
  readonly id: string;
  readonly requestNumber: string;
  readonly storeId: string;
  readonly orderSessionId: string | null;
  readonly allocationRunId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly lineCount: number;
  readonly approvedQuantity: number;
  /** Null when the outbound is dispatchable; otherwise why the backfill leaves it alone. */
  readonly blockedReason: string | null;
}

export interface StrandedOutboundBackfillResult {
  readonly candidates: readonly StrandedOutboundRecord[];
  readonly dispatchedIds: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export async function listStrandedAllocationOutbounds(
  database: Database,
): Promise<readonly StrandedOutboundRecord[]> {
  const headers = await database
    .select()
    .from(outboundRequests)
    .where(
      and(
        eq(outboundRequests.status, 'reserved'),
        isNotNull(outboundRequests.allocationRunId),
        isNull(outboundRequests.deletedAt),
      ),
    )
    .orderBy(asc(outboundRequests.createdAt), asc(outboundRequests.id));
  if (headers.length === 0) return [];

  const lines = await database
    .select()
    .from(outboundRequestLines)
    .where(
      inArray(
        outboundRequestLines.outboundRequestId,
        headers.map((header) => header.id),
      ),
    );
  const lineIds = lines.map((line) => line.id);
  const activeReservations =
    lineIds.length === 0
      ? []
      : await database
          .select({
            outboundRequestLineId: reservations.outboundRequestLineId,
            quantity: reservations.quantity,
          })
          .from(reservations)
          .where(
            and(
              inArray(reservations.outboundRequestLineId, lineIds),
              eq(reservations.status, 'active'),
              isNull(reservations.deletedAt),
            ),
          );
  const reservedByLine = new Map<string, number>();
  for (const reservation of activeReservations) {
    if (reservation.outboundRequestLineId === null) continue;
    reservedByLine.set(
      reservation.outboundRequestLineId,
      (reservedByLine.get(reservation.outboundRequestLineId) ?? 0) + reservation.quantity,
    );
  }

  return headers.map((header) => {
    const own = lines.filter((line) => line.outboundRequestId === header.id);
    let blockedReason: string | null = null;
    if (own.length === 0) blockedReason = 'no product lines';
    else if (own.some((line) => line.dispatchedQuantity !== 0 || line.receivedQuantity !== 0))
      blockedReason = 'a line is already partly dispatched or received';
    else if (
      own.some(
        (line) => line.approvedQuantity <= 0 || line.reservedQuantity !== line.approvedQuantity,
      )
    )
      blockedReason = 'approved and reserved quantities differ';
    else if (own.some((line) => reservedByLine.get(line.id) !== line.reservedQuantity))
      blockedReason = 'active reservations do not cover the approved quantity';
    return {
      id: header.id,
      requestNumber: header.requestNumber,
      storeId: header.storeId,
      orderSessionId: header.orderSessionId,
      allocationRunId: header.allocationRunId!,
      version: header.version,
      createdAt: header.createdAt,
      lineCount: own.length,
      approvedQuantity: own.reduce((total, line) => total + line.approvedQuantity, 0),
      blockedReason,
    };
  });
}

/**
 * Lists stranded outbounds and, only when `apply` is true, releases each dispatchable one in its
 * own serializable transaction. Re-running is safe: a released outbound is no longer `reserved`,
 * and one released concurrently by someone else is reported as skipped rather than retried.
 */
export async function dispatchStrandedAllocationOutbounds(
  database: Database,
  options: { readonly apply: boolean; readonly now?: Date },
): Promise<StrandedOutboundBackfillResult> {
  const candidates = await listStrandedAllocationOutbounds(database);
  const skipped: { id: string; reason: string }[] = candidates
    .filter((candidate) => candidate.blockedReason !== null)
    .map((candidate) => ({ id: candidate.id, reason: candidate.blockedReason! }));
  if (!options.apply) return { candidates, dispatchedIds: [], skipped };

  const dispatchedIds: string[] = [];
  const now = options.now ?? new Date();
  for (const candidate of candidates) {
    if (candidate.blockedReason !== null) continue;
    try {
      await withSerializableTransaction(database, (tx) =>
        dispatchWarehouseOutboundInTransaction(tx, {
          outboundRequestId: candidate.id,
          expectedVersion: candidate.version,
          dispatcher: { kind: 'system', trigger: 'stranded-outbound-backfill' },
          dispatchedAt: now,
        }),
      );
      dispatchedIds.push(candidate.id);
    } catch (error: unknown) {
      if (!(error instanceof WarehouseOutboundConflictError)) throw error;
      skipped.push({ id: candidate.id, reason: 'changed by another dispatch; left as is' });
    }
  }
  return { candidates, dispatchedIds, skipped };
}

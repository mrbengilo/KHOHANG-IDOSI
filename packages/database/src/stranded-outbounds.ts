import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';

import {
  AllocationDecisionRequiredError,
  SHIPPABLE_DECISION_STATUSES,
  type AllocationDecisionDatabaseStatus,
} from './allocation-decision-gate.js';
import type { Database } from './client.js';
import {
  WarehouseOutboundConflictError,
  dispatchWarehouseOutboundInTransaction,
} from './outbound-requests.js';
import {
  allocationLines,
  allocationResultDecisions,
  outboundRequestLines,
  outboundRequests,
  reservations,
} from './schema.js';
import { withSerializableTransaction } from './transaction.js';

/**
 * A stranded outbound is a legacy allocation shipment that the 09:00 run materialized as
 * `reserved` before the worker learned to release it, so no store could ever receive it. The
 * backfill releases each one through the same gated dispatch path the system uses.
 *
 * Since store confirmation (migration 0038), a `reserved` shipment is normally just waiting for
 * the store to accept its result. Those are not stranded: they are counted apart, never listed
 * as candidates and never dispatched here. The canonical dispatch gate refuses them anyway.
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
  /** The store decision of the shipment's own result; null is an integrity error. */
  readonly decisionStatus: AllocationDecisionDatabaseStatus | null;
  /** Null when the outbound is dispatchable; otherwise why the backfill leaves it alone. */
  readonly blockedReason: string | null;
}

export interface StrandedOutboundBackfillResult {
  readonly candidates: readonly StrandedOutboundRecord[];
  /** Reserved shipments waiting for their store's answer: normal, never touched here. */
  readonly awaitingStoreDecisionCount: number;
  readonly dispatchedIds: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export async function listStrandedAllocationOutbounds(
  database: Database,
): Promise<readonly StrandedOutboundRecord[]> {
  return (await listReservedAllocationOutbounds(database)).filter(
    (record) => record.decisionStatus !== 'pending',
  );
}

async function listReservedAllocationOutbounds(
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
  const decisions = await database
    .select({
      allocationRunId: allocationResultDecisions.allocationRunId,
      storeId: allocationResultDecisions.storeId,
      status: allocationResultDecisions.status,
    })
    .from(allocationResultDecisions)
    .where(
      inArray(allocationResultDecisions.allocationRunId, [
        ...new Set(headers.map((header) => header.allocationRunId!)),
      ]),
    );
  const unshippableSourceLines =
    lineIds.length === 0
      ? []
      : await database
          .select({ outboundRequestLineId: reservations.outboundRequestLineId })
          .from(reservations)
          .leftJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
          .leftJoin(
            allocationResultDecisions,
            and(
              eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
              eq(allocationResultDecisions.storeId, allocationLines.storeId),
            ),
          )
          .where(
            and(
              inArray(reservations.outboundRequestLineId, lineIds),
              eq(reservations.status, 'active'),
              isNull(reservations.deletedAt),
              or(
                isNull(allocationLines.id),
                isNull(allocationResultDecisions.id),
                notInArray(allocationResultDecisions.status, [...SHIPPABLE_DECISION_STATUSES]),
              ),
            ),
          );
  const blockedLineIds = new Set(unshippableSourceLines.map((row) => row.outboundRequestLineId));

  return headers.map((header) => {
    const decisionStatus =
      decisions.find(
        (decision) =>
          decision.allocationRunId === header.allocationRunId &&
          decision.storeId === header.storeId,
      )?.status ?? null;
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
    else if (decisionStatus === null)
      blockedReason = 'no store decision record for this allocation result (integrity error)';
    else if (decisionStatus === 'rejected') blockedReason = 'the store rejected this result';
    else if (own.some((line) => blockedLineIds.has(line.id)))
      blockedReason = 'carries goods of an unanswered or rejected allocation result';
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
      decisionStatus,
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
  const reserved = await listReservedAllocationOutbounds(database);
  const candidates = reserved.filter((record) => record.decisionStatus !== 'pending');
  const awaitingStoreDecisionCount = reserved.length - candidates.length;
  const skipped: { id: string; reason: string }[] = candidates
    .filter((candidate) => candidate.blockedReason !== null)
    .map((candidate) => ({ id: candidate.id, reason: candidate.blockedReason! }));
  if (!options.apply) return { candidates, awaitingStoreDecisionCount, dispatchedIds: [], skipped };

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
      if (error instanceof AllocationDecisionRequiredError) {
        skipped.push({ id: candidate.id, reason: 'refused by the store decision gate' });
        continue;
      }
      if (!(error instanceof WarehouseOutboundConflictError)) throw error;
      skipped.push({ id: candidate.id, reason: 'changed by another dispatch; left as is' });
    }
  }
  return { candidates, awaitingStoreDecisionCount, dispatchedIds, skipped };
}

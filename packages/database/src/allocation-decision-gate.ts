import { and, eq, isNull, notInArray, or } from 'drizzle-orm';

import {
  allocationLines,
  allocationResultDecisions,
  outboundRequestLines,
  reservations,
} from './schema.js';
import type { Transaction } from './transaction.js';

export type AllocationDecisionDatabaseStatus =
  (typeof allocationResultDecisions.$inferSelect)['status'];

/** Goods of a result in one of these statuses may ship; the 0038 dispatch trigger agrees. */
export const SHIPPABLE_DECISION_STATUSES = [
  'accepted',
  'not_required',
  'legacy',
] as const satisfies readonly AllocationDecisionDatabaseStatus[];

export type AllocationDecisionGateReason =
  'DECISION_PENDING' | 'DECISION_REJECTED' | 'DECISION_MISSING' | 'SOURCE_NOT_SHIPPABLE';

export class AllocationDecisionRequiredError extends Error {
  public readonly code = 'ALLOCATION_DECISION_REQUIRED';
  public readonly reason: AllocationDecisionGateReason;

  public constructor(reason: AllocationDecisionGateReason) {
    super(
      {
        DECISION_PENDING: 'The store has not accepted this allocation result yet.',
        DECISION_REJECTED: 'The store rejected this allocation result.',
        DECISION_MISSING: 'This allocation result has no store decision record.',
        SOURCE_NOT_SHIPPABLE:
          'The shipment carries goods of an unanswered or rejected allocation result.',
      }[reason],
    );
    this.name = 'AllocationDecisionRequiredError';
    this.reason = reason;
  }
}

/** SQLSTATEs raised by the 0038 guards when code reaches them without the checks below. */
const GUARD_SQLSTATES = new Set(['IDA01', 'IDA02', 'IDA03']);

export function isAllocationDecisionGuardError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const code = Reflect.get(current, 'code');
    if (typeof code === 'string' && GUARD_SQLSTATES.has(code)) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

export async function loadResultDecisionStatus(
  tx: Transaction,
  allocationRunId: string,
  storeId: string,
): Promise<AllocationDecisionDatabaseStatus | null> {
  const [row] = await tx
    .select({ status: allocationResultDecisions.status })
    .from(allocationResultDecisions)
    .where(
      and(
        eq(allocationResultDecisions.allocationRunId, allocationRunId),
        eq(allocationResultDecisions.storeId, storeId),
      ),
    )
    .limit(1);
  return row?.status ?? null;
}

function assertShippable(status: AllocationDecisionDatabaseStatus | null): void {
  if (status === null) throw new AllocationDecisionRequiredError('DECISION_MISSING');
  if (status === 'pending') throw new AllocationDecisionRequiredError('DECISION_PENDING');
  if (status === 'rejected') throw new AllocationDecisionRequiredError('DECISION_REJECTED');
}

/**
 * Server-side gate of every dispatch caller (HTTP, worker, store acceptance, backfill). The
 * shipment's own result and the result behind every active reservation on it must be shippable;
 * a reservation without allocation provenance fails closed.
 */
export async function assertShipmentMayDispatch(
  tx: Transaction,
  outbound: {
    readonly id: string;
    readonly allocationRunId: string | null;
    readonly storeId: string;
  },
): Promise<void> {
  if (outbound.allocationRunId === null) return;
  assertShippable(await loadResultDecisionStatus(tx, outbound.allocationRunId, outbound.storeId));
  const [blocked] = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .innerJoin(
      outboundRequestLines,
      eq(reservations.outboundRequestLineId, outboundRequestLines.id),
    )
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
        eq(outboundRequestLines.outboundRequestId, outbound.id),
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
        or(
          isNull(allocationLines.id),
          isNull(allocationResultDecisions.id),
          notInArray(allocationResultDecisions.status, [...SHIPPABLE_DECISION_STATUSES]),
        ),
      ),
    )
    .limit(1);
  if (blocked) throw new AllocationDecisionRequiredError('SOURCE_NOT_SHIPPABLE');
}

/**
 * A receipt can only follow a dispatch, and dispatch is gated above and by the database. This
 * re-check refuses a declaration against a result that is pending or rejected however the
 * shipment got to dispatched (for example a historical row inserted outside the dispatch path).
 */
export async function assertShipmentMayBeReceived(
  tx: Transaction,
  outbound: { readonly allocationRunId: string | null; readonly storeId: string },
): Promise<void> {
  if (outbound.allocationRunId === null) return;
  const status = await loadResultDecisionStatus(tx, outbound.allocationRunId, outbound.storeId);
  if (status === 'pending') throw new AllocationDecisionRequiredError('DECISION_PENDING');
  if (status === 'rejected') throw new AllocationDecisionRequiredError('DECISION_REJECTED');
}

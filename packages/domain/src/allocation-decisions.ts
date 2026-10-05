/**
 * A store's answer to one published allocation result (one allocation run for one store).
 *
 * - PENDING: the result has granted goods and waits for the store; nothing ships yet.
 * - ACCEPTED / REJECTED: the store answered once; the answer is final for this result.
 * - NOT_REQUIRED: the run granted this store nothing new, so there is nothing to answer.
 * - LEGACY: published before store confirmation existed; it keeps the old shipping rules and is
 *   never presented as an answer the store gave.
 */
export const ALLOCATION_DECISION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'NOT_REQUIRED',
  'LEGACY',
] as const;
export type AllocationDecisionStatus = (typeof ALLOCATION_DECISION_STATUSES)[number];

export const ALLOCATION_DECISION_ACTIONS = ['ACCEPT', 'REJECT'] as const;
export type AllocationDecisionAction = (typeof ALLOCATION_DECISION_ACTIONS)[number];

/** Statuses whose granted goods may be attached to a shipment, dispatched and received. */
export const SHIPPABLE_ALLOCATION_DECISION_STATUSES: readonly AllocationDecisionStatus[] = [
  'ACCEPTED',
  'NOT_REQUIRED',
  'LEGACY',
];

export function isShippableAllocationDecision(status: AllocationDecisionStatus): boolean {
  return SHIPPABLE_ALLOCATION_DECISION_STATUSES.includes(status);
}

/** A result that grants nothing has no goods to accept, so it never asks the store. */
export function initialAllocationDecisionStatus(grantedQuantity: number): AllocationDecisionStatus {
  if (!Number.isSafeInteger(grantedQuantity) || grantedQuantity < 0) {
    throw new RangeError('grantedQuantity must be a non-negative safe integer.');
  }
  return grantedQuantity > 0 ? 'PENDING' : 'NOT_REQUIRED';
}

export type AllocationDecisionTransition =
  | { readonly ok: true; readonly next: 'ACCEPTED' | 'REJECTED' }
  | {
      readonly ok: false;
      readonly reason: 'ALREADY_ANSWERED' | 'NOT_ANSWERABLE' | 'STALE_VERSION';
    };

/**
 * PENDING moves exactly once. An answered result never flips: re-granting goods after a
 * rejection needs a new result with its own audit trail, never an edit of this one.
 */
export function transitionAllocationDecision(input: {
  readonly status: AllocationDecisionStatus;
  readonly version: number;
  readonly expectedVersion: number;
  readonly action: AllocationDecisionAction;
}): AllocationDecisionTransition {
  if (input.status === 'ACCEPTED' || input.status === 'REJECTED') {
    return { ok: false, reason: 'ALREADY_ANSWERED' };
  }
  if (input.status !== 'PENDING') return { ok: false, reason: 'NOT_ANSWERABLE' };
  if (input.version !== input.expectedVersion) return { ok: false, reason: 'STALE_VERSION' };
  return { ok: true, next: input.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED' };
}

export const ALLOCATION_DECISION_REASON_MAX_LENGTH = 500;

/** Optional rejection note: trimmed, blank means none, and only a rejection may carry one. */
export function normalizeAllocationDecisionReason(
  action: AllocationDecisionAction,
  reason: string | null | undefined,
): string | null {
  const normalized = reason?.trim() ?? '';
  if (normalized.length === 0) return null;
  if (action !== 'REJECT') {
    throw new RangeError('Only a rejection can carry a reason.');
  }
  if (normalized.length > ALLOCATION_DECISION_REASON_MAX_LENGTH) {
    throw new RangeError(
      `A rejection reason must be at most ${ALLOCATION_DECISION_REASON_MAX_LENGTH} characters.`,
    );
  }
  return normalized;
}

/**
 * What a rejection may touch. Only reservations created by the rejected result itself are
 * released; goods carried from an earlier result that rode the same shipment stay held for the
 * store, whatever product or shipment they share with the rejected grant.
 */
export function partitionRejectedShipmentSources<
  T extends { readonly sourceAllocationRunId: string; readonly storeId: string },
>(
  sources: readonly T[],
  rejected: { readonly allocationRunId: string; readonly storeId: string },
): { readonly release: readonly T[]; readonly keepHeld: readonly T[] } {
  const release: T[] = [];
  const keepHeld: T[] = [];
  for (const source of sources) {
    if (source.storeId !== rejected.storeId) {
      throw new RangeError('A shipment source belongs to another store.');
    }
    (source.sourceAllocationRunId === rejected.allocationRunId ? release : keepHeld).push(source);
  }
  return { release, keepHeld };
}

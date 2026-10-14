/**
 * A store's answer to one published allocation result (one allocation run for one store).
 *
 * - PENDING: the result has granted goods and waits for the store; nothing ships yet. Part of it
 *   may already be revoked by a wait-ticket cancellation; only the actionable rest is answered.
 * - ACCEPTED: the store (or its assigned HTKD) confirmed it; the RE order issued the actionable
 *   goods. Final.
 * - WAITLISTED: the store moved the actionable goods back to wait tickets ("Chuyển phiếu chờ"):
 *   the holds were released and the demand requeued. Final.
 * - CANCELLED: every granted bag was revoked because the wait tickets it came from were
 *   cancelled; nothing is left to answer. Final.
 * - REJECTED: historical answer of the retired "Từ chối" command (before 0044). Final, read only.
 * - NOT_REQUIRED: the run granted this store nothing new, so there is nothing to answer.
 * - LEGACY: published before store confirmation existed; it keeps the old shipping rules and is
 *   never presented as an answer the store gave.
 */
export const ALLOCATION_DECISION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'CANCELLED',
  'NOT_REQUIRED',
  'LEGACY',
] as const;
export type AllocationDecisionStatus = (typeof ALLOCATION_DECISION_STATUSES)[number];

/**
 * Commands a responder may send. REJECT was retired by 0044: rejecting dropped the demand, which
 * the business no longer allows; "Chuyển phiếu chờ" (WAITLIST) replaces it and keeps the demand.
 */
export const ALLOCATION_DECISION_ACTIONS = ['ACCEPT', 'WAITLIST'] as const;
export type AllocationDecisionAction = (typeof ALLOCATION_DECISION_ACTIONS)[number];

/** Statuses whose granted goods may be attached to a shipment, dispatched and received. */
export const SHIPPABLE_ALLOCATION_DECISION_STATUSES: readonly AllocationDecisionStatus[] = [
  'ACCEPTED',
  'NOT_REQUIRED',
  'LEGACY',
];

/** Final statuses that were reached by a person answering (or by a cancellation). */
export const FINAL_ALLOCATION_DECISION_STATUSES: readonly AllocationDecisionStatus[] = [
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'CANCELLED',
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
  | { readonly ok: true; readonly next: 'ACCEPTED' | 'WAITLISTED' }
  | {
      readonly ok: false;
      readonly reason: 'ALREADY_ANSWERED' | 'NOT_ANSWERABLE' | 'STALE_VERSION' | 'NOTHING_ACTIONABLE';
    };

/**
 * PENDING moves exactly once. An answered result never flips: re-granting goods after the store
 * moved them back to waiting needs a new result with its own audit trail, never an edit of this
 * one. A result whose every granted bag was revoked has nothing left to answer.
 */
export function transitionAllocationDecision(input: {
  readonly status: AllocationDecisionStatus;
  readonly version: number;
  readonly expectedVersion: number;
  readonly action: AllocationDecisionAction;
  /** Granted bags still answerable (granted minus revoked); defaults to "some". */
  readonly actionableQuantity?: number;
}): AllocationDecisionTransition {
  if (FINAL_ALLOCATION_DECISION_STATUSES.includes(input.status) && input.status !== 'CANCELLED') {
    return { ok: false, reason: 'ALREADY_ANSWERED' };
  }
  if (input.status !== 'PENDING') return { ok: false, reason: 'NOT_ANSWERABLE' };
  if (input.version !== input.expectedVersion) return { ok: false, reason: 'STALE_VERSION' };
  if (input.actionableQuantity !== undefined && input.actionableQuantity <= 0) {
    return { ok: false, reason: 'NOTHING_ACTIONABLE' };
  }
  return { ok: true, next: input.action === 'ACCEPT' ? 'ACCEPTED' : 'WAITLISTED' };
}

/** Granted bags of a result that can still be accepted or moved to waiting. */
export function actionableAllocationQuantity(input: {
  readonly grantedQuantity: number;
  readonly revokedQuantity: number;
}): number {
  if (
    !Number.isSafeInteger(input.grantedQuantity) ||
    !Number.isSafeInteger(input.revokedQuantity) ||
    input.revokedQuantity < 0 ||
    input.revokedQuantity > input.grantedQuantity
  ) {
    throw new RangeError('revokedQuantity must be within the granted quantity.');
  }
  return input.grantedQuantity - input.revokedQuantity;
}

/**
 * Status of a PENDING result after a wait-ticket cancellation revokes `revoke` more bags. The
 * granted snapshot never changes; revoking everything closes the result as CANCELLED.
 */
export function revokeFromPendingDecision(input: {
  readonly status: AllocationDecisionStatus;
  readonly grantedQuantity: number;
  readonly revokedQuantity: number;
  readonly revoke: number;
}): { readonly next: 'PENDING' | 'CANCELLED'; readonly revokedQuantity: number } {
  if (input.status !== 'PENDING') {
    throw new RangeError('Only a pending result can have goods revoked.');
  }
  if (!Number.isSafeInteger(input.revoke) || input.revoke <= 0) {
    throw new RangeError('revoke must be a positive integer.');
  }
  const actionable = actionableAllocationQuantity(input);
  if (input.revoke > actionable) {
    throw new RangeError('Cannot revoke more than the actionable goods of the result.');
  }
  const revokedQuantity = input.revokedQuantity + input.revoke;
  return { next: revokedQuantity === input.grantedQuantity ? 'CANCELLED' : 'PENDING', revokedQuantity };
}

export const ALLOCATION_DECISION_REASON_MAX_LENGTH = 500;

/**
 * What closing a result's shipment may touch (moving it to waiting, or cancelling every source).
 * Only reservations created by the closed result itself are released; goods carried from an
 * earlier result that rode the same shipment stay held for the store, whatever product or
 * shipment they share with the closed grant.
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

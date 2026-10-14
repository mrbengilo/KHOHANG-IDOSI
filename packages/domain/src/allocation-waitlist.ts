/**
 * Pure rules for "Chuyển phiếu chờ" (moving an allocation result back to wait tickets) and for
 * cancelling a wait ticket together with the allocation goods that still belong to it.
 * docs/allocation-waitlist-workflow.md
 *
 * Quantities are whole bags. The database "remaining" of a wait ticket is the demand still
 * waiting; "fulfilled" is demand the allocation run already granted (not received).
 */

/** Database state of a wait ticket, as stored. */
export type WaitTicketStoredStatus = 'active' | 'fulfilled' | 'cancelled' | 'expired';

/** One granted allocation line being moved back to waiting. */
export interface WaitlistLine {
  readonly allocationLineId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly quantity: number;
  /** The wait ticket this line was allocated from (priority line), or null for an ordinary order. */
  readonly sourceWaitTicket: {
    readonly id: string;
    readonly status: WaitTicketStoredStatus;
  } | null;
}

export type WaitlistLineMode =
  /**
   * The line came from the store x product's own active ticket: the run had moved these bags
   * from remaining to fulfilled, so they move back. The ticket's original demand is unchanged.
   */
  | 'RESTORE_SOURCE'
  /** New waiting demand added to the active ticket (or the ticket created for this group). */
  | 'ADD_DEMAND'
  /** The source ticket was cancelled: its demand is not requeued; the goods are only released. */
  | 'SKIP_CANCELLED_SOURCE';

export interface WaitlistGroupPlan {
  readonly storeId: string;
  readonly productId: string;
  /** Existing active ticket that receives the demand, or null when one must be created. */
  readonly activeTicketId: string | null;
  readonly restoreQuantity: number;
  readonly addQuantity: number;
  readonly skippedQuantity: number;
  readonly lines: readonly (WaitlistLine & { readonly mode: WaitlistLineMode })[];
}

/**
 * Plans where every bag of a waitlisted result goes. One active ticket per store x product: an
 * existing one is merged into, otherwise one is created for the whole group. The plan never adds
 * the run's own unallocated remainder again (the worker already queued it): only granted bags are
 * planned, and a bag granted from a ticket is restored on that ticket instead of added twice.
 */
export function planWaitlistRequeue(
  lines: readonly WaitlistLine[],
  activeTicketIdByStoreProduct: ReadonlyMap<string, string>,
): readonly WaitlistGroupPlan[] {
  const groups = new Map<string, (WaitlistLine & { mode: WaitlistLineMode })[]>();
  const seen = new Set<string>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError('A waitlisted line must have a positive whole quantity.');
    }
    if (seen.has(line.allocationLineId)) {
      throw new RangeError('An allocation line can be waitlisted only once.');
    }
    seen.add(line.allocationLineId);
    const key = waitTicketGroupKey(line.storeId, line.productId);
    const activeId = activeTicketIdByStoreProduct.get(key) ?? null;
    const source = line.sourceWaitTicket;
    const mode: WaitlistLineMode =
      source?.status === 'cancelled'
        ? 'SKIP_CANCELLED_SOURCE'
        : source !== null && source.id === activeId && source.status === 'active'
          ? 'RESTORE_SOURCE'
          : 'ADD_DEMAND';
    const group = groups.get(key) ?? [];
    group.push({ ...line, mode });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const sum = (mode: WaitlistLineMode) =>
        group.filter((line) => line.mode === mode).reduce((total, line) => total + line.quantity, 0);
      return {
        storeId: group[0]!.storeId,
        productId: group[0]!.productId,
        activeTicketId: activeTicketIdByStoreProduct.get(key) ?? null,
        restoreQuantity: sum('RESTORE_SOURCE'),
        addQuantity: sum('ADD_DEMAND'),
        skippedQuantity: sum('SKIP_CANCELLED_SOURCE'),
        lines: group,
      };
    });
}

export function waitTicketGroupKey(storeId: string, productId: string): string {
  return `${storeId}:${productId}`;
}

export interface WaitTicketCancellationPlan {
  readonly ok: true;
  /** Demand closed by the cancellation: what was waiting plus the revoked grants. */
  readonly cancelledQuantity: number;
  readonly remainingAfter: number;
  readonly fulfilledAfter: number;
}

export type WaitTicketCancellationRefusal = {
  readonly ok: false;
  readonly reason: 'ALREADY_CANCELLED' | 'NOTHING_CANCELLABLE';
};

/**
 * A ticket can be cancelled while it still waits, or when the run already granted it bags that
 * were not yet confirmed (no RE order, not shipped): those grants are revoked and count as
 * cancelled demand again. Goods already issued with an RE order stay fulfilled and untouched.
 * The quantity conservation remaining + fulfilled = original always holds.
 */
export function planWaitTicketCancellation(input: {
  readonly status: WaitTicketStoredStatus;
  readonly originalQuantity: number;
  readonly remainingQuantity: number;
  readonly fulfilledQuantity: number;
  /** Granted bags of this ticket that are still revocable. */
  readonly revocableQuantity: number;
}): WaitTicketCancellationPlan | WaitTicketCancellationRefusal {
  if (input.remainingQuantity + input.fulfilledQuantity !== input.originalQuantity) {
    throw new RangeError('Wait ticket quantities do not conserve the original demand.');
  }
  if (
    !Number.isSafeInteger(input.revocableQuantity) ||
    input.revocableQuantity < 0 ||
    input.revocableQuantity > input.fulfilledQuantity
  ) {
    throw new RangeError('Revocable grants must be part of the fulfilled quantity.');
  }
  if (input.status === 'cancelled') return { ok: false, reason: 'ALREADY_CANCELLED' };
  const cancelled = input.remainingQuantity + input.revocableQuantity;
  if (input.status === 'expired' || cancelled === 0) {
    return { ok: false, reason: 'NOTHING_CANCELLABLE' };
  }
  if (input.status === 'fulfilled' && input.revocableQuantity === 0) {
    return { ok: false, reason: 'NOTHING_CANCELLABLE' };
  }
  return {
    ok: true,
    cancelledQuantity: cancelled,
    remainingAfter: cancelled,
    fulfilledAfter: input.fulfilledQuantity - input.revocableQuantity,
  };
}

/** The three labels shown to HTKD, store and wholesale accounts. */
export const WAIT_TICKET_DISPLAY_STATUSES = ['UNPROCESSED', 'PROCESSED', 'CANCELLED'] as const;
export type WaitTicketDisplayStatus = (typeof WAIT_TICKET_DISPLAY_STATUSES)[number];

export type WaitTicketDisplayDetail =
  | 'WAITING'
  | 'OFFERED'
  | 'PARTIALLY_FULFILLED'
  | 'PENDING_DECISION'
  | 'PROCESSED'
  | 'CANCELLED'
  | 'EXPIRED_LEGACY';

/**
 * Display classification. "Đã xử lý" never means received: it means nothing of the ticket is
 * waiting or awaiting a result answer any more. A fulfilled ticket whose granted bags still sit in
 * a PENDING result is "Chưa xử lý". Expired tickets are legacy only (no current code expires a
 * ticket) and are shown as closed demand that needs reconciliation, never as processed.
 */
export function waitTicketDisplay(input: {
  readonly status: WaitTicketStoredStatus;
  readonly hasOpenOffer: boolean;
  readonly fulfilledQuantity: number;
  /** Granted bags of the ticket in results still waiting for an answer. */
  readonly pendingDecisionQuantity: number;
}): { readonly status: WaitTicketDisplayStatus; readonly detail: WaitTicketDisplayDetail } {
  switch (input.status) {
    case 'cancelled':
      return { status: 'CANCELLED', detail: 'CANCELLED' };
    case 'expired':
      return { status: 'CANCELLED', detail: 'EXPIRED_LEGACY' };
    case 'fulfilled':
      return input.pendingDecisionQuantity > 0
        ? { status: 'UNPROCESSED', detail: 'PENDING_DECISION' }
        : { status: 'PROCESSED', detail: 'PROCESSED' };
    case 'active':
      if (input.hasOpenOffer) return { status: 'UNPROCESSED', detail: 'OFFERED' };
      if (input.pendingDecisionQuantity > 0) {
        return { status: 'UNPROCESSED', detail: 'PENDING_DECISION' };
      }
      return {
        status: 'UNPROCESSED',
        detail: input.fulfilledQuantity > 0 ? 'PARTIALLY_FULFILLED' : 'WAITING',
      };
  }
}

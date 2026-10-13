import { invariant } from './errors.js';
import { nonNegativeInteger, positiveInteger } from './validation.js';

/**
 * Reshare-style supplier reconciliation (docs/supplier-stock-reconciliation.md).
 *
 * The central warehouse A does not hold the goods: B (the supplier warehouse) does, and B
 * deducts its orderable stock the moment it accepts an order. A therefore never adds a
 * re-observed B number on top of its own stock. Instead:
 *
 *   B_eff = S (latest observed orderable stock) + B events not reflected in S
 *   U     = A commitments that B has not recorded yet (priority holds + unordered reservations)
 *   F     = max(0, B_eff - U)   free to allocate
 *   D     = max(0, U - B_eff)   commitments B cannot cover (shown, never hidden)
 *
 * and the warehouse ledger is projected so that onHand - reserved = F, i.e. onHand = R + F.
 * Everything here is pure: callers load the facts, these functions decide.
 */

export const SUPPLIER_EVENT_KINDS = ['ORDER', 'ORDER_CANCEL', 'SOURCE_RETURN'] as const;
export type SupplierEventKind = (typeof SUPPLIER_EVENT_KINDS)[number];

/**
 * OPEN: B recorded it after the current baseline observation (part of DeltaB).
 * COVERED: an observation's S already reflects it.
 * AMBIGUOUS: recorded late, dated at or before the current baseline; nobody has said whether
 * that S reflected it. NOT_APPLICABLE: the event does not change B's orderable stock.
 */
export const SUPPLIER_EVENT_COVERAGES = ['OPEN', 'COVERED', 'AMBIGUOUS', 'NOT_APPLICABLE'] as const;
export type SupplierEventCoverage = (typeof SUPPLIER_EVENT_COVERAGES)[number];

export const SUPPLIER_PRODUCT_STATUSES = [
  'PENDING_BASELINE',
  'ACTIVE',
  'NEEDS_RECONCILIATION',
] as const;
export type SupplierProductStatus = (typeof SUPPLIER_PRODUCT_STATUSES)[number];

/** Reported state of one SKU; only RECONCILED may receive new allocations. */
export const SUPPLIER_RECONCILIATION_STATES = [
  'NO_BASELINE',
  'NEEDS_RECONCILIATION',
  'SHORTFALL',
  'RECONCILED',
] as const;
export type SupplierReconciliationState = (typeof SUPPLIER_RECONCILIATION_STATES)[number];

/** External (B-side) state of one A commitment, independent of A's decision and shipping. */
export const SUPPLIER_ORDER_STATES = [
  'UNKNOWN',
  'NOT_ORDERED',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'CANCEL_PENDING',
  'CANCELLED_CONFIRMED',
] as const;
export type SupplierOrderState = (typeof SUPPLIER_ORDER_STATES)[number];

export interface SupplierEventFact {
  readonly kind: SupplierEventKind;
  readonly quantity: number;
  readonly coverage: SupplierEventCoverage;
}

/** Effect of one event on B's orderable stock. A cancellation alone returns nothing to B. */
export function supplierEventStockDelta(kind: SupplierEventKind, quantity: number): number {
  positiveInteger(quantity, 'quantity');
  if (kind === 'ORDER') return -quantity;
  if (kind === 'SOURCE_RETURN') return quantity;
  return 0;
}

/**
 * Sum of B events not reflected in the baseline. An AMBIGUOUS order is counted (the lower B),
 * an AMBIGUOUS return is not (it would raise B): the unknown always resolves conservatively.
 */
export function pendingSupplierDelta(events: readonly SupplierEventFact[]): number {
  let total = 0;
  for (const event of events) {
    const delta = supplierEventStockDelta(event.kind, event.quantity);
    if (event.coverage === 'OPEN') total += delta;
    else if (event.coverage === 'AMBIGUOUS' && delta < 0) total += delta;
  }
  return total;
}

export interface SupplierReservationFact {
  readonly quantity: number;
  /** Net quantity B has recorded for this commitment (orders minus confirmed cancellations). */
  readonly orderedQuantity: number;
}

export interface SupplierPositionInput {
  readonly status: SupplierProductStatus;
  /** Latest confirmed observation S; null before the first baseline. */
  readonly baselineQuantity: number | null;
  /** Events not covered by the baseline (OPEN or AMBIGUOUS); others are ignored. */
  readonly events: readonly SupplierEventFact[];
  /** Live priority-offer holds; never orderable at B, so always part of U. */
  readonly offerHoldQuantity: number;
  readonly reservations: readonly SupplierReservationFact[];
  readonly ledgerOnHand: number;
  readonly ledgerReserved: number;
}

export interface SupplierPosition {
  readonly state: SupplierReconciliationState;
  readonly baselineQuantity: number | null;
  readonly pendingDelta: number;
  readonly ambiguousEventCount: number;
  /** B_eff; may be negative when recorded orders exceed the observation. Null without baseline. */
  readonly effectiveSupplierQuantity: number | null;
  readonly offerHoldQuantity: number;
  readonly unorderedReservedQuantity: number;
  readonly orderedReservedQuantity: number;
  /** U. */
  readonly unorderedCommitmentQuantity: number;
  /** F; 0 without baseline. */
  readonly freeQuantity: number;
  /** D; 0 without baseline (the shortfall is unknown, not zero: see state). */
  readonly shortfallQuantity: number;
  readonly ledgerOnHand: number;
  readonly ledgerReserved: number;
  /** H - R as the ledger stands. */
  readonly ledgerAvailable: number;
  /** R + F, the on-hand the projection should hold; null without baseline. */
  readonly targetOnHand: number | null;
  /** True when the ledger availability differs from F (a later projection will fix it). */
  readonly projectionMismatch: boolean;
  /** What a new allocation may still take: F when reconciled, otherwise 0. */
  readonly allocatableQuantity: number;
}

export function computeSupplierPosition(input: SupplierPositionInput): SupplierPosition {
  const offerHoldQuantity = nonNegativeInteger(input.offerHoldQuantity, 'offerHoldQuantity');
  const ledgerOnHand = nonNegativeInteger(input.ledgerOnHand, 'ledgerOnHand');
  const ledgerReserved = nonNegativeInteger(input.ledgerReserved, 'ledgerReserved');
  invariant(
    ledgerReserved <= ledgerOnHand,
    'LEDGER_CORRUPTED',
    'Reserved stock cannot exceed on-hand stock.',
  );
  let unorderedReservedQuantity = 0;
  let orderedReservedQuantity = 0;
  for (const reservation of input.reservations) {
    const quantity = positiveInteger(reservation.quantity, 'reservation.quantity');
    const ordered = nonNegativeInteger(reservation.orderedQuantity, 'reservation.orderedQuantity');
    invariant(
      ordered <= quantity,
      'LEDGER_CORRUPTED',
      'A commitment cannot be ordered at the supplier beyond its quantity.',
      { quantity, ordered },
    );
    unorderedReservedQuantity += quantity - ordered;
    orderedReservedQuantity += ordered;
  }
  const unorderedCommitmentQuantity = offerHoldQuantity + unorderedReservedQuantity;
  const pendingDelta = pendingSupplierDelta(input.events);
  const ambiguousEventCount = input.events.filter((event) => event.coverage === 'AMBIGUOUS').length;
  const ledgerAvailable = ledgerOnHand - ledgerReserved;

  if (input.baselineQuantity === null) {
    return {
      state: 'NO_BASELINE',
      baselineQuantity: null,
      pendingDelta,
      ambiguousEventCount,
      effectiveSupplierQuantity: null,
      offerHoldQuantity,
      unorderedReservedQuantity,
      orderedReservedQuantity,
      unorderedCommitmentQuantity,
      freeQuantity: 0,
      shortfallQuantity: 0,
      ledgerOnHand,
      ledgerReserved,
      ledgerAvailable,
      targetOnHand: null,
      projectionMismatch: false,
      allocatableQuantity: 0,
    };
  }

  const baselineQuantity = nonNegativeInteger(input.baselineQuantity, 'baselineQuantity');
  const effectiveSupplierQuantity = baselineQuantity + pendingDelta;
  const freeRaw = effectiveSupplierQuantity - unorderedCommitmentQuantity;
  const freeQuantity = Math.max(0, freeRaw);
  const shortfallQuantity = Math.max(0, -freeRaw);
  const blocked = input.status !== 'ACTIVE' || ambiguousEventCount > 0;
  const state: SupplierReconciliationState = blocked
    ? 'NEEDS_RECONCILIATION'
    : shortfallQuantity > 0
      ? 'SHORTFALL'
      : 'RECONCILED';
  return {
    state,
    baselineQuantity,
    pendingDelta,
    ambiguousEventCount,
    effectiveSupplierQuantity,
    offerHoldQuantity,
    unorderedReservedQuantity,
    orderedReservedQuantity,
    unorderedCommitmentQuantity,
    freeQuantity,
    shortfallQuantity,
    ledgerOnHand,
    ledgerReserved,
    ledgerAvailable,
    targetOnHand: ledgerReserved + freeQuantity,
    projectionMismatch: ledgerAvailable !== freeQuantity,
    allocatableQuantity: state === 'RECONCILED' ? freeQuantity : 0,
  };
}

export interface CoverageCandidate {
  readonly id: string;
  readonly kind: SupplierEventKind;
  readonly coverage: SupplierEventCoverage;
  readonly occurredAt: Date;
}

export interface CoveragePlan {
  /** Events the new observation's S reflects: they leave DeltaB. */
  readonly covered: readonly string[];
  /** Events explicitly declared not reflected: they stay in DeltaB as OPEN. */
  readonly open: readonly string[];
  /** Events dated at or before observedAt without a declaration. Confirmation is refused. */
  readonly undecided: readonly string[];
  /** Declarations that cannot be right: unknown ids, or an event dated after observedAt. */
  readonly invalid: readonly string[];
}

/**
 * Decides, per event identity, what a new observation covers. Dates alone never decide it:
 * every OPEN or AMBIGUOUS event dated at or before observedAt needs an explicit declaration,
 * and an event dated after observedAt can never be covered (B could not show it yet).
 */
export function planObservationCoverage(
  candidates: readonly CoverageCandidate[],
  observedAt: Date,
  declarations: ReadonlyMap<string, boolean>,
): CoveragePlan {
  const covered: string[] = [];
  const open: string[] = [];
  const undecided: string[] = [];
  const invalid: string[] = [];
  const known = new Set<string>();
  for (const event of candidates) {
    if (event.coverage === 'COVERED' || event.coverage === 'NOT_APPLICABLE') continue;
    known.add(event.id);
    const declared = declarations.get(event.id);
    if (event.occurredAt.getTime() > observedAt.getTime()) {
      if (declared === true) invalid.push(event.id);
      continue;
    }
    if (declared === undefined) undecided.push(event.id);
    else if (declared) covered.push(event.id);
    else open.push(event.id);
  }
  for (const id of declarations.keys()) {
    if (!known.has(id)) invalid.push(id);
  }
  return { covered, open, undecided, invalid };
}

/** External state of one commitment, for reports; independent of A's own lifecycle. */
export function supplierOrderState(input: {
  readonly baselineKnown: boolean;
  readonly active: boolean;
  readonly quantity: number;
  readonly orderedQuantity: number;
  readonly cancelledQuantity: number;
}): SupplierOrderState {
  if (!input.active) return input.orderedQuantity > 0 ? 'CANCEL_PENDING' : 'NOT_ORDERED';
  if (input.orderedQuantity >= input.quantity) return 'ORDERED';
  if (input.orderedQuantity > 0) return 'PARTIALLY_ORDERED';
  if (!input.baselineKnown) return 'UNKNOWN';
  return input.cancelledQuantity > 0 ? 'CANCELLED_CONFIRMED' : 'NOT_ORDERED';
}

export interface CancellableLink {
  readonly key: string;
  /** Net quantity of the order still linked to this commitment. */
  readonly netQuantity: number;
}

/**
 * Splits a B cancellation of `quantity` over an order's links, newest link first, never past
 * a link's net quantity. Deterministic, so a retry rebuilds the same split.
 */
export function distributeSupplierCancellation(
  links: readonly CancellableLink[],
  quantity: number,
): readonly { readonly key: string; readonly quantity: number }[] {
  positiveInteger(quantity, 'quantity');
  const available = links.reduce((total, link) => total + link.netQuantity, 0);
  invariant(
    quantity <= available,
    'RECEIPT_QUANTITY_EXCEEDED',
    'A cancellation cannot exceed the quantity still ordered.',
    { quantity, available },
  );
  const result: { key: string; quantity: number }[] = [];
  let left = quantity;
  for (let index = links.length - 1; index >= 0 && left > 0; index -= 1) {
    const link = links[index]!;
    const take = Math.min(link.netQuantity, left);
    if (take > 0) {
      result.push({ key: link.key, quantity: take });
      left -= take;
    }
  }
  return result;
}

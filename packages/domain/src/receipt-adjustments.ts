import { DomainError, invariant } from './errors.js';

/**
 * Post-finalization discrepancy on a store receipt: a bag booked as one SKU turns out to be
 * another once opened. The finalized receipt is never reopened; an adjustment document records
 * what was verified and, once applied, the effective values are "original + applied deltas".
 */

export const RECEIPT_ADJUSTMENT_STATUSES = [
  'PENDING_HTKD',
  'NEEDS_INFO',
  'PENDING_ADMIN',
  'APPLIED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ReceiptAdjustmentStatus = (typeof RECEIPT_ADJUSTMENT_STATUSES)[number];

export const RECEIPT_ADJUSTMENT_ACTIONS = [
  'RESUBMIT',
  'CANCEL',
  'VERIFY',
  'REQUEST_INFO',
  'RETURN_TO_VERIFIER',
  'REJECT',
  'APPLY',
] as const;
export type ReceiptAdjustmentAction = (typeof RECEIPT_ADJUSTMENT_ACTIONS)[number];

export type ReceiptAdjustmentActorRole = 'ADMIN' | 'HTKD' | 'STORE';

/** Statuses in which the document still holds its bags away from new transactions. */
export const OPEN_RECEIPT_ADJUSTMENT_STATUSES: readonly ReceiptAdjustmentStatus[] = [
  'PENDING_HTKD',
  'NEEDS_INFO',
  'PENDING_ADMIN',
];

interface TransitionRule {
  readonly to: ReceiptAdjustmentStatus;
  readonly allowed: readonly {
    readonly from: ReceiptAdjustmentStatus;
    readonly roles: readonly ReceiptAdjustmentActorRole[];
  }[];
}

/**
 * Who may do what, in which status. A store reports and corrects its own report; the assigned
 * HTKD verifies goods, kg, price, fees and cause; only an administrator applies. An admin may
 * also verify for a store with no HTKD, but applying always re-checks the verified snapshot.
 */
export const RECEIPT_ADJUSTMENT_TRANSITIONS: Readonly<
  Record<ReceiptAdjustmentAction, TransitionRule>
> = {
  RESUBMIT: { to: 'PENDING_HTKD', allowed: [{ from: 'NEEDS_INFO', roles: ['STORE'] }] },
  CANCEL: {
    to: 'CANCELLED',
    allowed: [
      { from: 'PENDING_HTKD', roles: ['STORE'] },
      { from: 'NEEDS_INFO', roles: ['STORE'] },
    ],
  },
  VERIFY: { to: 'PENDING_ADMIN', allowed: [{ from: 'PENDING_HTKD', roles: ['HTKD', 'ADMIN'] }] },
  REQUEST_INFO: {
    to: 'NEEDS_INFO',
    allowed: [
      { from: 'PENDING_HTKD', roles: ['HTKD', 'ADMIN'] },
      { from: 'PENDING_ADMIN', roles: ['ADMIN'] },
    ],
  },
  RETURN_TO_VERIFIER: {
    to: 'PENDING_HTKD',
    allowed: [{ from: 'PENDING_ADMIN', roles: ['ADMIN'] }],
  },
  REJECT: {
    to: 'REJECTED',
    allowed: [
      { from: 'PENDING_HTKD', roles: ['HTKD', 'ADMIN'] },
      { from: 'NEEDS_INFO', roles: ['ADMIN'] },
      { from: 'PENDING_ADMIN', roles: ['ADMIN'] },
    ],
  },
  APPLY: { to: 'APPLIED', allowed: [{ from: 'PENDING_ADMIN', roles: ['ADMIN'] }] },
};

export function planReceiptAdjustmentTransition(
  status: ReceiptAdjustmentStatus,
  action: ReceiptAdjustmentAction,
  role: ReceiptAdjustmentActorRole,
): ReceiptAdjustmentStatus {
  const rule = RECEIPT_ADJUSTMENT_TRANSITIONS[action];
  const fromStatus = rule.allowed.filter((entry) => entry.from === status);
  invariant(
    fromStatus.length > 0,
    'INVALID_STATE',
    `Receipt adjustment cannot ${action} from ${status}`,
    { status, action },
  );
  invariant(
    fromStatus.some((entry) => entry.roles.includes(role)),
    'ACTION_NOT_PERMITTED',
    `${role} cannot ${action} a receipt adjustment in ${status}`,
    { status, action, role },
  );
  return rule.to;
}

/** Actions the role may take on a document in this status; drives which buttons are shown. */
export function allowedReceiptAdjustmentActions(
  status: ReceiptAdjustmentStatus,
  role: ReceiptAdjustmentActorRole,
): ReceiptAdjustmentAction[] {
  return RECEIPT_ADJUSTMENT_ACTIONS.filter((action) =>
    RECEIPT_ADJUSTMENT_TRANSITIONS[action].allowed.some(
      (entry) => entry.from === status && entry.roles.includes(role),
    ),
  );
}

/** Same rounding as receipt finalization: each bag rounds half up to a whole VND. */
export function weightedBagCostVnd(weightGrams: bigint, pricePerKgVnd: bigint): bigint {
  invariant(weightGrams > 0n, 'INVALID_ARGUMENT', 'Bag weight must be positive');
  invariant(pricePerKgVnd >= 0n, 'INVALID_ARGUMENT', 'Price per kg cannot be negative');
  return (weightGrams * pricePerKgVnd + 500n) / 1_000n;
}

export interface ReceiptAdjustmentLineFacts {
  /** SKU the warehouse approved and dispatched on this receipt line; null for excess goods. */
  readonly approvedProductId: string | null;
  /** SKU in effect for the bag right now (original receipt, or the latest applied adjustment). */
  readonly recordedProductId: string;
  readonly actualProductId: string;
  readonly recordedWeightGrams: bigint;
  readonly recordedCostVnd: bigint;
  readonly verifiedWeightGrams: bigint;
  readonly verifiedPricePerKgVnd: bigint;
  /** A post-finalization shortage right was already granted for this physical bag. */
  readonly shortageAlreadyGranted: boolean;
}

export interface ReceiptAdjustmentLinePlan {
  readonly verifiedCostVnd: bigint;
  readonly goodsDeltaVnd: bigint;
  readonly weightDeltaGrams: bigint;
  /** Units of the approved SKU owed to the store; granted once per physical bag. */
  readonly shortageQuantity: 0 | 1;
}

export function planReceiptAdjustmentLine(
  facts: ReceiptAdjustmentLineFacts,
): ReceiptAdjustmentLinePlan {
  invariant(
    facts.actualProductId !== facts.recordedProductId,
    'INVALID_ARGUMENT',
    'The verified SKU must differ from the SKU currently recorded for the bag',
  );
  invariant(
    !(facts.shortageAlreadyGranted && facts.actualProductId === facts.approvedProductId),
    'INVALID_STATE',
    'A bag whose missing approved SKU already has a priority wait cannot be reclassified back to that SKU',
  );
  invariant(facts.recordedCostVnd >= 0n, 'INVALID_ARGUMENT', 'Recorded cost cannot be negative');
  const verifiedCostVnd = weightedBagCostVnd(
    facts.verifiedWeightGrams,
    facts.verifiedPricePerKgVnd,
  );
  const shortageQuantity =
    facts.approvedProductId !== null &&
    facts.recordedProductId === facts.approvedProductId &&
    facts.actualProductId !== facts.approvedProductId &&
    !facts.shortageAlreadyGranted
      ? 1
      : 0;
  return {
    verifiedCostVnd,
    goodsDeltaVnd: verifiedCostVnd - facts.recordedCostVnd,
    weightDeltaGrams: facts.verifiedWeightGrams - facts.recordedWeightGrams,
    shortageQuantity,
  };
}

export interface ReceiptMoneyState {
  readonly goodsVnd: bigint;
  readonly freightVnd: bigint;
  readonly handlingVnd: bigint;
  /** Null means VAT was never captured (legacy receipt); it must stay unknown, never 0. */
  readonly vatVnd: bigint | null;
}

export interface ReceiptMoneyDelta {
  readonly goodsVnd: bigint;
  readonly freightVnd: bigint;
  readonly handlingVnd: bigint;
  readonly vatVnd: bigint;
}

export interface ReceiptMoneyView extends ReceiptMoneyState {
  /** Landed cost: goods + freight + handling. VAT stays outside it. */
  readonly costVnd: bigint;
  /** Receipt total including VAT; null while VAT is unknown. */
  readonly totalVnd: bigint | null;
}

export function receiptMoneyView(state: ReceiptMoneyState): ReceiptMoneyView {
  const costVnd = state.goodsVnd + state.freightVnd + state.handlingVnd;
  return { ...state, costVnd, totalVnd: state.vatVnd === null ? null : costVnd + state.vatVnd };
}

/** Effective values = the finalized receipt plus every applied adjustment, in order. */
export function applyReceiptMoneyDeltas(
  original: ReceiptMoneyState,
  deltas: readonly ReceiptMoneyDelta[],
): ReceiptMoneyState {
  return deltas.reduce<ReceiptMoneyState>(
    (state, delta) => ({
      goodsVnd: state.goodsVnd + delta.goodsVnd,
      freightVnd: state.freightVnd + delta.freightVnd,
      handlingVnd: state.handlingVnd + delta.handlingVnd,
      vatVnd: state.vatVnd === null ? null : state.vatVnd + delta.vatVnd,
    }),
    original,
  );
}

export interface ReceiptAdjustmentMoneyPlan {
  readonly before: ReceiptMoneyView;
  readonly delta: ReceiptMoneyDelta & { readonly costVnd: bigint; readonly totalVnd: bigint };
  readonly after: ReceiptMoneyView;
}

export function planReceiptAdjustmentMoney(
  effectiveBefore: ReceiptMoneyState,
  delta: ReceiptMoneyDelta,
): ReceiptAdjustmentMoneyPlan {
  invariant(
    effectiveBefore.vatVnd !== null || delta.vatVnd === 0n,
    'INVALID_ARGUMENT',
    'VAT was never captured for this receipt; a VAT adjustment cannot turn it into a known amount',
  );
  const before = receiptMoneyView(effectiveBefore);
  const after = receiptMoneyView(applyReceiptMoneyDeltas(effectiveBefore, [delta]));
  for (const [field, value] of [
    ['goodsVnd', after.goodsVnd],
    ['freightVnd', after.freightVnd],
    ['handlingVnd', after.handlingVnd],
    ['vatVnd', after.vatVnd ?? 0n],
  ] as const) {
    invariant(value >= 0n, 'INVALID_ARGUMENT', `Adjusted ${field} cannot be negative`, {
      field,
      value: value.toString(),
    });
  }
  const costVnd = delta.goodsVnd + delta.freightVnd + delta.handlingVnd;
  return {
    before,
    after,
    delta: { ...delta, costVnd, totalVnd: costVnd + delta.vatVnd },
  };
}

export const RECEIPT_ADJUSTMENT_BAG_BLOCKERS = [
  'BAG_NOT_HELD',
  'BAG_STATE_CHANGED',
  'BAG_PARTIALLY_CONSUMED',
  'BAG_DEPLETED',
  'BAG_TRANSFERRED',
  'BAG_SORTED',
  'BAG_SOLD',
  'BAG_PENDING_OUTBOUND',
  'BAG_PENDING_TRANSFER',
  'BAG_RETURNED_OR_LOST',
] as const;
export type ReceiptAdjustmentBagBlocker = (typeof RECEIPT_ADJUSTMENT_BAG_BLOCKERS)[number];

export type StoreBagStatus =
  'in_transit' | 'available' | 'opened' | 'depleted' | 'quarantined' | 'returned' | 'lost';

export interface ReceiptAdjustmentBagFacts {
  readonly status: StoreBagStatus;
  readonly initialGrams: bigint;
  readonly currentGrams: bigint;
  readonly normalSaleConsumedGrams: bigint;
  readonly approvedOutboundCount: number;
  readonly pendingOutboundCount: number;
  /** Store transfers out of this bag that were dispatched or received. */
  readonly completedTransferCount: number;
  readonly draftTransferCount: number;
  readonly sortingEventCount: number;
  /** The quarantine on the bag belongs to this adjustment. */
  readonly heldByThisAdjustment: boolean;
  /** The bag's SKU, cost and weight still equal the state the adjustment was verified against. */
  readonly matchesRecordedState: boolean;
}

/**
 * Reclassifying a bag in place is only safe while every gram of it is still on the shelf:
 * once part of it was sold, sorted or moved, those documents were costed as the old SKU and
 * splitting that cost is not supported. Such reports stay on file but cannot be applied.
 */
export function assessReceiptAdjustmentBag(
  facts: ReceiptAdjustmentBagFacts,
): ReceiptAdjustmentBagBlocker[] {
  const blockers = new Set<ReceiptAdjustmentBagBlocker>();
  if (facts.status === 'returned' || facts.status === 'lost') blockers.add('BAG_RETURNED_OR_LOST');
  if (facts.status === 'depleted' || facts.currentGrams === 0n) blockers.add('BAG_DEPLETED');
  else if (facts.currentGrams < facts.initialGrams) blockers.add('BAG_PARTIALLY_CONSUMED');
  if (facts.normalSaleConsumedGrams > 0n || facts.approvedOutboundCount > 0) {
    blockers.add('BAG_SOLD');
  }
  if (facts.pendingOutboundCount > 0) blockers.add('BAG_PENDING_OUTBOUND');
  if (facts.completedTransferCount > 0) blockers.add('BAG_TRANSFERRED');
  if (facts.draftTransferCount > 0) blockers.add('BAG_PENDING_TRANSFER');
  if (facts.sortingEventCount > 0) blockers.add('BAG_SORTED');
  if (!facts.heldByThisAdjustment) blockers.add('BAG_NOT_HELD');
  if (!facts.matchesRecordedState) blockers.add('BAG_STATE_CHANGED');
  return RECEIPT_ADJUSTMENT_BAG_BLOCKERS.filter((code) => blockers.has(code));
}

/** A bag can be quarantined for the report only while it is still sellable stock. */
export function canHoldReceiptAdjustmentBag(status: StoreBagStatus): boolean {
  return status === 'available' || status === 'opened';
}

export function assertReceiptAdjustmentApplicable(
  lines: readonly { readonly receiptBagId: string; readonly blockers: readonly string[] }[],
): void {
  const blocked = lines.filter((line) => line.blockers.length > 0);
  if (blocked.length > 0) {
    throw new DomainError(
      'INVALID_STATE',
      'Receipt adjustment has bags that cannot be reclassified safely',
      Object.fromEntries(blocked.map((line) => [line.receiptBagId, line.blockers.join(',')])),
    );
  }
}

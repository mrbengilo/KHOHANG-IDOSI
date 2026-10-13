import { invariant } from './errors.js';
import { positiveInteger, nonNegativeInteger } from './validation.js';
import type { AllocationDecisionAction, AllocationDecisionStatus } from './allocation-decisions.js';

/**
 * Internal Reshare orders (docs/reshare-auto-orders.md).
 *
 * Accepting an allocation result with new goods creates exactly one RE order for that result
 * (one store, one allocation run) and issues the accepted goods out of the central warehouse in
 * the same transaction. The order is an IDOSI document the store/HTKD copies onto Reshare by
 * hand; nothing here talks to Reshare.
 */

export const RESHARE_ORDER_CODE_PATTERN = /^RE-\d{6}$/u;
export const RESHARE_ORDER_CODE_MAX = 999_999;

/** Same format the database allocator produces; used by the in-memory adapter and tests. */
export function formatReshareOrderCode(sequence: number): string {
  positiveInteger(sequence, 'sequence');
  invariant(
    sequence <= RESHARE_ORDER_CODE_MAX,
    'RESHARE_ORDER_CODE_EXHAUSTED',
    'The RE-000001..RE-999999 range is used up.',
    { sequence },
  );
  return `RE-${String(sequence).padStart(6, '0')}`;
}

export interface ReshareIssueSource {
  readonly reservationId: string;
  readonly allocationLineId: string;
  readonly productId: string;
  readonly quantity: number;
}

export interface ReshareOrderLinePlan {
  readonly productId: string;
  readonly quantity: number;
  readonly sources: readonly ReshareIssueSource[];
}

export interface ReshareOrderPlan {
  readonly totalQuantity: number;
  readonly lines: readonly ReshareOrderLinePlan[];
}

/**
 * Groups the accepted result's own holds into one line per product, in product order (the
 * balance lock order). Quantities come only from the server-side holds; a hold is issued once.
 */
export function planReshareOrder(sources: readonly ReshareIssueSource[]): ReshareOrderPlan {
  const seenReservations = new Set<string>();
  const seenLines = new Set<string>();
  const byProduct = new Map<string, ReshareIssueSource[]>();
  for (const source of sources) {
    positiveInteger(source.quantity, 'source.quantity');
    invariant(
      !seenReservations.has(source.reservationId) && !seenLines.has(source.allocationLineId),
      'DUPLICATE_ALLOCATION',
      'A hold can be issued with an RE order only once.',
      { reservationId: source.reservationId, allocationLineId: source.allocationLineId },
    );
    seenReservations.add(source.reservationId);
    seenLines.add(source.allocationLineId);
    const group = byProduct.get(source.productId) ?? [];
    group.push(source);
    byProduct.set(source.productId, group);
  }
  const lines = [...byProduct]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([productId, group]) => ({
      productId,
      quantity: group.reduce((total, source) => total + source.quantity, 0),
      sources: group,
    }));
  return { totalQuantity: lines.reduce((total, line) => total + line.quantity, 0), lines };
}

export const RESHARE_ORDER_DISPLAY_STATUSES = ['ORDERED', 'NOT_ORDERED', 'CANCELLED'] as const;
export type ReshareOrderDisplayStatus = (typeof RESHARE_ORDER_DISPLAY_STATUSES)[number];

/**
 * "Đã đặt Reshare" needs a committed RE order (its issue ledger is enforced by the database);
 * an accepted decision alone never shows as ordered. Without an order the result is not ordered.
 */
export function reshareOrderDisplayStatus(input: {
  readonly orderStatus: 'ORDERED' | 'CANCELLED' | null;
}): ReshareOrderDisplayStatus {
  if (input.orderStatus === 'ORDERED') return 'ORDERED';
  if (input.orderStatus === 'CANCELLED') return 'CANCELLED';
  return 'NOT_ORDERED';
}

export type AllocationDecisionResponderRole = 'STORE' | 'WHOLESALE' | 'HTKD';

/**
 * Who may answer a result, by action. The receiving side (store, wholesale desk) may accept or
 * reject; an HTKD assigned to the store may accept on its behalf but never reject.
 */
export function allowedAllocationDecisionActions(
  role: AllocationDecisionResponderRole | 'ADMIN',
  status: AllocationDecisionStatus,
): readonly AllocationDecisionAction[] {
  if (status !== 'PENDING') return [];
  if (role === 'STORE' || role === 'WHOLESALE') return ['ACCEPT', 'REJECT'];
  if (role === 'HTKD') return ['ACCEPT'];
  return [];
}

export interface ReceiptSourceShare {
  readonly id: string;
  readonly quantity: number;
  /** True when the hold was issued with an RE order (already out of on-hand). */
  readonly issued: boolean;
}

export interface ReceiptSourceSettlement {
  readonly id: string;
  readonly quantity: number;
  readonly issued: boolean;
  readonly received: number;
  readonly shortage: number;
}

export interface ReceiptLineSettlement {
  readonly sources: readonly ReceiptSourceSettlement[];
  /** Holds still on-hand at receipt time: deducted now (legacy rule). */
  readonly legacyQuantity: number;
  readonly legacyReceived: number;
  readonly issuedQuantity: number;
  readonly issuedReceived: number;
}

/**
 * Spreads a line's received bags over its holds in their stored order (the same order the
 * legacy settlement used). Issued and legacy holds are settled separately afterwards: only the
 * legacy part may still move the central ledger.
 */
export function settleReceiptLine(
  sources: readonly ReceiptSourceShare[],
  receivedQuantity: number,
): ReceiptLineSettlement {
  nonNegativeInteger(receivedQuantity, 'receivedQuantity');
  const total = sources.reduce(
    (sum, source) => sum + positiveInteger(source.quantity, 'source.quantity'),
    0,
  );
  invariant(
    receivedQuantity <= total,
    'RECEIPT_QUANTITY_EXCEEDED',
    'Received quantity exceeds the goods sent for this line.',
    { receivedQuantity, total },
  );
  let left = receivedQuantity;
  const settled = sources.map((source) => {
    const received = Math.min(source.quantity, left);
    left -= received;
    return { ...source, received, shortage: source.quantity - received };
  });
  const sum = (issued: boolean, field: 'quantity' | 'received') =>
    settled.filter((row) => row.issued === issued).reduce((acc, row) => acc + row[field], 0);
  return {
    sources: settled,
    legacyQuantity: sum(false, 'quantity'),
    legacyReceived: sum(false, 'received'),
    issuedQuantity: sum(true, 'quantity'),
    issuedReceived: sum(true, 'received'),
  };
}

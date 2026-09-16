import { DomainError, invariant } from './errors.js';
import {
  assertValidWaitTicket,
  type WaitTicket,
  type WaitTicketReservation,
} from './wait-tickets.js';
import {
  isoTimestamp,
  nonEmpty,
  nonNegativeInteger,
  positiveInteger,
  type IsoTimestamp,
} from './validation.js';

export const RECEIPT_RECONCILIATION_STATUSES = ['FULL', 'SHORT'] as const;
export type ReceiptReconciliationStatus = (typeof RECEIPT_RECONCILIATION_STATUSES)[number];

export interface ReceiptReconciliation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly allocationId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly sourceWaitTicketId: string | null;
  readonly expectedQuantity: number;
  readonly receivedQuantity: number;
  readonly shortageQuantity: number;
  /** Only physically received quantity may be credited to store inventory. */
  readonly inventoryCreditQuantity: number;
  /** A shortage from an existing wait reservation is already in that ticket's open quantity. */
  readonly waitQuantityToAdd: number;
  readonly status: ReceiptReconciliationStatus;
  readonly confirmedAt: IsoTimestamp;
}

export interface ReceiptReconciliationInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly allocationId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly sourceWaitTicketId: string | null;
  readonly expectedQuantity: number;
  readonly receivedQuantity: number;
  readonly confirmedAt: string;
}

export function createReceiptReconciliation(
  input: ReceiptReconciliationInput,
): ReceiptReconciliation {
  const expectedQuantity = positiveInteger(input.expectedQuantity, 'expectedQuantity');
  const receivedQuantity = nonNegativeInteger(input.receivedQuantity, 'receivedQuantity');
  invariant(
    receivedQuantity <= expectedQuantity,
    'RECEIPT_QUANTITY_EXCEEDED',
    'Received quantity cannot exceed the expected shipment quantity',
    { expectedQuantity, receivedQuantity },
  );
  const shortageQuantity = expectedQuantity - receivedQuantity;
  const sourceWaitTicketId =
    input.sourceWaitTicketId === null
      ? null
      : nonEmpty(input.sourceWaitTicketId, 'sourceWaitTicketId');

  return Object.freeze({
    id: nonEmpty(input.id, 'receiptReconciliationId'),
    idempotencyKey: nonEmpty(input.idempotencyKey, 'idempotencyKey'),
    allocationId: nonEmpty(input.allocationId, 'allocationId'),
    storeId: nonEmpty(input.storeId, 'storeId'),
    productId: nonEmpty(input.productId, 'productId'),
    sourceWaitTicketId,
    expectedQuantity,
    receivedQuantity,
    shortageQuantity,
    inventoryCreditQuantity: receivedQuantity,
    waitQuantityToAdd: sourceWaitTicketId === null ? shortageQuantity : 0,
    status: shortageQuantity === 0 ? 'FULL' : 'SHORT',
    confirmedAt: isoTimestamp(input.confirmedAt, 'confirmedAt'),
  });
}

function sameReceiptPayload(left: ReceiptReconciliation, right: ReceiptReconciliation): boolean {
  return (
    left.allocationId === right.allocationId &&
    left.storeId === right.storeId &&
    left.productId === right.productId &&
    left.sourceWaitTicketId === right.sourceWaitTicketId &&
    left.expectedQuantity === right.expectedQuantity &&
    left.receivedQuantity === right.receivedQuantity
  );
}

export interface ReconcileReceiptResult {
  readonly reconciliation: ReceiptReconciliation;
  readonly reconciliations: readonly ReceiptReconciliation[];
  readonly replayed: boolean;
}

export function reconcileReceipt(
  existing: readonly ReceiptReconciliation[],
  input: ReceiptReconciliationInput,
): ReconcileReceiptResult {
  const candidate = createReceiptReconciliation(input);
  const replay = existing.find(
    (reconciliation) => reconciliation.idempotencyKey === candidate.idempotencyKey,
  );
  if (replay !== undefined) {
    if (!sameReceiptPayload(replay, candidate)) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The receipt reconciliation key was already used with another payload',
        { idempotencyKey: candidate.idempotencyKey },
      );
    }
    return Object.freeze({ reconciliation: replay, reconciliations: existing, replayed: true });
  }

  invariant(
    !existing.some((reconciliation) => reconciliation.id === candidate.id),
    'INVALID_ARGUMENT',
    'Receipt reconciliation id must be unique',
    { receiptReconciliationId: candidate.id },
  );
  invariant(
    !existing.some((reconciliation) => reconciliation.allocationId === candidate.allocationId),
    'RECEIPT_ALREADY_RECONCILED',
    'The allocation shipment was already reconciled',
    { allocationId: candidate.allocationId },
  );
  return Object.freeze({
    reconciliation: candidate,
    reconciliations: Object.freeze([...existing, candidate]),
    replayed: false,
  });
}

export interface SettleWaitTicketReceiptResult {
  readonly ticket: WaitTicket;
  readonly replayed: boolean;
}

export function settleWaitTicketReceipt(
  ticket: WaitTicket,
  reconciliation: ReceiptReconciliation,
): SettleWaitTicketReceiptResult {
  assertValidWaitTicket(ticket);
  invariant(
    reconciliation.sourceWaitTicketId === ticket.id &&
      reconciliation.storeId === ticket.storeId &&
      reconciliation.productId === ticket.productId,
    'INVALID_ARGUMENT',
    'Receipt reconciliation does not belong to this wait ticket',
    { ticketId: ticket.id, reconciliationId: reconciliation.id },
  );
  const reservationIndex = ticket.reservations.findIndex(
    (reservation) => reservation.allocationId === reconciliation.allocationId,
  );
  invariant(
    reservationIndex >= 0,
    'INVALID_STATE',
    'Receipt reconciliation has no matching wait reservation',
    { ticketId: ticket.id, allocationId: reconciliation.allocationId },
  );
  const reservation = ticket.reservations[reservationIndex];
  invariant(reservation !== undefined, 'INVALID_STATE', 'Wait reservation index is invalid');
  if (reservation.settledByReceiptId !== null) {
    if (reservation.settledByReceiptId !== reconciliation.id) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'Wait reservation was already settled by another receipt reconciliation',
        { allocationId: reconciliation.allocationId },
      );
    }
    return Object.freeze({ ticket, replayed: true });
  }
  invariant(
    reservation.quantity === reconciliation.expectedQuantity,
    'INVALID_ARGUMENT',
    'Receipt expected quantity must match the wait reservation',
    {
      reservationQuantity: reservation.quantity,
      expectedQuantity: reconciliation.expectedQuantity,
    },
  );

  const settledReservation: WaitTicketReservation = Object.freeze({
    ...reservation,
    settledByReceiptId: reconciliation.id,
  });
  const reservations = [...ticket.reservations];
  reservations[reservationIndex] = settledReservation;
  const openQuantity = ticket.openQuantity - reconciliation.receivedQuantity;
  const reservedQuantity = ticket.reservedQuantity - reconciliation.expectedQuantity;
  invariant(
    openQuantity >= 0 && reservedQuantity >= 0 && reservedQuantity <= openQuantity,
    'INVALID_STATE',
    'Receipt settlement would corrupt wait quantities',
    { ticketId: ticket.id },
  );
  const updated: WaitTicket = Object.freeze({
    ...ticket,
    openQuantity,
    reservedQuantity,
    updatedAt: reconciliation.confirmedAt,
    status: openQuantity === 0 ? 'FULFILLED' : 'ACTIVE',
    reservations: Object.freeze(reservations),
  });
  assertValidWaitTicket(updated);
  return Object.freeze({ ticket: updated, replayed: false });
}

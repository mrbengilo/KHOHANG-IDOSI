import { DomainError, invariant } from './errors.js';
import {
  compareTimestamps,
  isoTimestamp,
  nonEmpty,
  nonNegativeInteger,
  positiveInteger,
  safeIntegerSum,
  stableTupleKey,
  type IsoTimestamp,
} from './validation.js';

export const WAIT_TICKET_STATUSES = ['ACTIVE', 'FULFILLED', 'CANCELLED'] as const;
export type WaitTicketStatus = (typeof WAIT_TICKET_STATUSES)[number];

export const WAIT_TICKET_SOURCE_TYPES = [
  'ALLOCATION_REMAINDER',
  'RECEIPT_SHORTAGE',
  'MANUAL',
] as const;
export type WaitTicketSourceType = (typeof WAIT_TICKET_SOURCE_TYPES)[number];

export interface WaitTicketSource {
  readonly idempotencyKey: string;
  readonly sourceType: WaitTicketSourceType;
  readonly referenceId: string;
  readonly quantity: number;
  readonly requestedAt: IsoTimestamp;
}

export interface WaitTicketReservation {
  readonly idempotencyKey: string;
  readonly allocationId: string;
  readonly quantity: number;
  readonly reservedAt: IsoTimestamp;
  readonly settledByReceiptId: string | null;
}

export interface WaitTicket {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  /** All not-yet-received quantity. This already includes reserved quantity. */
  readonly openQuantity: number;
  /** Subset of openQuantity held by an allocation but not reconciled as received. */
  readonly reservedQuantity: number;
  readonly originalRequestedAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly status: WaitTicketStatus;
  readonly sources: readonly WaitTicketSource[];
  readonly reservations: readonly WaitTicketReservation[];
}

export interface AddWaitTicketDemandInput {
  readonly ticketId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly sourceType: WaitTicketSourceType;
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly recordedAt: string;
}

function normalizeWaitTicketSource(input: AddWaitTicketDemandInput): WaitTicketSource {
  invariant(
    WAIT_TICKET_SOURCE_TYPES.includes(input.sourceType),
    'INVALID_ARGUMENT',
    'Unknown wait ticket source type',
    { sourceType: input.sourceType },
  );
  return Object.freeze({
    idempotencyKey: nonEmpty(input.idempotencyKey, 'idempotencyKey'),
    sourceType: input.sourceType,
    referenceId: nonEmpty(input.referenceId, 'referenceId'),
    quantity: positiveInteger(input.quantity, 'quantity'),
    requestedAt: isoTimestamp(input.requestedAt, 'requestedAt'),
  });
}

function sameWaitSource(left: WaitTicketSource, right: WaitTicketSource): boolean {
  return (
    left.sourceType === right.sourceType &&
    left.referenceId === right.referenceId &&
    left.quantity === right.quantity &&
    left.requestedAt === right.requestedAt
  );
}

export function assertSingleActiveWaitTicket(tickets: readonly WaitTicket[]): void {
  const seen = new Set<string>();
  for (const ticket of tickets) {
    assertValidWaitTicket(ticket);
    if (ticket.status !== 'ACTIVE') {
      continue;
    }
    const key = stableTupleKey([ticket.storeId, ticket.productId]);
    invariant(
      !seen.has(key),
      'ACTIVE_WAIT_TICKET_EXISTS',
      'Only one active wait ticket is allowed per store and product',
      { storeId: ticket.storeId, productId: ticket.productId },
    );
    seen.add(key);
  }
}

export function assertValidWaitTicket(ticket: WaitTicket): void {
  nonEmpty(ticket.id, 'ticketId');
  nonEmpty(ticket.storeId, 'storeId');
  nonEmpty(ticket.productId, 'productId');
  nonNegativeInteger(ticket.openQuantity, 'openQuantity');
  nonNegativeInteger(ticket.reservedQuantity, 'reservedQuantity');
  invariant(
    ticket.reservedQuantity <= ticket.openQuantity,
    'INVALID_STATE',
    'Wait ticket reservedQuantity cannot exceed openQuantity',
    { ticketId: ticket.id },
  );
  invariant(
    WAIT_TICKET_STATUSES.includes(ticket.status),
    'INVALID_STATE',
    'Unknown wait ticket status',
    { ticketId: ticket.id, status: ticket.status },
  );
  invariant(
    ticket.status !== 'ACTIVE' || ticket.openQuantity > 0,
    'INVALID_STATE',
    'An active wait ticket must have open quantity',
    { ticketId: ticket.id },
  );
  invariant(
    ticket.status !== 'FULFILLED' || (ticket.openQuantity === 0 && ticket.reservedQuantity === 0),
    'INVALID_STATE',
    'A fulfilled wait ticket cannot retain open or reserved quantity',
    { ticketId: ticket.id },
  );

  const unsettledReservations = ticket.reservations
    .filter((reservation) => reservation.settledByReceiptId === null)
    .reduce(
      (total, reservation) => safeIntegerSum(total, reservation.quantity, 'reservedQuantity'),
      0,
    );
  invariant(
    unsettledReservations === ticket.reservedQuantity,
    'INVALID_STATE',
    'Wait ticket reservations do not reconcile with reservedQuantity',
    { ticketId: ticket.id },
  );
  invariant(
    new Set(ticket.sources.map((source) => source.idempotencyKey)).size === ticket.sources.length,
    'INVALID_STATE',
    'Wait ticket source idempotency keys must be unique',
    { ticketId: ticket.id },
  );
  invariant(
    new Set(ticket.reservations.map((reservation) => reservation.idempotencyKey)).size ===
      ticket.reservations.length,
    'INVALID_STATE',
    'Wait ticket reservation idempotency keys must be unique',
    { ticketId: ticket.id },
  );
}

export function createWaitTicket(
  existingTickets: readonly WaitTicket[],
  input: AddWaitTicketDemandInput,
): WaitTicket {
  assertSingleActiveWaitTicket(existingTickets);
  invariant(
    !existingTickets.some((ticket) => ticket.id === input.ticketId),
    'INVALID_ARGUMENT',
    'Wait ticket id must be unique',
    { ticketId: input.ticketId },
  );
  const active = existingTickets.find(
    (ticket) =>
      ticket.status === 'ACTIVE' &&
      ticket.storeId === input.storeId &&
      ticket.productId === input.productId,
  );
  invariant(
    active === undefined,
    'ACTIVE_WAIT_TICKET_EXISTS',
    'Only one active wait ticket is allowed per store and product',
    { storeId: input.storeId, productId: input.productId },
  );

  const source = normalizeWaitTicketSource(input);
  const recordedAt = isoTimestamp(input.recordedAt, 'recordedAt');
  const ticket: WaitTicket = Object.freeze({
    id: nonEmpty(input.ticketId, 'ticketId'),
    storeId: nonEmpty(input.storeId, 'storeId'),
    productId: nonEmpty(input.productId, 'productId'),
    openQuantity: source.quantity,
    reservedQuantity: 0,
    originalRequestedAt: source.requestedAt,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    status: 'ACTIVE',
    sources: Object.freeze([source]),
    reservations: Object.freeze([]),
  });
  assertValidWaitTicket(ticket);
  return ticket;
}

export interface UpsertActiveWaitTicketResult {
  readonly ticket: WaitTicket;
  readonly tickets: readonly WaitTicket[];
  readonly replayed: boolean;
  readonly created: boolean;
}

export function upsertActiveWaitTicket(
  existingTickets: readonly WaitTicket[],
  input: AddWaitTicketDemandInput,
): UpsertActiveWaitTicketResult {
  assertSingleActiveWaitTicket(existingTickets);
  const source = normalizeWaitTicketSource(input);

  for (const ticket of existingTickets) {
    const replay = ticket.sources.find(
      (candidate) => candidate.idempotencyKey === source.idempotencyKey,
    );
    if (replay === undefined) {
      continue;
    }
    if (
      ticket.storeId !== input.storeId ||
      ticket.productId !== input.productId ||
      !sameWaitSource(replay, source)
    ) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The wait source idempotency key was already used with another payload',
        { idempotencyKey: source.idempotencyKey },
      );
    }
    return Object.freeze({
      ticket,
      tickets: existingTickets,
      replayed: true,
      created: false,
    });
  }

  const activeIndex = existingTickets.findIndex(
    (ticket) =>
      ticket.status === 'ACTIVE' &&
      ticket.storeId === input.storeId &&
      ticket.productId === input.productId,
  );
  if (activeIndex === -1) {
    const ticket = createWaitTicket(existingTickets, input);
    return Object.freeze({
      ticket,
      tickets: Object.freeze([...existingTickets, ticket]),
      replayed: false,
      created: true,
    });
  }

  const active = existingTickets[activeIndex];
  invariant(active !== undefined, 'INVALID_STATE', 'Active wait ticket index is invalid');
  const updatedAt = isoTimestamp(input.recordedAt, 'recordedAt');
  const updated: WaitTicket = Object.freeze({
    ...active,
    openQuantity: safeIntegerSum(active.openQuantity, source.quantity, 'openQuantity'),
    originalRequestedAt:
      compareTimestamps(source.requestedAt, active.originalRequestedAt) < 0
        ? source.requestedAt
        : active.originalRequestedAt,
    updatedAt,
    sources: Object.freeze([...active.sources, source]),
  });
  assertValidWaitTicket(updated);
  const tickets = [...existingTickets];
  tickets[activeIndex] = updated;
  return Object.freeze({
    ticket: updated,
    tickets: Object.freeze(tickets),
    replayed: false,
    created: false,
  });
}

export interface ReserveWaitTicketInput {
  readonly allocationId: string;
  readonly quantity: number;
  readonly idempotencyKey: string;
  readonly reservedAt: string;
}

export interface ReserveWaitTicketResult {
  readonly ticket: WaitTicket;
  readonly replayed: boolean;
}

export function reserveWaitTicket(
  ticket: WaitTicket,
  input: ReserveWaitTicketInput,
): ReserveWaitTicketResult {
  assertValidWaitTicket(ticket);
  invariant(ticket.status === 'ACTIVE', 'WAIT_TICKET_NOT_ACTIVE', 'Wait ticket is not active', {
    ticketId: ticket.id,
  });
  const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey');
  const quantity = positiveInteger(input.quantity, 'quantity');
  const replay = ticket.reservations.find(
    (reservation) => reservation.idempotencyKey === idempotencyKey,
  );
  if (replay !== undefined) {
    if (replay.allocationId !== input.allocationId || replay.quantity !== quantity) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The wait reservation idempotency key was already used with another payload',
        { idempotencyKey },
      );
    }
    return Object.freeze({ ticket, replayed: true });
  }

  invariant(
    quantity <= ticket.openQuantity - ticket.reservedQuantity,
    'WAIT_QUANTITY_EXCEEDED',
    'Cannot reserve more than the unreserved wait quantity',
    { ticketId: ticket.id, quantity },
  );
  const reservation: WaitTicketReservation = Object.freeze({
    idempotencyKey,
    allocationId: nonEmpty(input.allocationId, 'allocationId'),
    quantity,
    reservedAt: isoTimestamp(input.reservedAt, 'reservedAt'),
    settledByReceiptId: null,
  });
  const updated: WaitTicket = Object.freeze({
    ...ticket,
    reservedQuantity: safeIntegerSum(ticket.reservedQuantity, quantity, 'reservedQuantity'),
    updatedAt: reservation.reservedAt,
    reservations: Object.freeze([...ticket.reservations, reservation]),
  });
  assertValidWaitTicket(updated);
  return Object.freeze({ ticket: updated, replayed: false });
}

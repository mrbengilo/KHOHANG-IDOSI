import { DomainError, invariant } from './errors.js';
import { assertValidWaitTicket, type WaitTicket } from './wait-tickets.js';
import {
  businessDate,
  compareTimestamps,
  isoTimestamp,
  nonEmpty,
  nonNegativeInteger,
  positiveInteger,
  type BusinessDate,
  type IsoTimestamp,
} from './validation.js';

export const DAILY_PRIORITY_OFFER_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'DECLINED',
  'EXPIRED',
  'CONSUMED',
] as const;
export type DailyPriorityOfferStatus = (typeof DAILY_PRIORITY_OFFER_STATUSES)[number];

export interface DailyPriorityOffer {
  readonly id: string;
  readonly waitTicketId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly businessDate: BusinessDate;
  readonly offeredQuantity: number;
  readonly confirmedQuantity: number;
  readonly allocatedQuantity: number;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly status: DailyPriorityOfferStatus;
  readonly confirmedAt: IsoTimestamp | null;
  readonly confirmationIdempotencyKey: string | null;
  readonly allocationId: string | null;
}

export interface DailyPriorityOfferInput {
  readonly id: string;
  readonly businessDate: string;
  readonly offeredQuantity: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

function committedOfferQuantity(offer: DailyPriorityOffer, at: string): number {
  if (offer.status === 'PENDING' && compareTimestamps(at, offer.expiresAt) < 0) {
    return offer.offeredQuantity;
  }
  if (offer.status === 'CONFIRMED') {
    return offer.confirmedQuantity;
  }
  return 0;
}

export function createDailyPriorityOffer(
  ticket: WaitTicket,
  existingOffers: readonly DailyPriorityOffer[],
  input: DailyPriorityOfferInput,
): DailyPriorityOffer {
  assertValidWaitTicket(ticket);
  invariant(ticket.status === 'ACTIVE', 'WAIT_TICKET_NOT_ACTIVE', 'Wait ticket is not active', {
    ticketId: ticket.id,
  });
  const offerBusinessDate = businessDate(input.businessDate);
  invariant(
    !existingOffers.some((offer) => offer.id === input.id),
    'INVALID_ARGUMENT',
    'Daily priority offer id must be unique',
    { offerId: input.id },
  );
  invariant(
    !existingOffers.some(
      (offer) =>
        offer.waitTicketId === ticket.id &&
        offer.businessDate === offerBusinessDate &&
        !['DECLINED', 'EXPIRED'].includes(offer.status) &&
        !(offer.status === 'PENDING' && compareTimestamps(input.createdAt, offer.expiresAt) >= 0),
    ),
    'OFFER_ALREADY_EXISTS',
    'A wait ticket may have only one effective offer per business date',
    { waitTicketId: ticket.id, businessDate: offerBusinessDate },
  );

  const createdAt = isoTimestamp(input.createdAt, 'createdAt');
  const expiresAt = isoTimestamp(input.expiresAt, 'expiresAt');
  invariant(
    compareTimestamps(createdAt, expiresAt) < 0,
    'INVALID_ARGUMENT',
    'Daily priority offer must expire after it is created',
  );
  const offeredQuantity = positiveInteger(input.offeredQuantity, 'offeredQuantity');
  const committedByOtherOffers = existingOffers
    .filter((offer) => offer.waitTicketId === ticket.id)
    .reduce((total, offer) => total + committedOfferQuantity(offer, createdAt), 0);
  const eligibleQuantity = ticket.openQuantity - ticket.reservedQuantity - committedByOtherOffers;
  invariant(
    Number.isSafeInteger(committedByOtherOffers) && offeredQuantity <= eligibleQuantity,
    'WAIT_QUANTITY_EXCEEDED',
    'Offer quantity exceeds the ticket quantity that is eligible for an offer',
    { waitTicketId: ticket.id, offeredQuantity, eligibleQuantity },
  );

  return Object.freeze({
    id: nonEmpty(input.id, 'offerId'),
    waitTicketId: ticket.id,
    storeId: ticket.storeId,
    productId: ticket.productId,
    businessDate: offerBusinessDate,
    offeredQuantity,
    confirmedQuantity: 0,
    allocatedQuantity: 0,
    createdAt,
    expiresAt,
    status: 'PENDING',
    confirmedAt: null,
    confirmationIdempotencyKey: null,
    allocationId: null,
  });
}

export interface ConfirmDailyPriorityOfferInput {
  readonly quantity: number;
  readonly confirmedAt: string;
  readonly idempotencyKey: string;
}

export interface ConfirmDailyPriorityOfferResult {
  readonly offer: DailyPriorityOffer;
  readonly replayed: boolean;
}

export function confirmDailyPriorityOffer(
  offer: DailyPriorityOffer,
  ticket: WaitTicket,
  input: ConfirmDailyPriorityOfferInput,
): ConfirmDailyPriorityOfferResult {
  assertValidWaitTicket(ticket);
  invariant(
    ticket.id === offer.waitTicketId &&
      ticket.storeId === offer.storeId &&
      ticket.productId === offer.productId,
    'INVALID_ARGUMENT',
    'Daily priority offer does not belong to the supplied wait ticket',
  );
  const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey');
  const quantity = positiveInteger(input.quantity, 'quantity');
  const confirmedAt = isoTimestamp(input.confirmedAt, 'confirmedAt');

  if (
    (offer.status === 'CONFIRMED' || offer.status === 'CONSUMED') &&
    offer.confirmationIdempotencyKey === idempotencyKey
  ) {
    if (offer.confirmedQuantity !== quantity) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The offer confirmation key was already used with another quantity',
        { idempotencyKey },
      );
    }
    return Object.freeze({ offer, replayed: true });
  }

  invariant(
    offer.status === 'PENDING',
    'OFFER_NOT_PENDING',
    'Only a pending daily priority offer can be confirmed',
    { offerId: offer.id, status: offer.status },
  );
  invariant(
    compareTimestamps(confirmedAt, offer.createdAt) >= 0,
    'INVALID_ARGUMENT',
    'Daily priority confirmation cannot precede offer creation',
    { offerId: offer.id, createdAt: offer.createdAt },
  );
  invariant(
    compareTimestamps(confirmedAt, offer.expiresAt) < 0,
    'OFFER_EXPIRED',
    'Daily priority confirmation arrived at or after its expiry',
    { offerId: offer.id, expiresAt: offer.expiresAt },
  );
  invariant(
    ticket.status === 'ACTIVE',
    'WAIT_TICKET_NOT_ACTIVE',
    'Cannot confirm an offer for an inactive wait ticket',
    { ticketId: ticket.id },
  );
  invariant(
    quantity <= offer.offeredQuantity && quantity <= ticket.openQuantity - ticket.reservedQuantity,
    'WAIT_QUANTITY_EXCEEDED',
    'Confirmed quantity exceeds the offer or unreserved wait quantity',
    { offerId: offer.id, quantity },
  );

  return Object.freeze({
    offer: Object.freeze({
      ...offer,
      status: 'CONFIRMED',
      confirmedQuantity: quantity,
      confirmedAt,
      confirmationIdempotencyKey: idempotencyKey,
    }),
    replayed: false,
  });
}

export function expireDailyPriorityOffer(
  offer: DailyPriorityOffer,
  now: string,
): DailyPriorityOffer {
  const timestamp = isoTimestamp(now, 'now');
  if (offer.status !== 'PENDING' || compareTimestamps(timestamp, offer.expiresAt) < 0) {
    return offer;
  }
  return Object.freeze({ ...offer, status: 'EXPIRED' });
}

export function declineDailyPriorityOffer(offer: DailyPriorityOffer): DailyPriorityOffer {
  invariant(
    offer.status === 'PENDING',
    'OFFER_NOT_PENDING',
    'Only a pending daily priority offer can be declined',
    { offerId: offer.id, status: offer.status },
  );
  return Object.freeze({ ...offer, status: 'DECLINED' });
}

export interface ConsumeDailyPriorityOfferInput {
  readonly allocationId: string;
  readonly allocatedQuantity: number;
}

export function consumeDailyPriorityOffer(
  offer: DailyPriorityOffer,
  input: ConsumeDailyPriorityOfferInput,
): DailyPriorityOffer {
  invariant(
    offer.status === 'CONFIRMED',
    'OFFER_NOT_CONFIRMED',
    'Only a confirmed daily priority offer can be consumed',
    { offerId: offer.id, status: offer.status },
  );
  const allocatedQuantity = nonNegativeInteger(input.allocatedQuantity, 'allocatedQuantity');
  invariant(
    allocatedQuantity <= offer.confirmedQuantity,
    'WAIT_QUANTITY_EXCEEDED',
    'Allocated quantity exceeds confirmed offer quantity',
    { offerId: offer.id, allocatedQuantity },
  );
  return Object.freeze({
    ...offer,
    status: 'CONSUMED',
    allocatedQuantity,
    allocationId: nonEmpty(input.allocationId, 'allocationId'),
  });
}

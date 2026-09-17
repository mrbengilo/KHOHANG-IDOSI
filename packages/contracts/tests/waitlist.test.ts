import { describe, expect, it } from 'vitest';

import {
  CancelWaitTicketRequestSchema,
  ListPriorityOffersQuerySchema,
  ListWaitTicketsQuerySchema,
  PriorityOfferSchema,
  RespondPriorityOfferRequestSchema,
  WaitTicketHistoryQuerySchema,
  WaitTicketHistoryResponseSchema,
  WaitTicketSchema,
} from '../src/index.js';

const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  audit: '22222222-2222-4222-8222-222222222222',
  offer: '33333333-3333-4333-8333-333333333333',
  order: '44444444-4444-4444-8444-444444444444',
  product: '55555555-5555-4555-8555-555555555555',
  session: '66666666-6666-4666-8666-666666666666',
  store: '77777777-7777-4777-8777-777777777777',
  ticket: '88888888-8888-4888-8888-888888888888',
};

const TIMESTAMP = '2026-09-17T01:00:00Z';

function waitTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IDS.ticket,
    sessionId: IDS.session,
    mergedOrderId: IDS.order,
    storeId: IDS.store,
    productId: IDS.product,
    priority: 'P0A',
    requested: { kind: 'UNIT', quantity: 3 },
    fulfilled: { kind: 'UNIT', quantity: 1 },
    remaining: { kind: 'UNIT', quantity: 2 },
    status: 'PARTIALLY_FULFILLED',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function priorityOffer(): Record<string, unknown> {
  return {
    id: IDS.offer,
    waitTicketId: IDS.ticket,
    storeId: IDS.store,
    productId: IDS.product,
    offered: { kind: 'UNIT', quantity: 2 },
    status: 'PENDING',
    offeredAt: TIMESTAMP,
    expiresAt: '2026-09-17T02:00:00Z',
    respondedAt: null,
    accepted: null,
  };
}

describe('wait-list API contracts', () => {
  it('supports wait tickets that have not been attached to a merged order', () => {
    expect(WaitTicketSchema.safeParse(waitTicket({ mergedOrderId: null })).success).toBe(true);
  });

  it('preserves expired tickets instead of collapsing them into cancelled tickets', () => {
    expect(
      WaitTicketSchema.safeParse(
        waitTicket({
          status: 'EXPIRED',
          fulfilled: { kind: 'UNIT', quantity: 0 },
          remaining: { kind: 'UNIT', quantity: 3 },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects inconsistent fulfilled and partially fulfilled statuses', () => {
    expect(
      WaitTicketSchema.safeParse(
        waitTicket({
          status: 'FULFILLED',
          fulfilled: { kind: 'UNIT', quantity: 1 },
          remaining: { kind: 'UNIT', quantity: 2 },
        }),
      ).success,
    ).toBe(false);
    expect(
      WaitTicketSchema.safeParse(
        waitTicket({
          status: 'PARTIALLY_FULFILLED',
          fulfilled: { kind: 'UNIT', quantity: 0 },
          remaining: { kind: 'UNIT', quantity: 3 },
        }),
      ).success,
    ).toBe(false);
  });

  it('coerces bounded list and history query parameters', () => {
    expect(ListWaitTicketsQuerySchema.parse({ page: '2', pageSize: '50' })).toMatchObject({
      page: 2,
      pageSize: 50,
    });
    expect(ListPriorityOffersQuerySchema.parse({ status: 'PENDING' })).toMatchObject({
      page: 1,
      pageSize: 20,
      status: 'PENDING',
    });
    expect(WaitTicketHistoryQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(WaitTicketHistoryQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('validates cancel and store response commands without server-owned fields', () => {
    expect(CancelWaitTicketRequestSchema.safeParse({ reason: 'Không còn nhu cầu' }).success).toBe(
      true,
    );
    expect(
      RespondPriorityOfferRequestSchema.safeParse({
        action: 'ACCEPT',
        accepted: { kind: 'UNIT', quantity: 2 },
      }).success,
    ).toBe(true);
    expect(
      RespondPriorityOfferRequestSchema.safeParse({
        action: 'DECLINE',
        reason: 'Tồn cửa hàng đã đủ',
      }).success,
    ).toBe(true);
    expect(RespondPriorityOfferRequestSchema.safeParse({ action: 'EXPIRE' }).success).toBe(false);
  });

  it('requires full acceptance and represents effective expiry without a response', () => {
    expect(
      PriorityOfferSchema.safeParse({
        ...priorityOffer(),
        status: 'ACCEPTED',
        accepted: { kind: 'UNIT', quantity: 1 },
        respondedAt: '2026-09-17T01:30:00Z',
      }).success,
    ).toBe(false);
    expect(
      PriorityOfferSchema.safeParse({
        ...priorityOffer(),
        status: 'EXPIRED',
      }).success,
    ).toBe(true);
  });

  it('validates a scoped history response containing offers and immutable audit events', () => {
    expect(
      WaitTicketHistoryResponseSchema.safeParse({
        data: {
          ticket: waitTicket(),
          offers: [priorityOffer()],
          audit: [
            {
              id: IDS.audit,
              requestId: 'request-123',
              actorAccountId: IDS.account,
              actorRole: 'STORE',
              actorStoreId: IDS.store,
              action: 'PRIORITY_OFFER_ACCEPTED',
              entityType: 'PRIORITY_OFFER',
              entityId: IDS.offer,
              before: { status: 'offered' },
              after: { status: 'accepted' },
              metadata: { waitTicketId: IDS.ticket },
              createdAt: TIMESTAMP,
            },
          ],
        },
      }).success,
    ).toBe(true);
  });
});

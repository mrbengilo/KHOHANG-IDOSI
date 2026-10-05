import { DEFAULT_ALLOCATION_POLICY_VERSION } from '@idosi/contracts';
import {
  ALLOCATION_POLICY_VERSION,
  confirmDailyPriorityOffer,
  createDailyPriorityOffer,
  createStoreOrderRequest,
  createWaitTicket,
  mergeOrderRequests,
} from '@idosi/domain';
import { describe, expect, it } from 'vitest';

import { planPriorityOffers, planProductAllocation } from '../src/planning.js';

function ticket(id: string, storeId: string, quantity = 2) {
  return createWaitTicket([], {
    ticketId: id,
    storeId,
    productId: 'product-1',
    quantity,
    sourceType: 'ALLOCATION_REMAINDER',
    referenceId: `source-${id}`,
    idempotencyKey: `wait-${id}`,
    requestedAt: '2026-09-08T02:00:00.000Z',
    recordedAt: '2026-09-08T02:00:01.000Z',
  });
}

describe('domain-backed worker planning', () => {
  it('supports the same policy accepted by API commands', () => {
    expect(DEFAULT_ALLOCATION_POLICY_VERSION).toBe(ALLOCATION_POLICY_VERSION);
  });
  it('offers any positive share, even partial, and records the basis for full versus partial', () => {
    const waitingThree = ticket('ticket-a', 'store-a', 3);
    const waitingOne = ticket('ticket-b', 'store-b', 1);
    const offers = planPriorityOffers({
      businessDate: '2026-09-10',
      createdAt: '2026-09-10T01:00:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
      snapshots: [
        {
          id: 'snapshot-basis',
          version: '1',
          productId: 'product-1',
          availableQuantity: 2,
          capturedAt: '2026-09-10T01:00:00.000Z',
        },
      ],
      waitTickets: [waitingThree, waitingOne],
      existingOffers: [],
      offerId: (ticketId) => `offer-${ticketId}`,
    });
    // One unit per store per round: store A gets 1 of 3 (partial), store B 1 of 1 (full).
    expect(
      offers.map((offer) => [
        offer.waitTicketId,
        offer.offeredQuantity,
        offer.eligibleQuantityAtOffer,
      ]),
    ).toEqual([
      ['ticket-a', 1, 3],
      ['ticket-b', 1, 1],
    ]);
  });

  it('does not offer a ticket again while another session has not settled its offer', () => {
    const waiting = ticket('ticket-late', 'store-late', 2);
    const unsettled = createDailyPriorityOffer(waiting, [], {
      id: 'offer-main-session',
      businessDate: '2026-09-10',
      offeredQuantity: 1,
      createdAt: '2026-09-10T01:00:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
    });
    // The main session's run is late: its offer is past its deadline but still unsettled.
    const offers = planPriorityOffers({
      businessDate: '2026-09-10',
      createdAt: '2026-09-10T07:00:00.000Z',
      expiresAt: '2026-09-10T07:30:00.000Z',
      snapshots: [
        {
          id: 'snapshot-extra',
          version: '2',
          productId: 'product-1',
          availableQuantity: 5,
          capturedAt: '2026-09-10T07:00:00.000Z',
        },
      ],
      waitTickets: [waiting],
      existingOffers: [unsettled],
      alreadyReservedOfferIds: new Set([unsettled.id]),
      offerId: (ticketId) => `offer-extra-${ticketId}`,
    });
    expect(offers).toEqual([]);
  });

  it('does not offer stock already committed by an earlier confirmed offer', () => {
    const first = ticket('ticket-1', 'store-1');
    const second = ticket('ticket-2', 'store-2');
    const priorPending = createDailyPriorityOffer(first, [], {
      id: 'offer-prior',
      businessDate: '2026-09-09',
      offeredQuantity: 1,
      createdAt: '2026-09-09T01:00:00.000Z',
      expiresAt: '2026-09-09T02:00:00.000Z',
    });
    const priorConfirmed = confirmDailyPriorityOffer(priorPending, first, {
      quantity: 1,
      confirmedAt: '2026-09-09T01:30:00.000Z',
      idempotencyKey: 'confirm-prior',
    }).offer;

    const offers = planPriorityOffers({
      businessDate: '2026-09-10',
      createdAt: '2026-09-10T01:00:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
      snapshots: [
        {
          id: 'snapshot-1',
          version: '1',
          productId: 'product-1',
          availableQuantity: 2,
          capturedAt: '2026-09-10T01:00:00.000Z',
        },
      ],
      waitTickets: [first, second],
      existingOffers: [priorConfirmed],
      offerId: (ticketId) => `offer-${ticketId}`,
    });

    expect(offers.reduce((total, offer) => total + offer.offeredQuantity, 0)).toBe(1);

    const physicallyHeldOffers = planPriorityOffers({
      businessDate: '2026-09-10',
      createdAt: '2026-09-10T01:00:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
      snapshots: [
        {
          id: 'snapshot-after-hold',
          version: '2',
          productId: 'product-1',
          availableQuantity: 2,
          capturedAt: '2026-09-10T01:00:00.000Z',
        },
      ],
      waitTickets: [first, second],
      existingOffers: [priorConfirmed],
      alreadyReservedOfferIds: new Set([priorConfirmed.id]),
      offerId: (ticketId) => `offer-after-hold-${ticketId}`,
    });
    expect(physicallyHeldOffers.reduce((total, offer) => total + offer.offeredQuantity, 0)).toBe(2);
  });

  it('does not re-offer a ticket already offered on the same business date', () => {
    const first = ticket('ticket-1', 'store-1');
    const second = ticket('ticket-2', 'store-2');
    // The earlier session of the day offered ticket-1 and the hold expired unanswered.
    const earlier = createDailyPriorityOffer(first, [], {
      id: 'offer-2026-09-10-ticket-1',
      businessDate: '2026-09-10',
      offeredQuantity: 1,
      createdAt: '2026-09-10T01:00:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
    });
    const plan = () =>
      planPriorityOffers({
        businessDate: '2026-09-10',
        createdAt: '2026-09-10T03:00:00.000Z',
        expiresAt: '2026-09-10T04:00:00.000Z',
        snapshots: [
          {
            id: 'snapshot-2',
            version: '2',
            productId: 'product-1',
            availableQuantity: 4,
            capturedAt: '2026-09-10T03:00:00.000Z',
          },
        ],
        waitTickets: [first, second],
        existingOffers: [earlier],
        offerId: (ticketId) => `offer-2026-09-10-${ticketId}`,
      });

    expect(plan).not.toThrow();
    expect(plan().map((offer) => offer.waitTicketId)).toEqual(['ticket-2']);
  });

  it('delegates final priority and round-robin behavior to @idosi/domain', () => {
    const requests = [
      createStoreOrderRequest({
        id: 'request-1',
        sessionId: 'session-1',
        storeId: 'store-1',
        requestSequence: 1,
        idempotencyKey: 'request-key-1',
        submittedAt: '2026-09-10T01:30:00.000Z',
        lines: [{ id: 'line-1', productId: 'product-1', quantity: 2, priority: 'P1' }],
      }),
      createStoreOrderRequest({
        id: 'request-2',
        sessionId: 'session-1',
        storeId: 'store-2',
        requestSequence: 1,
        idempotencyKey: 'request-key-2',
        submittedAt: '2026-09-10T01:31:00.000Z',
        lines: [{ id: 'line-2', productId: 'product-1', quantity: 2, priority: 'P1' }],
      }),
    ];

    const result = planProductAllocation({
      allocationId: 'allocation-1',
      idempotencyKey: 'allocation-key-1',
      sessionId: 'session-1',
      policyVersion: ALLOCATION_POLICY_VERSION,
      allocatedAt: '2026-09-10T02:00:00.000Z',
      snapshot: {
        id: 'snapshot-1:product-1',
        version: '1',
        productId: 'product-1',
        availableQuantity: 2,
        capturedAt: '2026-09-10T01:00:00.000Z',
      },
      mergedRequests: mergeOrderRequests(requests),
      waitTickets: [],
      priorityOffers: [],
      storeOrder: ['store-1', 'store-2'],
      startCursor: 'store-1',
    });

    expect(result.steps.map((step) => step.storeId)).toEqual(['store-1', 'store-2']);
    expect(result.allocatedQuantity).toBe(2);
    expect(result.availableAfter).toBe(0);
  });
});

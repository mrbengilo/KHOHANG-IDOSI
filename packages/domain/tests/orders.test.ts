import { describe, expect, it } from 'vitest';

import {
  createOrderSession,
  createStoreOrderRequest,
  mergeOrderRequests,
  submitOrderRequest,
  type NewOrderPriority,
  type StoreOrderRequestInput,
} from '../src/index.js';

const session = createOrderSession({
  id: 'session-1',
  businessDate: '2026-09-10',
  requestOpensAt: '2026-09-10T07:00:00.000Z',
  requestClosesAt: '2026-09-10T08:00:00.000Z',
  allocationStartsAt: '2026-09-10T09:00:00.000Z',
  status: 'OPEN',
});

function requestInput(
  sequence: 1 | 2,
  quantity: number,
  priority: NewOrderPriority,
  overrides: Partial<StoreOrderRequestInput> = {},
): StoreOrderRequestInput {
  return {
    id: `request-${sequence}`,
    sessionId: session.id,
    storeId: 'store-A',
    requestSequence: sequence,
    idempotencyKey: `request-key-${sequence}`,
    submittedAt: `2026-09-10T07:${sequence === 1 ? '10' : '20'}:00.000Z`,
    lines: [
      {
        id: `line-${sequence}`,
        productId: 'product-1',
        quantity,
        priority,
      },
    ],
    ...overrides,
  };
}

describe('store order requests', () => {
  it('accepts at most two requests per store and session, even if one was cancelled', () => {
    const first = createStoreOrderRequest({ ...requestInput(1, 2, 'P1'), status: 'CANCELLED' });
    const second = createStoreOrderRequest(requestInput(2, 3, 'P3'));

    expect(() =>
      submitOrderRequest(session, [first, second], {
        ...requestInput(2, 1, 'P2'),
        id: 'request-3',
        idempotencyKey: 'request-key-3',
      }),
    ).toThrowError(expect.objectContaining({ code: 'REQUEST_LIMIT_EXCEEDED' }));
  });

  it('replays the same idempotent submission without consuming another slot', () => {
    const first = submitOrderRequest(session, [], requestInput(1, 2, 'P1'));
    const retry = submitOrderRequest(session, first.requests, {
      ...requestInput(1, 2, 'P1'),
      id: 'a-client-generated-id-on-retry',
      submittedAt: '2026-09-10T07:59:00.000Z',
    });

    expect(retry.replayed).toBe(true);
    expect(retry.request).toBe(first.request);
    expect(retry.requests).toHaveLength(1);
  });

  it('rejects a new request exactly at the exclusive cutoff', () => {
    expect(() =>
      submitOrderRequest(session, [], {
        ...requestInput(1, 1, 'P3'),
        submittedAt: session.requestClosesAt,
      }),
    ).toThrowError(expect.objectContaining({ code: 'REQUEST_WINDOW_CLOSED' }));
  });

  it.each(['CANCELLED', 'MERGED'] as const)(
    'does not let a new submission bypass its lifecycle with %s status',
    (status) => {
      expect(() =>
        submitOrderRequest(session, [], {
          ...requestInput(1, 1, 'P3'),
          status,
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    },
  );

  it('keeps both requests equal by merging quantities and retaining the best explicit tier', () => {
    const first = createStoreOrderRequest(requestInput(1, 2, 'P1'));
    const second = createStoreOrderRequest(requestInput(2, 3, 'P3'));
    const merged = mergeOrderRequests([first, second]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      requestedQuantity: 5,
      priority: 'P1',
      sourceIds: ['request-1', 'request-2'],
    });
    expect(merged[0]?.sourceLines.map((source) => source.requestSequence)).toEqual([1, 2]);
    expect(mergeOrderRequests([second, first])).toEqual(merged);
  });

  it('prevents order requests from self-declaring P0A', () => {
    expect(() =>
      createStoreOrderRequest(requestInput(1, 1, 'P0A' as unknown as NewOrderPriority)),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

import { describe, expect, it } from 'vitest';

import {
  AllocationLineSchema,
  CancelStoreOrderRequestSchema,
  CreateOrderSessionRequestSchema,
  CreateStoreOrderRequestSchema,
  CreateWarehouseAdjustmentRequestSchema,
  PriorityOfferSchema,
  StoreOrderRequestSchema,
  TransitionOrderSessionRequestSchema,
  WarehouseBalanceSchema,
} from '../src/index.js';

const IDS = {
  product: '11111111-1111-4111-8111-111111111111',
  productTwo: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333',
  store: '44444444-4444-4444-8444-444444444444',
  order: '55555555-5555-4555-8555-555555555555',
  line: '66666666-6666-4666-8666-666666666666',
  offer: '77777777-7777-4777-8777-777777777777',
  ticket: '88888888-8888-4888-8888-888888888888',
};

describe('order, allocation and wait-list contracts', () => {
  it('requires ordered request and allocation windows', () => {
    expect(
      CreateOrderSessionRequestSchema.safeParse({
        businessDate: '2026-09-10',
        requestOpensAt: '2026-09-10T07:00:00+07:00',
        requestClosesAt: '2026-09-10T09:00:00+07:00',
        allocationStartsAt: '2026-09-10T09:00:00+07:00',
      }).success,
    ).toBe(true);
    expect(
      CreateOrderSessionRequestSchema.safeParse({
        businessDate: '2026-09-10',
        requestOpensAt: '2026-09-10T09:00:00+07:00',
        requestClosesAt: '2026-09-10T08:00:00+07:00',
        allocationStartsAt: '2026-09-10T09:00:00+07:00',
      }).success,
    ).toBe(false);
    expect(
      CreateOrderSessionRequestSchema.safeParse({
        businessDate: '2026-09-10',
        requestOpensAt: '2026-09-09T16:59:59Z',
        requestClosesAt: '2026-09-10T08:00:00+07:00',
        allocationStartsAt: '2026-09-10T09:00:00+07:00',
      }).success,
    ).toBe(false);
    expect(
      CreateOrderSessionRequestSchema.parse({
        businessDate: '2026-09-10',
        requestOpensAt: '2026-09-10T07:00:00+07:00',
        requestClosesAt: '2026-09-10T08:00:00+07:00',
        allocationStartsAt: '2026-09-10T09:00:00+07:00',
      }).policyVersion,
    ).toBe('idosi-round-robin-p0a-p3-v1');
  });

  it('requires optimistic locking and an audit reason for session cancellation', () => {
    expect(
      TransitionOrderSessionRequestSchema.safeParse({ status: 'OPEN', expectedVersion: 0 }).success,
    ).toBe(true);
    expect(TransitionOrderSessionRequestSchema.safeParse({ status: 'OPEN' }).success).toBe(false);
    expect(
      TransitionOrderSessionRequestSchema.safeParse({
        status: 'CANCELLED',
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      TransitionOrderSessionRequestSchema.safeParse({
        status: 'CANCELLED',
        expectedVersion: 1,
        reason: 'Phiên được tạo nhầm ngày',
      }).success,
    ).toBe(true);
  });

  it('accepts only server-neutral fields when creating an order request', () => {
    const request = {
      businessSessionId: IDS.session,
      storeId: IDS.store,
      items: [
        {
          productId: IDS.product,
          quantity: 3,
        },
      ],
    };
    expect(CreateStoreOrderRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ ...request.items[0], note: 'Ưu tiên kiện loại A' }],
      }).success,
    ).toBe(true);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ ...request.items[0], note: '   ' }],
      }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({ ...request, requestSequence: 1 }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ ...request.items[0], priority: 'P1' }],
      }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [request.items[0], request.items[0]],
      }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ productId: IDS.product, quantity: 0 }],
      }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ productId: IDS.product, quantity: 1.5 }],
      }).success,
    ).toBe(false);
    expect(
      CreateStoreOrderRequestSchema.safeParse({
        ...request,
        items: [{ productId: IDS.product, quantity: 100_001 }],
      }).success,
    ).toBe(false);
    expect(
      CancelStoreOrderRequestSchema.safeParse({ reason: 'Cửa hàng nhập nhầm nhu cầu' }).success,
    ).toBe(true);
    expect(CancelStoreOrderRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
  });

  it('retains server-assigned request sequence and priority in responses', () => {
    expect(
      StoreOrderRequestSchema.safeParse({
        id: IDS.order,
        sessionId: IDS.session,
        storeId: IDS.store,
        requestSequence: 1,
        status: 'SUBMITTED',
        lines: [
          {
            productId: IDS.product,
            requested: { kind: 'UNIT', quantity: 3 },
            priority: 'P1',
          },
        ],
        submittedByAccountId: IDS.line,
        submittedAt: '2026-09-10T08:30:00Z',
        cancelledAt: null,
      }).success,
    ).toBe(true);
  });

  it('rejects mixed measurement balances and duplicate adjustment products', () => {
    expect(
      WarehouseBalanceSchema.safeParse({
        productId: IDS.product,
        available: { kind: 'UNIT', quantity: 10 },
        reserved: { kind: 'WEIGHT', value: '1.000', unit: 'kg' },
        version: 1,
        updatedAt: '2026-09-10T08:00:00Z',
      }).success,
    ).toBe(false);

    const adjustmentLine = {
      productId: IDS.product,
      amount: { kind: 'WEIGHT', value: '0.125', unit: 'kg' },
      expectedVersion: 1,
    };
    expect(
      CreateWarehouseAdjustmentRequestSchema.safeParse({
        direction: 'DECREASE',
        reasonCode: 'DAMAGE',
        reason: 'Damaged during count',
        lines: [adjustmentLine],
      }).success,
    ).toBe(true);
    expect(
      CreateWarehouseAdjustmentRequestSchema.safeParse({
        direction: 'DECREASE',
        reasonCode: 'DAMAGE',
        reason: 'Damaged during count',
        lines: [adjustmentLine, adjustmentLine],
      }).success,
    ).toBe(false);
  });

  it('keeps requested, allocated and unfulfilled measurements consistent', () => {
    expect(
      AllocationLineSchema.safeParse({
        id: IDS.line,
        mergedOrderId: IDS.order,
        storeId: IDS.store,
        productId: IDS.product,
        priority: 'P0A',
        reasonCode: 'WAIT_TICKET_ACCEPTED',
        round: 1,
        requested: { kind: 'UNIT', quantity: 2 },
        allocated: { kind: 'UNIT', quantity: 1 },
        unfulfilled: { kind: 'WEIGHT', value: '1', unit: 'kg' },
        status: 'RESERVED',
      }).success,
    ).toBe(false);
  });

  it('requires offer expiry after creation and accepted amount for accepted offers', () => {
    const offer = {
      id: IDS.offer,
      waitTicketId: IDS.ticket,
      storeId: IDS.store,
      productId: IDS.productTwo,
      offered: { kind: 'UNIT', quantity: 1 },
      status: 'ACCEPTED',
      offeredAt: '2026-09-10T08:30:00Z',
      expiresAt: '2026-09-10T09:00:00Z',
      respondedAt: '2026-09-10T08:45:00Z',
      accepted: { kind: 'UNIT', quantity: 1 },
    };
    expect(PriorityOfferSchema.safeParse(offer).success).toBe(true);
    expect(PriorityOfferSchema.safeParse({ ...offer, accepted: null }).success).toBe(false);
    expect(
      PriorityOfferSchema.safeParse({ ...offer, expiresAt: '2026-09-10T08:00:00Z' }).success,
    ).toBe(false);
  });
});

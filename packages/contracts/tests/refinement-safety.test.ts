import { describe, expect, it } from 'vitest';

import {
  AllocationLineSchema,
  CreateOutboundLineSchema,
  InboundReceiptSchema,
  InventoryLotSchema,
  OutboundLineSchema,
  OutboundReceiptDeclarationLineSchema,
  PriorityOfferSchema,
  ReceiptCostConfirmationSchema,
  StoreInventoryBagSchema,
  WaitTicketSchema,
} from '../src/index.js';

interface SafeParser {
  safeParse(input: unknown): { success: boolean };
}

const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  allocation: '22222222-2222-4222-8222-222222222222',
  bag: '33333333-3333-4333-8333-333333333333',
  line: '44444444-4444-4444-8444-444444444444',
  order: '55555555-5555-4555-8555-555555555555',
  product: '66666666-6666-4666-8666-666666666666',
  receipt: '77777777-7777-4777-8777-777777777777',
  session: '88888888-8888-4888-8888-888888888888',
  store: '99999999-9999-4999-8999-999999999999',
  ticket: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const TIMESTAMP = '2026-09-10T08:00:00Z';
const MALFORMED_KG = '1.2.3';
const OVERSIZED_KG = '1234567890123456789012345';

function expectSafeFailure(schema: SafeParser, input: unknown): void {
  let success: boolean | null = null;
  expect(() => {
    success = schema.safeParse(input).success;
  }).not.toThrow();
  expect(success).toBe(false);
}

describe('cross-field refinements never throw for invalid primitives', () => {
  it.each([
    ['fractional goods cost', { goodsCostVnd: 1.5 }],
    ['fractional transportation fee', { transportationFeeVnd: 1.5 }],
    ['non-finite handling fee', { handlingFeeVnd: Number.POSITIVE_INFINITY }],
    ['unsafe total cost', { totalCostVnd: Number.MAX_SAFE_INTEGER + 1 }],
  ])('returns a validation failure for %s', (_label, invalidCost) => {
    expectSafeFailure(ReceiptCostConfirmationSchema, {
      productCosts: [{ productId: IDS.product, priceVndPerKg: 25_000 }],
      transportationFeeVnd: 100,
      handlingFeeVnd: 50,
      goodsCostVnd: 1_000,
      totalCostVnd: 1_150,
      confirmedByAccountId: IDS.account,
      confirmedAt: TIMESTAMP,
      ...invalidCost,
    });
  });

  it('handles malformed and oversized receipt weights without throwing', () => {
    const receipt = {
      id: IDS.receipt,
      referenceCode: 'RCPT-1',
      supplierName: 'Supplier',
      status: 'RECEIVED',
      bags: [
        {
          id: IDS.bag,
          receiptId: IDS.receipt,
          productId: IDS.product,
          bagCode: 'BAG-1',
          weightKg: '1.250',
          createdAt: TIMESTAMP,
        },
      ],
      totalWeightKg: '1.250',
      cost: null,
      version: 0,
      receivedByAccountId: IDS.account,
      receivedAt: TIMESTAMP,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };

    expectSafeFailure(InboundReceiptSchema, {
      ...receipt,
      bags: [{ ...receipt.bags[0], weightKg: MALFORMED_KG }],
    });
    expectSafeFailure(InboundReceiptSchema, { ...receipt, totalWeightKg: OVERSIZED_KG });
  });

  it('handles fractional, unsafe and malformed allocation amounts without throwing', () => {
    const allocation = {
      id: IDS.allocation,
      mergedOrderId: IDS.order,
      storeId: IDS.store,
      productId: IDS.product,
      priority: 'P1',
      reasonCode: 'NORMAL_REQUEST',
      round: 1,
      requested: { kind: 'UNIT', quantity: 2 },
      allocated: { kind: 'UNIT', quantity: 1 },
      unfulfilled: { kind: 'UNIT', quantity: 1 },
      status: 'RESERVED',
    };

    expectSafeFailure(AllocationLineSchema, {
      ...allocation,
      allocated: { kind: 'UNIT', quantity: 0.5 },
    });
    expectSafeFailure(AllocationLineSchema, {
      ...allocation,
      requested: { kind: 'UNIT', quantity: Number.MAX_SAFE_INTEGER + 1 },
    });
    expectSafeFailure(AllocationLineSchema, {
      ...allocation,
      requested: { kind: 'WEIGHT', value: '2', unit: 'kg' },
      allocated: { kind: 'WEIGHT', value: MALFORMED_KG, unit: 'kg' },
      unfulfilled: { kind: 'WEIGHT', value: '1', unit: 'kg' },
    });
  });

  it('handles malformed wait-ticket and priority-offer amounts without throwing', () => {
    const ticket = {
      id: IDS.ticket,
      sessionId: IDS.session,
      mergedOrderId: IDS.order,
      storeId: IDS.store,
      productId: IDS.product,
      priority: 'P1',
      requested: { kind: 'WEIGHT', value: '2', unit: 'kg' },
      fulfilled: { kind: 'WEIGHT', value: '1', unit: 'kg' },
      remaining: { kind: 'WEIGHT', value: '1', unit: 'kg' },
      status: 'PARTIALLY_FULFILLED',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    expectSafeFailure(WaitTicketSchema, {
      ...ticket,
      fulfilled: { kind: 'WEIGHT', value: MALFORMED_KG, unit: 'kg' },
    });

    const offer = {
      id: IDS.allocation,
      waitTicketId: IDS.ticket,
      storeId: IDS.store,
      productId: IDS.product,
      offered: { kind: 'UNIT', quantity: 2 },
      status: 'ACCEPTED',
      offeredAt: TIMESTAMP,
      expiresAt: '2026-09-10T09:00:00Z',
      respondedAt: '2026-09-10T08:30:00Z',
      accepted: { kind: 'UNIT', quantity: 1 },
    };
    expectSafeFailure(PriorityOfferSchema, {
      ...offer,
      accepted: { kind: 'UNIT', quantity: 0.5 },
    });
    expectSafeFailure(PriorityOfferSchema, {
      ...offer,
      offered: { kind: 'WEIGHT', value: OVERSIZED_KG, unit: 'kg' },
      accepted: { kind: 'WEIGHT', value: '1', unit: 'kg' },
    });
  });

  it('handles malformed outbound weights and bag gram counts without throwing', () => {
    const outboundLine = {
      allocationLineId: IDS.allocation,
      productId: IDS.product,
      amount: { kind: 'WEIGHT', value: '1.250', unit: 'kg' },
      bagPicks: [{ sourceReceiptBagId: IDS.bag, weightGrams: 1_250 }],
    };
    expectSafeFailure(CreateOutboundLineSchema, {
      ...outboundLine,
      amount: { kind: 'WEIGHT', value: MALFORMED_KG, unit: 'kg' },
    });
    expectSafeFailure(CreateOutboundLineSchema, {
      ...outboundLine,
      bagPicks: [{ sourceReceiptBagId: IDS.bag, weightGrams: 1_250.5 }],
    });
    expectSafeFailure(OutboundLineSchema, {
      id: IDS.line,
      ...outboundLine,
      amount: { kind: 'WEIGHT', value: OVERSIZED_KG, unit: 'kg' },
    });
    expectSafeFailure(OutboundReceiptDeclarationLineSchema, {
      outboundLineId: IDS.line,
      expected: { kind: 'WEIGHT', value: '1', unit: 'kg' },
      actual: { kind: 'WEIGHT', value: MALFORMED_KG, unit: 'kg' },
      declaration: 'SHORT',
      shortageReason: 'Damaged in transit',
    });
  });

  it('handles malformed store bag and inventory-lot weights without throwing', () => {
    const bag = {
      id: IDS.bag,
      storeId: IDS.store,
      productId: IDS.product,
      sourceReceiptBagId: IDS.receipt,
      outboundOrderId: IDS.order,
      bagCode: 'BAG-1',
      originalWeightKg: '2',
      receivedWeightKg: '2',
      remainingWeightKg: '1',
      status: 'OPEN',
      version: 1,
      receivedAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    expectSafeFailure(StoreInventoryBagSchema, { ...bag, receivedWeightKg: MALFORMED_KG });
    expectSafeFailure(StoreInventoryBagSchema, { ...bag, originalWeightKg: OVERSIZED_KG });

    const lot = {
      id: IDS.bag,
      storeId: IDS.store,
      productId: IDS.product,
      receiptId: IDS.receipt,
      initialWeightKg: '2',
      remainingWeightKg: '1',
      costVnd: 50_000,
      status: 'AVAILABLE',
      version: 1,
      receivedAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    expectSafeFailure(InventoryLotSchema, { ...lot, remainingWeightKg: MALFORMED_KG });
    expectSafeFailure(InventoryLotSchema, {
      ...lot,
      remainingWeightKg: OVERSIZED_KG,
      costVnd: Number.MAX_SAFE_INTEGER + 1,
    });
  });
});

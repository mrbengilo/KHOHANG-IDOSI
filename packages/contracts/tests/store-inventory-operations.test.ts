import { describe, expect, it } from 'vitest';

import {
  CreateStoreOutboundRequestSchema,
  StoreBagOpeningSchema,
  ListStoreInventoryBagLedgerQuerySchema,
  OpenStoreInventoryBagRequestSchema,
  OutboundReasonSchema,
} from '../src/index.js';

describe('store inventory operation contracts', () => {
  it('requires optimistic locking when a bag is opened', () => {
    expect(OpenStoreInventoryBagRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(true);
    expect(OpenStoreInventoryBagRequestSchema.safeParse({}).success).toBe(false);
    expect(OpenStoreInventoryBagRequestSchema.safeParse({ expectedVersion: -1 }).success).toBe(
      false,
    );
  });

  it('validates ledger pagination and optional server-scoped filters', () => {
    const storeId = '11111111-1111-4111-8111-111111111111';
    const productId = '22222222-2222-4222-8222-222222222222';
    expect(
      ListStoreInventoryBagLedgerQuerySchema.parse({
        page: '2',
        pageSize: '25',
        storeId,
        productId,
      }),
    ).toEqual({ page: 2, pageSize: 25, storeId, productId });
    expect(
      ListStoreInventoryBagLedgerQuerySchema.safeParse({ page: 1, pageSize: 101 }).success,
    ).toBe(false);
  });

  it('requires the selected inventory version for a stock removal request', () => {
    const request = {
      storeId: '11111111-1111-4111-8111-111111111111',
      inventoryLotId: '22222222-2222-4222-8222-222222222222',
      expectedInventoryVersion: 3,
      weightKg: '12.500',
      reason: 'SALE_KG',
      revenueVnd: 2_000_000,
    };
    expect(CreateStoreOutboundRequestSchema.safeParse(request).success).toBe(true);
    expect(CreateStoreOutboundRequestSchema.safeParse({ ...request, reason: 'TORN' }).success).toBe(
      false,
    );
    expect(
      CreateStoreOutboundRequestSchema.safeParse({
        storeId: request.storeId,
        inventoryLotId: request.inventoryLotId,
        weightKg: request.weightKg,
        reason: request.reason,
        revenueVnd: request.revenueVnd,
      }).success,
    ).toBe(false);
  });

  it('requires a positive piece count only for sale by piece', () => {
    const request = {
      storeId: '11111111-1111-4111-8111-111111111111',
      inventoryLotId: '22222222-2222-4222-8222-222222222222',
      expectedInventoryVersion: 3,
      weightKg: '1.250',
      reason: 'SALE_PIECE',
      revenueVnd: 100_000,
    };
    expect(CreateStoreOutboundRequestSchema.safeParse(request).success).toBe(false);
    expect(CreateStoreOutboundRequestSchema.safeParse({ ...request, pieceCount: 2 }).success).toBe(
      true,
    );
    expect(CreateStoreOutboundRequestSchema.safeParse({ ...request, pieceCount: 0 }).success).toBe(
      false,
    );
    expect(
      CreateStoreOutboundRequestSchema.safeParse({ ...request, pieceCount: 2, revenueVnd: null })
        .success,
    ).toBe(false);
    expect(
      CreateStoreOutboundRequestSchema.safeParse({ ...request, reason: 'CHARITY', pieceCount: 2 })
        .success,
    ).toBe(false);
    expect(
      CreateStoreOutboundRequestSchema.safeParse({
        ...request,
        reason: 'CANCEL',
        pieceCount: null,
        revenueVnd: null,
      }).success,
    ).toBe(true);
  });

  it('still recognizes historical reasons when reading old outbounds', () => {
    expect(OutboundReasonSchema.parse('DISCOUNT_SALE')).toBe('DISCOUNT_SALE');
    expect(OutboundReasonSchema.parse('TORN')).toBe('TORN');
  });
});

describe('opening actor projection', () => {
  const legacy = {
    id: '11111111-1111-4111-8111-111111111111',
    bagId: '22222222-2222-4222-8222-222222222222',
    storeId: '33333333-3333-4333-8333-333333333333',
    bagCode: null,
    productId: null,
    weightBeforeKg: null,
    weightAfterKg: null,
    normalSaleAppliedKg: null,
    actorAccountId: null,
    actorDisplayName: null,
    actorRole: null,
    openedAt: null,
    source: 'LEGACY',
    currentStatus: 'OPEN',
  };
  it('accepts null legacy identity and validated roles without sensitive fields', () => {
    expect(StoreBagOpeningSchema.parse(legacy)).toEqual(legacy);
    for (const actorRole of ['ADMIN', 'HTKD', 'STORE', 'WHOLESALE']) {
      expect(
        StoreBagOpeningSchema.safeParse({ ...legacy, actorRole, actorDisplayName: 'Tên tài khoản' })
          .success,
      ).toBe(true);
    }
    expect(StoreBagOpeningSchema.safeParse({ ...legacy, actorRole: 'SYSTEM' }).success).toBe(false);
    expect(StoreBagOpeningSchema.safeParse({ ...legacy, passwordHash: 'secret' }).success).toBe(
      false,
    );
  });
});

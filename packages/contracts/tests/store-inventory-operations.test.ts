import { describe, expect, it } from 'vitest';

import {
  CreateStoreOutboundRequestSchema,
  ListStoreInventoryBagLedgerQuerySchema,
  OpenStoreInventoryBagRequestSchema,
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
      reason: 'DISCOUNT_SALE',
      revenueVnd: 2_000_000,
    };
    expect(CreateStoreOutboundRequestSchema.safeParse(request).success).toBe(true);
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
});

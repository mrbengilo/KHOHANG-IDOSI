import { describe, expect, it } from 'vitest';

import { CreateStoreTransferRequestSchema, StoreTransferSchema } from '../src/store-transfers.js';

const SOURCE = '10000000-0000-4000-8000-000000000001';
const DESTINATION = '10000000-0000-4000-8000-000000000002';
const BAG = '10000000-0000-4000-8000-000000000003';
const ACTOR = '10000000-0000-4000-8000-000000000004';

describe('store transfer contracts', () => {
  it('keeps transfer weight as an exact kilogram string', () => {
    const parsed = CreateStoreTransferRequestSchema.parse({
      sourceStoreId: SOURCE,
      destinationStoreId: DESTINATION,
      sourceInventoryBagId: BAG,
      weightKg: '0.001',
      expectedSourceBagVersion: 2,
      note: null,
    });
    expect(parsed.weightKg).toBe('0.001');
    expect(() => CreateStoreTransferRequestSchema.parse({ ...parsed, weightKg: 0.001 })).toThrow();
  });

  it('rejects transfers to the same store', () => {
    expect(() =>
      CreateStoreTransferRequestSchema.parse({
        sourceStoreId: SOURCE,
        destinationStoreId: SOURCE,
        sourceInventoryBagId: BAG,
        weightKg: '1.000',
        expectedSourceBagVersion: 0,
        note: null,
      }),
    ).toThrow();
  });

  it('requires destination provenance once received', () => {
    expect(() =>
      StoreTransferSchema.parse({
        id: '10000000-0000-4000-8000-000000000005',
        transferNumber: 'TR-001',
        sourceStoreId: SOURCE,
        destinationStoreId: DESTINATION,
        sourceInventoryBagId: BAG,
        destinationInventoryBagId: null,
        productId: '10000000-0000-4000-8000-000000000006',
        weightKg: '1.000',
        costVnd: 10_000,
        status: 'RECEIVED',
        note: null,
        cancellationReason: null,
        version: 2,
        createdByAccountId: ACTOR,
        dispatchedByAccountId: ACTOR,
        receivedByAccountId: ACTOR,
        createdAt: '2026-09-17T00:00:00.000Z',
        dispatchedAt: '2026-09-17T00:01:00.000Z',
        receivedAt: '2026-09-17T00:02:00.000Z',
        cancelledAt: null,
        updatedAt: '2026-09-17T00:02:00.000Z',
      }),
    ).toThrow();
  });
});

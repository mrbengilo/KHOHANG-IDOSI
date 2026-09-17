import type { StoreTransfer } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import { isTransferWeightAllowed, transferActionsForStore } from './TransferOperations';

const sourceStoreId = '10000000-0000-4000-8000-000000000001';
const destinationStoreId = '10000000-0000-4000-8000-000000000002';

const draftTransfer = {
  id: '20000000-0000-4000-8000-000000000001',
  transferNumber: 'TR-20260917-0001',
  sourceStoreId,
  destinationStoreId,
  sourceInventoryBagId: '30000000-0000-4000-8000-000000000001',
  destinationInventoryBagId: null,
  productId: '40000000-0000-4000-8000-000000000001',
  weightKg: '5.250',
  costVnd: null,
  status: 'DRAFT',
  note: null,
  cancellationReason: null,
  version: 0,
  createdByAccountId: '50000000-0000-4000-8000-000000000001',
  dispatchedByAccountId: null,
  receivedByAccountId: null,
  createdAt: '2026-09-17T02:00:00.000Z',
  dispatchedAt: null,
  receivedAt: null,
  cancelledAt: null,
  updatedAt: '2026-09-17T02:00:00.000Z',
} satisfies StoreTransfer;

describe('transfer UI guards', () => {
  it('uses exact gram precision and rejects non-canonical or excessive weights', () => {
    expect(isTransferWeightAllowed('9007199254740993.007', '9007199254740993.007')).toBe(true);
    expect(isTransferWeightAllowed('5.251', '5.250')).toBe(false);
    expect(isTransferWeightAllowed('0.000', '5.250')).toBe(false);
    expect(isTransferWeightAllowed('05.000', '5.250')).toBe(false);
    expect(isTransferWeightAllowed('5.0000', '5.250')).toBe(false);
  });

  it('only gives the source draft controls and the destination receipt control', () => {
    expect(transferActionsForStore(draftTransfer, sourceStoreId)).toEqual(['DISPATCH', 'CANCEL']);
    expect(transferActionsForStore(draftTransfer, destinationStoreId)).toEqual([]);
    expect(
      transferActionsForStore(
        {
          ...draftTransfer,
          costVnd: 525_000,
          dispatchedAt: '2026-09-17T03:00:00.000Z',
          dispatchedByAccountId: draftTransfer.createdByAccountId,
          status: 'IN_TRANSIT',
          version: 1,
        },
        destinationStoreId,
      ),
    ).toEqual(['RECEIVE']);
  });
});

import { describe, expect, it } from 'vitest';

import { heldAllocationRows } from './HeldAllocationsPanel';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

describe('held allocation rows', () => {
  it('lists the longest-held goods first with readable names', () => {
    const rows = heldAllocationRows(
      [
        {
          storeId: STORE_B,
          productId: PRODUCT,
          heldUnits: 1,
          heldSince: '2026-09-23T02:00:00.000Z',
        },
        {
          storeId: STORE_A,
          productId: PRODUCT,
          heldUnits: 4,
          heldSince: '2026-09-21T02:00:00.000Z',
        },
      ],
      new Map([[STORE_A, 'DS_TH']]),
      new Map([[PRODUCT, 'Quần jean nam']]),
    );
    expect(rows).toEqual([
      {
        key: `${STORE_A}:${PRODUCT}`,
        storeName: 'DS_TH',
        productName: 'Quần jean nam',
        heldUnits: 4,
        heldSince: '2026-09-21T02:00:00.000Z',
      },
      // An unknown store falls back to its id instead of disappearing.
      expect.objectContaining({ storeName: STORE_B, heldUnits: 1 }),
    ]);
  });
});

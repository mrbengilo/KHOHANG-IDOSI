import { describe, expect, it } from 'vitest';

import type { ProductConversion as CatalogProduct } from '../../lib/types';
import { productOptionsFor, unmatchedNeedingAction } from './IdosiProductLinksPanel';

const product = (id: string, name: string): CatalogProduct => ({
  id,
  name,
  itemQuantity: null,
  weightKilograms: null,
  status: 'ACTIVE',
  effectiveDate: '2026-09-01',
});

describe('IDOSI product link helpers', () => {
  it('lists same-name candidates first so the Admin sees the likely choices', () => {
    const catalog = [product('a', 'Áo nữ'), product('b', 'Đầm'), product('c', 'Áo nữ ')];
    expect(productOptionsFor(catalog, ['c', 'a']).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('hides items the next sync links on its own', () => {
    const base = { productName: 'Áo nữ', storeCount: 2, candidateProductIds: [] };
    expect(
      unmatchedNeedingAction({
        period: '2026-09',
        links: [],
        unmatched: [
          { ...base, idosiProductId: '1', reason: 'NO_PRODUCT' },
          { ...base, idosiProductId: '2', reason: 'PENDING_SYNC' },
          { ...base, idosiProductId: '3', reason: 'AMBIGUOUS' },
        ],
      }).map((item) => item.idosiProductId),
    ).toEqual(['1', '3']);
    expect(unmatchedNeedingAction(undefined)).toEqual([]);
  });
});

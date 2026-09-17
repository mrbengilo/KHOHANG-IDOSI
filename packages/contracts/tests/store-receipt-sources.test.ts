import { describe, expect, it } from 'vitest';

import {
  ListStoreReceiptSourcesQuerySchema,
  ListStoreReceiptSourcesResponseSchema,
  StoreReceiptSourceSchema,
} from '../src/index.js';

const IDS = {
  outbound: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  secondProduct: '33333333-3333-4333-8333-333333333333',
  store: '44444444-4444-4444-8444-444444444444',
};

const source = {
  id: IDS.outbound,
  requestNumber: 'OUT-2026-0001',
  storeId: IDS.store,
  dispatchedAt: '2026-09-17T08:00:00+07:00',
  lines: [{ productId: IDS.product, approvedUnits: 4, dispatchedUnits: 4 }],
};

describe('store receipt source contracts', () => {
  it('accepts a lightweight dispatched outbound source and paginated response', () => {
    expect(StoreReceiptSourceSchema.parse(source)).toEqual(source);
    expect(
      ListStoreReceiptSourcesResponseSchema.safeParse({
        data: [source],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }).success,
    ).toBe(true);
  });

  it('requires positive dispatched units that do not exceed approval', () => {
    expect(
      StoreReceiptSourceSchema.safeParse({
        ...source,
        lines: [{ productId: IDS.product, approvedUnits: 4, dispatchedUnits: 0 }],
      }).success,
    ).toBe(false);
    expect(
      StoreReceiptSourceSchema.safeParse({
        ...source,
        lines: [{ productId: IDS.product, approvedUnits: 4, dispatchedUnits: 5 }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate products and invalid dispatch timestamps', () => {
    expect(
      StoreReceiptSourceSchema.safeParse({
        ...source,
        lines: [...source.lines, { productId: IDS.product, approvedUnits: 2, dispatchedUnits: 2 }],
      }).success,
    ).toBe(false);
    expect(StoreReceiptSourceSchema.safeParse({ ...source, dispatchedAt: null }).success).toBe(
      false,
    );
  });

  it('coerces pagination and scopes only by a valid store identifier', () => {
    expect(
      ListStoreReceiptSourcesQuerySchema.parse({
        page: '2',
        pageSize: '25',
        storeId: IDS.store,
      }),
    ).toEqual({ page: 2, pageSize: 25, storeId: IDS.store });
    expect(
      ListStoreReceiptSourcesQuerySchema.safeParse({
        page: 1,
        pageSize: 101,
        storeId: IDS.secondProduct,
      }).success,
    ).toBe(false);
  });
});

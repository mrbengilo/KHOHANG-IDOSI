import type { Receipt, Store, StoreOrderRequest } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';
import { periodStartInstant, wholesaleTotals } from './WholesaleOverview';

const store = { id: 'store-a', kind: 'WHOLESALE' } as Store;
const otherStore = { id: 'store-b', kind: 'WHOLESALE' } as Store;

describe('wholesale order and receipt totals', () => {
  it('uses store scope, business month, active orders and submitted actual receipts', () => {
    const order = (storeId: string, status: StoreOrderRequest['status'], submittedAt: string) =>
      ({
        storeId,
        status,
        submittedAt,
        lines: [{ productId: 'dress', requested: { kind: 'UNIT', quantity: 3 } }],
      }) as StoreOrderRequest;
    const receipt = (storeId: string, status: Receipt['status'], createdAt: string) =>
      ({
        storeId,
        status,
        createdAt,
        lines: [{ productId: 'dress', approvedUnits: 3, receivedUnits: 1 }],
        unexpectedItems: [{ productId: 'shirt', quantity: 3 }],
      }) as Receipt;
    const totals = wholesaleTotals(
      [store, otherStore],
      [
        order(store.id, 'SUBMITTED', '2026-09-30T17:30:00Z'),
        order(store.id, 'CANCELLED', '2026-09-15T01:00:00Z'),
        order(otherStore.id, 'SUBMITTED', '2026-09-15T01:00:00Z'),
      ],
      [
        receipt(store.id, 'PENDING_HTKD', '2026-09-15T01:00:00Z'),
        receipt(store.id, 'DRAFT', '2026-09-15T01:00:00Z'),
        receipt(otherStore.id, 'FINALIZED', '2026-09-15T01:00:00Z'),
      ],
      '2026-09',
    );
    expect(totals.get(store.id)).toEqual([
      { productId: 'dress', ordered: 0, received: 1 },
      { productId: 'shirt', ordered: 0, received: 3 },
    ]);
    expect(totals.get(otherStore.id)).toEqual([
      { productId: 'dress', ordered: 3, received: 1 },
      { productId: 'shirt', ordered: 0, received: 3 },
    ]);
  });

  it('loads a month from its first Vietnam midnight', () => {
    expect(periodStartInstant('2026-09')).toBe('2026-08-31T17:00:00.000Z');
    expect(periodStartInstant('2027-01')).toBe('2026-12-31T17:00:00.000Z');
  });
});

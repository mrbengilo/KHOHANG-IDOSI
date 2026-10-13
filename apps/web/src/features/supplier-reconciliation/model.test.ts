import type { SupplierCommitment, SupplierPosition } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildOrderLines,
  freeChangeSentence,
  fromBusinessLocalInput,
  pageTotals,
  parseBags,
  positionSentence,
  readSupplierTab,
  supplierTabsFor,
  toBusinessLocalInput,
} from './model';

const position = (overrides: Partial<SupplierPosition>): SupplierPosition => ({
  state: 'RECONCILED',
  baselineQuantity: 3,
  pendingDelta: 0,
  ambiguousEventCount: 0,
  effectiveSupplierQuantity: 3,
  offerHoldQuantity: 0,
  unorderedReservedQuantity: 3,
  orderedReservedQuantity: 0,
  unorderedCommitmentQuantity: 3,
  freeQuantity: 0,
  shortfallQuantity: 0,
  ledgerOnHand: 3,
  ledgerReserved: 3,
  ledgerAvailable: 0,
  targetOnHand: 3,
  projectionMismatch: false,
  allocatableQuantity: 0,
  ...overrides,
});

const commitment = (overrides: Partial<SupplierCommitment>): SupplierCommitment => ({
  kind: 'RESERVATION',
  id: '10000000-0000-4000-8000-000000000001',
  commitmentKey: '10000000-0000-4000-8000-000000000002',
  productId: '10000000-0000-4000-8000-000000000003',
  sku: 'NAM-01',
  productName: 'Đồ nam',
  storeId: '10000000-0000-4000-8000-000000000004',
  storeCode: 'CH01',
  storeName: 'Cửa hàng 1',
  orderSessionId: null,
  orderSessionCode: null,
  businessDate: null,
  allocationRunId: null,
  allocationLineId: null,
  priorityLevel: 'P1',
  decisionStatus: 'accepted',
  outboundRequestNumber: null,
  outboundStatus: null,
  quantity: 3,
  orderedQuantity: 1,
  cancelledQuantity: 0,
  unorderedQuantity: 2,
  orderState: 'PARTIALLY_ORDERED',
  orderable: true,
  notOrderableReason: null,
  heldSince: '2026-10-12T01:00:00.000Z',
  deadlineAt: null,
  htkdNames: [],
  ...overrides,
});

describe('supplier reconciliation UI model', () => {
  it('gives each role only its tabs and falls back safely on deep links', () => {
    expect(supplierTabsFor('ADMIN')).toEqual(['reconcile', 'orders', 'history', 'settings']);
    expect(supplierTabsFor('HTKD')).toEqual(['orders']);
    expect(supplierTabsFor('STORE')).toEqual(['status']);
    expect(readSupplierTab('settings', 'HTKD')).toBe('orders');
    expect(readSupplierTab('history', 'ADMIN')).toBe('history');
    expect(readSupplierTab(null, 'WHOLESALE')).toBe('status');
  });

  it('explains the AC01 situation without calling F the stock at Reshare', () => {
    expect(positionSentence(position({}))).toBe(
      'Reshare còn đặt được 3 bao, IDOSI đã giữ/cấp nhưng chưa đặt 3 bao → còn phân bổ được 0 bao.',
    );
    expect(
      positionSentence(
        position({
          effectiveSupplierQuantity: 1,
          freeQuantity: 0,
          shortfallQuantity: 2,
          state: 'SHORTFALL',
        }),
      ),
    ).toContain('thiếu nguồn 2 bao');
    expect(positionSentence(position({ state: 'NO_BASELINE' }))).toContain('chưa cấp mới');
    expect(freeChangeSentence('NAM-01', 0, 0)).toBe('NAM-01: khả dụng giữ nguyên 0 bao.');
    expect(freeChangeSentence('NAM-01', 0, 4)).toBe('NAM-01: khả dụng 0 → 4 bao (+4).');
  });

  it('converts business time (UTC+7) both ways', () => {
    expect(toBusinessLocalInput(new Date('2026-10-13T01:05:09.000Z'))).toBe('2026-10-13T08:05:09');
    expect(fromBusinessLocalInput('2026-10-13T08:05')).toBe('2026-10-13T01:05:00.000Z');
    expect(fromBusinessLocalInput('2026-10-13T08:05:09')).toBe('2026-10-13T01:05:09.000Z');
    expect(fromBusinessLocalInput('13/10/2026')).toBeNull();
  });

  it('accepts whole bags only, zero included', () => {
    expect(parseBags('0')).toBe(0);
    expect(parseBags(' 12 ')).toBe(12);
    for (const value of ['', '-1', '1.5', '1e3', 'abc']) expect(parseBags(value)).toBeNull();
    expect(parseBags('5', 4)).toBeNull();
  });

  it('builds one B order per store within what is still not ordered', () => {
    const a = commitment({});
    const b = commitment({
      id: '10000000-0000-4000-8000-000000000009',
      storeId: '10000000-0000-4000-8000-000000000008',
      storeCode: 'CH02',
    });
    expect(buildOrderLines([a, b], new Map([[a.id, '2']]), new Map())).toEqual({
      lines: [{ reservationId: a.id, quantity: 2, externalLineRef: 'NAM-01' }],
      error: null,
    });
    expect(buildOrderLines([a], new Map([[a.id, '3']]), new Map()).error).toContain('từ 1 đến 2');
    expect(
      buildOrderLines(
        [a, b],
        new Map([
          [a.id, '1'],
          [b.id, '1'],
        ]),
        new Map(),
      ).error,
    ).toBe('Một đơn Reshare chỉ ghi cho một cửa hàng.');
    expect(buildOrderLines([a], new Map(), new Map()).error).toBe('Chọn ít nhất một dòng chờ đặt.');
  });

  it('sums a page separately from the server totals', () => {
    expect(
      pageTotals([
        commitment({}),
        commitment({ quantity: 2, orderedQuantity: 0, unorderedQuantity: 2 }),
      ]),
    ).toEqual({
      quantity: 5,
      orderedQuantity: 1,
      unorderedQuantity: 4,
    });
  });
});

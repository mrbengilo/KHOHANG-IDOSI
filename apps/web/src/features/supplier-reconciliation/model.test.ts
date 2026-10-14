import type { SupplierCommitment, SupplierPosition } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildOrderLines,
  freeChangeSentence,
  isReshareManager,
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
    // Every role starts on its RE orders; Admin and HTKD (Reshare managers) get every tab.
    expect(supplierTabsFor('ADMIN')).toEqual(['orders', 'reconcile', 'history', 'settings']);
    expect(supplierTabsFor('HTKD')).toEqual(['orders', 'reconcile', 'history', 'settings']);
    expect(supplierTabsFor('STORE')).toEqual(['orders']);
    expect(supplierTabsFor('WHOLESALE')).toEqual(['orders']);
    expect(readSupplierTab('settings', 'HTKD')).toBe('settings');
    expect(readSupplierTab('reconcile', 'HTKD')).toBe('reconcile');
    expect(readSupplierTab('settings', 'STORE')).toBe('orders');
    expect(readSupplierTab('reconcile', 'WHOLESALE')).toBe('orders');
    expect(isReshareManager('HTKD')).toBe(true);
    expect(isReshareManager('WHOLESALE')).toBe(false);
    expect(readSupplierTab('history', 'ADMIN')).toBe('history');
    expect(readSupplierTab(null, 'WHOLESALE')).toBe('orders');
    // The old "status" deep link opens the order history; manual records stay reachable.
    expect(readSupplierTab('status', 'STORE')).toBe('orders');
    expect(readSupplierTab('legacy', 'HTKD')).toBe('legacy');
    expect(readSupplierTab('legacy', 'STORE')).toBe('orders');
  });

  it('counts RE orders not yet deducted by Reshare in the explanation', () => {
    expect(
      positionSentence(
        position({
          unorderedReservedQuantity: 0,
          issuedUnreflectedQuantity: 4,
          unorderedCommitmentQuantity: 4,
          effectiveSupplierQuantity: 10,
          freeQuantity: 6,
        }),
      ),
    ).toBe(
      'Reshare còn đặt được 10 bao, IDOSI đã giữ/cấp hoặc đã lập đơn RE nhưng số tồn chưa trừ 4 bao (gồm 4 bao đơn RE) → còn phân bổ được 6 bao.',
    );
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
    // Notices name the product only, never its SKU.
    expect(freeChangeSentence('Đồ nam', 0, 0)).toBe('Đồ nam: khả dụng giữ nguyên 0 bao.');
    expect(freeChangeSentence('Đồ nam', 0, 4)).toBe('Đồ nam: khả dụng 0 → 4 bao (+4).');
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
    const tooMany = buildOrderLines([a], new Map([[a.id, '3']]), new Map()).error;
    expect(tooMany).toBe('Đồ nam (Cửa hàng 1): nhập từ 1 đến 2 bao Reshare đã nhận.');
    expect(tooMany).not.toContain('NAM-01');
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

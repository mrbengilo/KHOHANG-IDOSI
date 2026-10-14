import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  allowedAllocationDecisionActions,
  computeSupplierPosition,
  DomainError,
  formatReshareOrderCode,
  planReshareOrder,
  RESHARE_ORDER_CODE_PATTERN,
  reshareOrderDisplayStatus,
  settleReceiptLine,
} from '../src/index.js';

describe('RE order codes', () => {
  it('uses exactly six digits from RE-000001 to RE-999999 and never wraps', () => {
    expect(formatReshareOrderCode(1)).toBe('RE-000001');
    expect(formatReshareOrderCode(42)).toBe('RE-000042');
    expect(formatReshareOrderCode(999_999)).toBe('RE-999999');
    expect(() => formatReshareOrderCode(1_000_000)).toThrow(DomainError);
    expect(() => formatReshareOrderCode(0)).toThrow(DomainError);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999 }), (sequence) => {
        expect(formatReshareOrderCode(sequence)).toMatch(RESHARE_ORDER_CODE_PATTERN);
      }),
    );
  });
});

describe('planReshareOrder', () => {
  it('groups holds of one result into one line per product with the exact total', () => {
    const plan = planReshareOrder([
      { reservationId: 'r1', allocationLineId: 'l1', productId: 'pants', quantity: 2 },
      { reservationId: 'r2', allocationLineId: 'l2', productId: 'shirt', quantity: 3 },
      { reservationId: 'r3', allocationLineId: 'l3', productId: 'pants', quantity: 1 },
    ]);
    expect(plan.totalQuantity).toBe(6);
    expect(plan.lines.map((line) => [line.productId, line.quantity])).toEqual([
      ['pants', 3],
      ['shirt', 3],
    ]);
  });

  it('never issues one hold or one allocation line twice and refuses zero bags', () => {
    expect(() =>
      planReshareOrder([
        { reservationId: 'r1', allocationLineId: 'l1', productId: 'a', quantity: 1 },
        { reservationId: 'r1', allocationLineId: 'l2', productId: 'a', quantity: 1 },
      ]),
    ).toThrow(DomainError);
    expect(() =>
      planReshareOrder([
        { reservationId: 'r1', allocationLineId: 'l1', productId: 'a', quantity: 0 },
      ]),
    ).toThrow(DomainError);
  });

  it('conserves bags for any set of holds (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            product: fc.constantFrom('a', 'b', 'c'),
            q: fc.integer({ min: 1, max: 50 }),
          }),
          {
            maxLength: 20,
          },
        ),
        (rows) => {
          const plan = planReshareOrder(
            rows.map((row, index) => ({
              reservationId: `r${index}`,
              allocationLineId: `l${index}`,
              productId: row.product,
              quantity: row.q,
            })),
          );
          const total = rows.reduce((sum, row) => sum + row.q, 0);
          expect(plan.totalQuantity).toBe(total);
          expect(plan.lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(total);
          expect(new Set(plan.lines.map((line) => line.productId)).size).toBe(plan.lines.length);
        },
      ),
    );
  });
});

describe('order display status and answer rights', () => {
  it('shows ordered only for a committed RE order', () => {
    expect(reshareOrderDisplayStatus({ orderStatus: 'ORDERED' })).toBe('ORDERED');
    expect(reshareOrderDisplayStatus({ orderStatus: 'CANCELLED' })).toBe('CANCELLED');
    expect(reshareOrderDisplayStatus({ orderStatus: null })).toBe('NOT_ORDERED');
  });

  it('lets the receiving side and an assigned HTKD accept or move to waiting, Admin nothing', () => {
    expect(allowedAllocationDecisionActions('STORE', 'PENDING')).toEqual(['ACCEPT', 'WAITLIST']);
    expect(allowedAllocationDecisionActions('WHOLESALE', 'PENDING')).toEqual(['ACCEPT', 'WAITLIST']);
    expect(allowedAllocationDecisionActions('HTKD', 'PENDING')).toEqual(['ACCEPT', 'WAITLIST']);
    expect(allowedAllocationDecisionActions('STORE', 'WAITLISTED')).toEqual([]);
    expect(allowedAllocationDecisionActions('ADMIN', 'PENDING')).toEqual([]);
    expect(allowedAllocationDecisionActions('STORE', 'ACCEPTED')).toEqual([]);
  });
});

describe('settleReceiptLine', () => {
  it('settles legacy and issued holds separately in stored order', () => {
    const result = settleReceiptLine(
      [
        { id: 'legacy', quantity: 2, issued: false },
        { id: 'issued', quantity: 3, issued: true },
      ],
      4,
    );
    expect(result).toMatchObject({
      legacyQuantity: 2,
      legacyReceived: 2,
      issuedQuantity: 3,
      issuedReceived: 2,
    });
    expect(result.sources.find((row) => row.id === 'issued')).toMatchObject({ shortage: 1 });
  });

  it('never settles more than was sent and conserves sent = received + shortage (property)', () => {
    expect(() => settleReceiptLine([{ id: 'a', quantity: 1, issued: true }], 2)).toThrow(
      DomainError,
    );
    fc.assert(
      fc.property(
        fc.array(fc.record({ q: fc.integer({ min: 1, max: 20 }), issued: fc.boolean() }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.nat(),
        (rows, seed) => {
          const sent = rows.reduce((sum, row) => sum + row.q, 0);
          const received = seed % (sent + 1);
          const result = settleReceiptLine(
            rows.map((row, index) => ({ id: String(index), quantity: row.q, issued: row.issued })),
            received,
          );
          expect(result.legacyReceived + result.issuedReceived).toBe(received);
          expect(result.legacyQuantity + result.issuedQuantity).toBe(sent);
          for (const row of result.sources) expect(row.received + row.shortage).toBe(row.quantity);
        },
      ),
    );
  });
});

describe('supplier position with issued RE orders', () => {
  const base = {
    status: 'ACTIVE' as const,
    baselineQuantity: 10,
    events: [],
    offerHoldQuantity: 0,
    reservations: [],
  };

  it('keeps F when a hold becomes an issued order, until an observation reflects it', () => {
    const held = computeSupplierPosition({
      ...base,
      reservations: [{ quantity: 4, orderedQuantity: 0 }],
      ledgerOnHand: 10,
      ledgerReserved: 4,
    });
    const issued = computeSupplierPosition({
      ...base,
      issuedOrders: [{ quantity: 4, reflectedQuantity: 0 }],
      ledgerOnHand: 6,
      ledgerReserved: 0,
    });
    expect(held.freeQuantity).toBe(6);
    expect(issued).toMatchObject({
      freeQuantity: 6,
      issuedUnreflectedQuantity: 4,
      unorderedCommitmentQuantity: 4,
      projectionMismatch: false,
    });
    // Reshare now shows 6 and the observation declared the 4 reflected: F stays 6, not 2.
    const reflected = computeSupplierPosition({
      ...base,
      baselineQuantity: 6,
      issuedOrders: [{ quantity: 4, reflectedQuantity: 4 }],
      ledgerOnHand: 6,
      ledgerReserved: 0,
    });
    expect(reflected).toMatchObject({ freeQuantity: 6, issuedUnreflectedQuantity: 0 });
  });

  it('refuses a reflection beyond the issued quantity', () => {
    expect(() =>
      computeSupplierPosition({
        ...base,
        issuedOrders: [{ quantity: 2, reflectedQuantity: 3 }],
        ledgerOnHand: 0,
        ledgerReserved: 0,
      }),
    ).toThrow(DomainError);
  });
});

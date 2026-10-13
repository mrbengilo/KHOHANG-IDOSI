import { describe, expect, it } from 'vitest';

import {
  computeSupplierPosition,
  distributeSupplierCancellation,
  pendingSupplierDelta,
  planObservationCoverage,
  supplierOrderState,
  type SupplierPositionInput,
} from '../src/index.js';

function position(overrides: Partial<SupplierPositionInput>) {
  return computeSupplierPosition({
    status: 'ACTIVE',
    baselineQuantity: 0,
    events: [],
    offerHoldQuantity: 0,
    reservations: [],
    ledgerOnHand: 0,
    ledgerReserved: 0,
    ...overrides,
  });
}

describe('supplier reconciliation arithmetic', () => {
  it('T01 baseline B=3 with nothing committed frees 3', () => {
    const result = position({ baselineQuantity: 3 });
    expect(result).toMatchObject({
      effectiveSupplierQuantity: 3,
      unorderedCommitmentQuantity: 0,
      freeQuantity: 3,
      shortfallQuantity: 0,
      targetOnHand: 3,
      state: 'RECONCILED',
      allocatableQuantity: 3,
    });
  });

  it('T02/T03 three bags allocated and B still shows 3 the next day: nothing is free', () => {
    const allocated = position({
      baselineQuantity: 3,
      reservations: [{ quantity: 3, orderedQuantity: 0 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(allocated.freeQuantity).toBe(0);
    expect(allocated.unorderedCommitmentQuantity).toBe(3);
    expect(allocated.targetOnHand).toBe(3);
    expect(allocated.projectionMismatch).toBe(false);
    // Re-observing the very same 3 replaces the baseline instead of adding to it.
    const reobserved = position({
      baselineQuantity: 3,
      reservations: [{ quantity: 3, orderedQuantity: 0 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(reobserved.freeQuantity).toBe(0);
    expect(reobserved.targetOnHand).toBe(3);
  });

  it('T06 B=7 with U=3 frees 4, not 7', () => {
    const result = position({
      baselineQuantity: 7,
      reservations: [{ quantity: 3, orderedQuantity: 0 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(result.freeQuantity).toBe(4);
    expect(result.targetOnHand).toBe(7);
  });

  it('T07/T08 orders recorded after the snapshot keep F at 0 and never free reserved stock', () => {
    const orderedOne = position({
      baselineQuantity: 3,
      events: [{ kind: 'ORDER', quantity: 1, coverage: 'OPEN' }],
      reservations: [{ quantity: 3, orderedQuantity: 1 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(orderedOne).toMatchObject({
      effectiveSupplierQuantity: 2,
      unorderedCommitmentQuantity: 2,
      orderedReservedQuantity: 1,
      freeQuantity: 0,
      targetOnHand: 3,
    });
    const orderedAll = position({
      baselineQuantity: 3,
      events: [
        { kind: 'ORDER', quantity: 1, coverage: 'OPEN' },
        { kind: 'ORDER', quantity: 2, coverage: 'OPEN' },
      ],
      reservations: [{ quantity: 3, orderedQuantity: 3 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(orderedAll).toMatchObject({
      effectiveSupplierQuantity: 0,
      unorderedCommitmentQuantity: 0,
      freeQuantity: 0,
    });
  });

  it('T09 a new snapshot B=0 that already reflects the orders does not subtract them again', () => {
    const result = position({
      baselineQuantity: 0,
      events: [
        { kind: 'ORDER', quantity: 1, coverage: 'COVERED' },
        { kind: 'ORDER', quantity: 2, coverage: 'COVERED' },
      ],
      reservations: [{ quantity: 3, orderedQuantity: 3 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(result.effectiveSupplierQuantity).toBe(0);
    expect(result.shortfallQuantity).toBe(0);
    expect(result.freeQuantity).toBe(0);
  });

  it('T20 B=1 with U=3 shows a shortfall of 2 and blocks new allocation', () => {
    const result = position({
      baselineQuantity: 1,
      reservations: [{ quantity: 3, orderedQuantity: 0 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(result).toMatchObject({
      freeQuantity: 0,
      shortfallQuantity: 2,
      state: 'SHORTFALL',
      allocatableQuantity: 0,
      targetOnHand: 3,
    });
  });

  it('T11 an offer hold and allocations are one commitment pool', () => {
    const result = position({
      baselineQuantity: 3,
      offerHoldQuantity: 1,
      reservations: [{ quantity: 2, orderedQuantity: 0 }],
      ledgerOnHand: 3,
      ledgerReserved: 3,
    });
    expect(result.unorderedCommitmentQuantity).toBe(3);
    expect(result.freeQuantity).toBe(0);
  });

  it('T39 shortage-check holds stay in R but never in U', () => {
    // R = 3 reserved (1 unordered allocation + 2 shortage-check units B already deducted).
    const result = position({
      baselineQuantity: 2,
      reservations: [{ quantity: 1, orderedQuantity: 0 }],
      ledgerOnHand: 4,
      ledgerReserved: 3,
    });
    expect(result.unorderedCommitmentQuantity).toBe(1);
    expect(result.freeQuantity).toBe(1);
    expect(result.targetOnHand).toBe(4);
    expect(result.projectionMismatch).toBe(false);
  });

  it('T18/T19 a cancellation alone does not free stock; a confirmed return adds it once', () => {
    expect(
      pendingSupplierDelta([
        { kind: 'ORDER', quantity: 2, coverage: 'OPEN' },
        { kind: 'ORDER_CANCEL', quantity: 2, coverage: 'NOT_APPLICABLE' },
      ]),
    ).toBe(-2);
    expect(
      pendingSupplierDelta([
        { kind: 'ORDER', quantity: 2, coverage: 'OPEN' },
        { kind: 'SOURCE_RETURN', quantity: 2, coverage: 'OPEN' },
      ]),
    ).toBe(0);
    // Once covered by a later observation the return is part of S and not added again.
    expect(
      pendingSupplierDelta([{ kind: 'SOURCE_RETURN', quantity: 2, coverage: 'COVERED' }]),
    ).toBe(0);
  });

  it('ambiguous events resolve conservatively and block allocation', () => {
    expect(
      pendingSupplierDelta([
        { kind: 'ORDER', quantity: 2, coverage: 'AMBIGUOUS' },
        { kind: 'SOURCE_RETURN', quantity: 5, coverage: 'AMBIGUOUS' },
      ]),
    ).toBe(-2);
    const result = position({
      baselineQuantity: 5,
      events: [{ kind: 'ORDER', quantity: 2, coverage: 'AMBIGUOUS' }],
    });
    expect(result.state).toBe('NEEDS_RECONCILIATION');
    expect(result.allocatableQuantity).toBe(0);
    expect(result.freeQuantity).toBe(3);
  });

  it('T29 without a baseline nothing is free and no projection is proposed', () => {
    const result = position({
      status: 'PENDING_BASELINE',
      baselineQuantity: null,
      reservations: [{ quantity: 2, orderedQuantity: 0 }],
      ledgerOnHand: 9,
      ledgerReserved: 2,
    });
    expect(result).toMatchObject({
      state: 'NO_BASELINE',
      freeQuantity: 0,
      allocatableQuantity: 0,
      targetOnHand: null,
    });
  });

  it('rejects impossible facts instead of guessing', () => {
    expect(() =>
      position({ reservations: [{ quantity: 1, orderedQuantity: 2 }], ledgerOnHand: 1 }),
    ).toThrow(/beyond its quantity/u);
    expect(() => position({ ledgerOnHand: 1, ledgerReserved: 2 })).toThrow(/Reserved/u);
    expect(() => position({ baselineQuantity: -1 })).toThrow();
  });
});

describe('observation coverage planning', () => {
  const observedAt = new Date('2026-10-13T02:00:00.000Z');
  const before = new Date('2026-10-13T01:00:00.000Z');
  const after = new Date('2026-10-13T03:00:00.000Z');

  it('T24 requires an explicit declaration for every event dated at or before the observation', () => {
    const plan = planObservationCoverage(
      [
        { id: 'a', kind: 'ORDER', coverage: 'OPEN', occurredAt: before },
        { id: 'b', kind: 'ORDER', coverage: 'AMBIGUOUS', occurredAt: before },
        { id: 'c', kind: 'ORDER', coverage: 'OPEN', occurredAt: after },
        { id: 'd', kind: 'ORDER', coverage: 'COVERED', occurredAt: before },
        { id: 'e', kind: 'ORDER_CANCEL', coverage: 'NOT_APPLICABLE', occurredAt: before },
      ],
      observedAt,
      new Map([['a', true]]),
    );
    expect(plan).toEqual({ covered: ['a'], open: [], undecided: ['b'], invalid: [] });
  });

  it('refuses to cover a later event or an unknown id', () => {
    const plan = planObservationCoverage(
      [{ id: 'c', kind: 'ORDER', coverage: 'OPEN', occurredAt: after }],
      observedAt,
      new Map([
        ['c', true],
        ['ghost', false],
      ]),
    );
    expect(plan.invalid).toEqual(['c', 'ghost']);
  });

  it('keeps a declared-not-reflected event in DeltaB', () => {
    const plan = planObservationCoverage(
      [{ id: 'a', kind: 'ORDER', coverage: 'AMBIGUOUS', occurredAt: before }],
      observedAt,
      new Map([['a', false]]),
    );
    expect(plan.open).toEqual(['a']);
  });
});

describe('supplier order state and cancellation split', () => {
  it('reports the B state of a commitment independently of A decisions', () => {
    const base = { baselineKnown: true, active: true, quantity: 3, cancelledQuantity: 0 };
    expect(supplierOrderState({ ...base, orderedQuantity: 0 })).toBe('NOT_ORDERED');
    expect(supplierOrderState({ ...base, orderedQuantity: 1 })).toBe('PARTIALLY_ORDERED');
    expect(supplierOrderState({ ...base, orderedQuantity: 3 })).toBe('ORDERED');
    expect(supplierOrderState({ ...base, orderedQuantity: 0, cancelledQuantity: 1 })).toBe(
      'CANCELLED_CONFIRMED',
    );
    expect(supplierOrderState({ ...base, baselineKnown: false, orderedQuantity: 0 })).toBe(
      'UNKNOWN',
    );
    expect(supplierOrderState({ ...base, active: false, orderedQuantity: 2 })).toBe(
      'CANCEL_PENDING',
    );
  });

  it('splits a cancellation newest link first and never beyond what is ordered', () => {
    expect(
      distributeSupplierCancellation(
        [
          { key: 'old', netQuantity: 2 },
          { key: 'new', netQuantity: 1 },
        ],
        2,
      ),
    ).toEqual([
      { key: 'new', quantity: 1 },
      { key: 'old', quantity: 1 },
    ]);
    expect(() => distributeSupplierCancellation([{ key: 'a', netQuantity: 1 }], 2)).toThrow();
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  planStoreWaitReconciliation,
  storeWaitDocumentLabel,
  type StoreWaitClosingLine,
  type StoreWaitLiveLine,
  type StoreWaitOpeningLine,
  type StoreWaitReconciliationPlan,
} from '../src/index.js';

const NAM = 'product-nam';
const NU = 'product-nu';
const TRE = 'product-tre';

const live = (productId: string, remainingQuantity: number, pendingQuantity = 0) => ({
  productId,
  remainingQuantity,
  pendingQuantity,
});
const open = (productId: string, openQuantity: number) => ({ productId, openQuantity });

function byProduct<T extends { readonly productId: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.productId, row]));
}

function openingOf(plan: StoreWaitReconciliationPlan): readonly StoreWaitOpeningLine[] {
  return plan.kind === 'OPEN' || plan.kind === 'ROLLOVER' ? plan.opening : [];
}

function closingOf(plan: StoreWaitReconciliationPlan): readonly StoreWaitClosingLine[] {
  return plan.kind === 'CLOSE' || plan.kind === 'ROLLOVER' ? plan.closing : [];
}

describe('store wait document reconciliation', () => {
  it('opens the first document with everything added', () => {
    const plan = planStoreWaitReconciliation({
      current: null,
      live: [live(NAM, 2), live(NU, 2)],
      declared: [],
      undeclaredCategory: 'adjusted',
    });
    expect(plan).toEqual({
      kind: 'OPEN',
      opening: [
        {
          productId: NAM,
          carriedInQuantity: 0,
          addedQuantity: 2,
          remainingQuantity: 2,
          pendingQuantity: 0,
        },
        {
          productId: NU,
          carriedInQuantity: 0,
          addedQuantity: 2,
          remainingQuantity: 2,
          pendingQuantity: 0,
        },
      ],
    });
  });

  it('A: B (2 nam + 2 nữ) and new 1 nam + 3 trẻ em merge into C (3 + 2 + 3)', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 2), open(NU, 2)],
      live: [live(NAM, 3), live(NU, 2), live(TRE, 3)],
      declared: [],
      undeclaredCategory: 'adjusted',
    });
    expect(plan.kind).toBe('ROLLOVER');
    if (plan.kind !== 'ROLLOVER') return;
    expect(plan.closure).toBe('merged');
    const closing = byProduct(plan.closing);
    expect(closing.get(NAM)).toMatchObject({ openQuantity: 2, carriedOutQuantity: 2 });
    expect(closing.get(NU)).toMatchObject({ openQuantity: 2, carriedOutQuantity: 2 });
    const opening = byProduct(plan.opening);
    expect(opening.get(NAM)).toMatchObject({ carriedInQuantity: 2, addedQuantity: 1 });
    expect(opening.get(NU)).toMatchObject({ carriedInQuantity: 2, addedQuantity: 0 });
    expect(opening.get(TRE)).toMatchObject({ carriedInQuantity: 0, addedQuantity: 3 });
  });

  it('a replay or a refresh changes nothing', () => {
    expect(
      planStoreWaitReconciliation({
        current: [open(NAM, 3), open(NU, 2)],
        live: [live(NAM, 3), live(NU, 2)],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toEqual({ kind: 'NOOP' });
    expect(
      planStoreWaitReconciliation({
        current: null,
        live: [],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toEqual({ kind: 'NOOP' });
  });

  it('C: granting 1 nam that still waits for the answer keeps the same document', () => {
    // 2 nam + 2 nữ waiting; the run grants 1 nam (PENDING): still waiting 1 nam + 2 nữ,
    // 1 nam awaiting confirmation, nothing confirmed. Open demand is unchanged.
    expect(
      planStoreWaitReconciliation({
        current: [open(NAM, 2), open(NU, 2)],
        live: [live(NAM, 1, 1), live(NU, 2)],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toEqual({ kind: 'NOOP' });
  });

  it('B: confirming 1 nam + 2 nữ from C rolls the rest (2 nam + 3 trẻ em) over to D', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 3), open(NU, 2), open(TRE, 3)],
      live: [live(NAM, 2), live(TRE, 3)],
      declared: [
        { productId: NAM, category: 'confirmed', quantity: 1 },
        { productId: NU, category: 'confirmed', quantity: 2 },
      ],
      undeclaredCategory: 'adjusted',
    });
    expect(plan.kind).toBe('ROLLOVER');
    if (plan.kind !== 'ROLLOVER') return;
    expect(plan.closure).toBe('rolled_over');
    const closing = byProduct(plan.closing);
    expect(closing.get(NAM)).toMatchObject({ confirmedQuantity: 1, carriedOutQuantity: 2 });
    expect(closing.get(NU)).toMatchObject({ confirmedQuantity: 2, carriedOutQuantity: 0 });
    expect(closing.get(TRE)).toMatchObject({ confirmedQuantity: 0, carriedOutQuantity: 3 });
    // Nữ is no longer waiting: D has no line for it, C keeps it in its history.
    expect(plan.opening.map((line) => line.productId)).toEqual([NAM, TRE]);
    expect(plan.undeclared).toEqual([]);
  });

  it('confirming everything closes the document without an empty successor', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 2), open(TRE, 3)],
      live: [],
      declared: [
        { productId: NAM, category: 'confirmed', quantity: 2 },
        { productId: TRE, category: 'confirmed', quantity: 3 },
      ],
      undeclaredCategory: 'adjusted',
    });
    expect(plan).toMatchObject({ kind: 'CLOSE', closure: 'completed' });
  });

  it('a document whose whole open demand awaits the answer stays open', () => {
    expect(
      planStoreWaitReconciliation({
        current: [open(NAM, 1)],
        live: [live(NAM, 0, 1)],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toEqual({ kind: 'NOOP' });
  });

  it('cancelling every line closes the document as cancelled', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 2)],
      live: [],
      declared: [{ productId: NAM, category: 'cancelled', quantity: 2 }],
      undeclaredCategory: 'cancelled',
    });
    expect(plan).toMatchObject({ kind: 'CLOSE', closure: 'cancelled' });
  });

  it('a cancellation and new demand of the same product in one event are both recorded', () => {
    // A full offer lapses (2 nam cancelled) while the run queues 2 nam of a new order.
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 2)],
      live: [live(NAM, 2)],
      declared: [{ productId: NAM, category: 'cancelled', quantity: 2 }],
      undeclaredCategory: 'cancelled',
    });
    expect(plan.kind).toBe('ROLLOVER');
    if (plan.kind !== 'ROLLOVER') return;
    expect(plan.closure).toBe('merged');
    expect(plan.closing[0]).toMatchObject({ cancelledQuantity: 2, carriedOutQuantity: 0 });
    expect(plan.opening[0]).toMatchObject({ carriedInQuantity: 0, addedQuantity: 2 });
  });

  it('D: 10/6/4 — accepting the 6 ordinary bags leaves the 4 waiting untouched', () => {
    // The 6 granted bags came from the order, not from a wait ticket: nothing to confirm here.
    expect(
      planStoreWaitReconciliation({
        current: [open(NAM, 4)],
        live: [live(NAM, 4)],
        declared: [],
        undeclaredCategory: 'confirmed',
      }),
    ).toEqual({ kind: 'NOOP' });
    // Moving the 6 back to waiting: 4 carried, 6 added (10, never 14 or 16).
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 4)],
      live: [live(NAM, 10)],
      declared: [],
      undeclaredCategory: 'cancelled',
    });
    expect(plan.kind).toBe('ROLLOVER');
    if (plan.kind !== 'ROLLOVER') return;
    expect(plan.opening[0]).toMatchObject({ carriedInQuantity: 4, addedQuantity: 6 });
  });

  it('an undeclared drop is attributed to the event category and reported', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 3)],
      live: [live(NAM, 1)],
      declared: [],
      undeclaredCategory: 'adjusted',
    });
    expect(plan.kind).toBe('ROLLOVER');
    if (plan.kind !== 'ROLLOVER') return;
    expect(plan.closing[0]).toMatchObject({ adjustedQuantity: 2, carriedOutQuantity: 1 });
    expect(plan.undeclared).toEqual([{ productId: NAM, category: 'adjusted', quantity: 2 }]);
  });

  it('a declaration beyond the open quantity is clamped and reported, never negative', () => {
    const plan = planStoreWaitReconciliation({
      current: [open(NAM, 1)],
      live: [],
      declared: [
        { productId: NAM, category: 'cancelled', quantity: 3 },
        { productId: TRE, category: 'cancelled', quantity: 1 },
      ],
      undeclaredCategory: 'cancelled',
    });
    expect(plan.kind).toBe('CLOSE');
    if (plan.kind !== 'CLOSE') return;
    expect(plan.closing[0]).toMatchObject({ cancelledQuantity: 1, carriedOutQuantity: 0 });
    expect(plan.overDeclared).toEqual([
      { productId: NAM, category: 'cancelled', quantity: 2 },
      { productId: TRE, category: 'cancelled', quantity: 1 },
    ]);
  });

  it('labels name the successor document', () => {
    expect(storeWaitDocumentLabel('merged', 'PCT-000003')).toBe(
      'Đã xử lý · Gộp vào phiếu PCT-000003',
    );
    expect(storeWaitDocumentLabel('rolled_over', 'PCT-000004')).toBe(
      'Đã xử lý · Chuyển phần còn lại sang phiếu PCT-000004',
    );
    expect(storeWaitDocumentLabel('completed', null)).toBe('Đã xử lý xong');
    expect(storeWaitDocumentLabel('cancelled', null)).toBe('Đã hủy');
  });

  it('rejects malformed input', () => {
    expect(() =>
      planStoreWaitReconciliation({
        current: [open(NAM, 0)],
        live: [],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toThrow(RangeError);
    expect(() =>
      planStoreWaitReconciliation({
        current: null,
        live: [live(NAM, -1)],
        declared: [],
        undeclaredCategory: 'adjusted',
      }),
    ).toThrow(RangeError);
  });
});

describe('store wait document reconciliation properties', () => {
  const products = ['p1', 'p2', 'p3', 'p4'];
  const liveArbitrary = fc
    .subarray(products)
    .chain((selected) =>
      fc.tuple(
        ...selected.map((productId) =>
          fc.record({
            productId: fc.constant(productId),
            remainingQuantity: fc.integer({ min: 0, max: 20 }),
            pendingQuantity: fc.integer({ min: 0, max: 20 }),
          }),
        ),
      ),
    )
    .map((rows) => rows as StoreWaitLiveLine[]);

  it('conserves every bag, never goes negative and has at most one successor line per product', () => {
    fc.assert(
      fc.property(
        liveArbitrary,
        liveArbitrary,
        fc.array(
          fc.record({
            productId: fc.constantFrom(...products),
            category: fc.constantFrom(
              'confirmed' as const,
              'cancelled' as const,
              'adjusted' as const,
            ),
            quantity: fc.integer({ min: 0, max: 25 }),
          }),
          { maxLength: 6 },
        ),
        fc.constantFrom('confirmed' as const, 'cancelled' as const, 'adjusted' as const),
        (before, after, declared, undeclaredCategory) => {
          const current = before
            .filter((line) => line.remainingQuantity + line.pendingQuantity > 0)
            .map((line) => open(line.productId, line.remainingQuantity + line.pendingQuantity));
          const plan = planStoreWaitReconciliation({
            current: current.length > 0 ? current : null,
            live: after,
            declared,
            undeclaredCategory,
          });
          const closing = closingOf(plan);
          const opening = openingOf(plan);
          for (const line of closing) {
            expect(
              line.confirmedQuantity +
                line.cancelledQuantity +
                line.adjustedQuantity +
                line.carriedOutQuantity,
            ).toBe(line.openQuantity);
            for (const value of Object.values(line)) {
              if (typeof value === 'number') expect(value).toBeGreaterThanOrEqual(0);
            }
          }
          const liveTotals = byProduct(after);
          for (const line of opening) {
            expect(line.carriedInQuantity + line.addedQuantity).toBe(
              line.remainingQuantity + line.pendingQuantity,
            );
            expect(line.carriedInQuantity).toBeGreaterThanOrEqual(0);
            expect(line.addedQuantity).toBeGreaterThanOrEqual(0);
            const source = liveTotals.get(line.productId)!;
            expect(line.remainingQuantity).toBe(source.remainingQuantity);
            expect(line.pendingQuantity).toBe(source.pendingQuantity);
          }
          expect(new Set(opening.map((line) => line.productId)).size).toBe(opening.length);
          // What leaves the closed document is exactly what the successor carries in.
          const carriedOut = byProduct(closing);
          for (const line of opening) {
            expect(line.carriedInQuantity).toBe(
              carriedOut.get(line.productId)?.carriedOutQuantity ?? 0,
            );
          }
          for (const line of closing) {
            if (line.carriedOutQuantity > 0) {
              expect(byProduct(opening).get(line.productId)?.carriedInQuantity).toBe(
                line.carriedOutQuantity,
              );
            }
          }
          // Replaying the same state after the plan is applied changes nothing.
          if (opening.length > 0) {
            const replay = planStoreWaitReconciliation({
              current: opening.map((line) =>
                open(line.productId, line.carriedInQuantity + line.addedQuantity),
              ),
              live: after,
              declared: [],
              undeclaredCategory,
            });
            expect(replay).toEqual({ kind: 'NOOP' });
          }
        },
      ),
    );
  });
});

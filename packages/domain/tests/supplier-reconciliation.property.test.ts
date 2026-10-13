import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  computeSupplierPosition,
  type SupplierEventFact,
  type SupplierPosition,
} from '../src/index.js';

/**
 * A model world: `truth` is what B really shows as orderable. A only learns it through
 * observations and through the events HTKD records. The test drives random lifecycles and
 * checks A's projection against the truth with independently computed expectations.
 */
const steps = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant('allocate' as const), quantity: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('release' as const), quantity: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('order' as const), quantity: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ kind: fc.constant('deliver' as const), quantity: fc.integer({ min: 1, max: 4 }) }),
    fc.record({
      kind: fc.constant('cancelAtB' as const),
      quantity: fc.integer({ min: 1, max: 4 }),
      returned: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant('externalSale' as const),
      quantity: fc.integer({ min: 1, max: 3 }),
    }),
    fc.constant({ kind: 'observe' as const }),
  ),
  { minLength: 1, maxLength: 40 },
);

interface World {
  truth: number;
  baseline: number;
  events: { kind: SupplierEventFact['kind']; quantity: number; covered: boolean }[];
  unordered: number;
  ordered: number;
  onHand: number;
  reserved: number;
  externalSinceObservation: boolean;
  externalEver: boolean;
}

function evaluate(world: World): SupplierPosition {
  const reservations =
    world.unordered + world.ordered > 0
      ? [{ quantity: world.unordered + world.ordered, orderedQuantity: world.ordered }]
      : [];
  return computeSupplierPosition({
    status: 'ACTIVE',
    baselineQuantity: world.baseline,
    events: world.events
      .filter((event) => !event.covered)
      .map((event) => ({
        kind: event.kind,
        quantity: event.quantity,
        coverage: event.kind === 'ORDER_CANCEL' ? 'NOT_APPLICABLE' : 'OPEN',
      })),
    offerHoldQuantity: 0,
    reservations,
    ledgerOnHand: world.onHand,
    ledgerReserved: world.reserved,
  });
}

/** What the reconciliation commands do: hold onHand at R + F. */
function project(world: World): void {
  const position = evaluate(world);
  world.onHand = position.targetOnHand ?? world.onHand;
}

describe('supplier reconciliation lifecycle properties', () => {
  it('never allocates beyond B and re-observation never double counts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), steps, (initial, plan) => {
        const world: World = {
          truth: initial,
          baseline: initial,
          events: [],
          unordered: 0,
          ordered: 0,
          onHand: 0,
          reserved: 0,
          externalSinceObservation: false,
          externalEver: false,
        };
        project(world);
        for (const step of plan) {
          switch (step.kind) {
            case 'allocate': {
              const position = evaluate(world);
              const quantity = Math.min(step.quantity, position.allocatableQuantity);
              if (quantity === 0) break;
              // Allocation holds R; on-hand does not move.
              world.unordered += quantity;
              world.reserved += quantity;
              break;
            }
            case 'release': {
              const quantity = Math.min(step.quantity, world.unordered);
              if (quantity === 0) break;
              world.unordered -= quantity;
              world.reserved -= quantity;
              break;
            }
            case 'order': {
              // HTKD orders at B only what B can still accept.
              const quantity = Math.min(step.quantity, world.unordered, world.truth);
              if (quantity === 0) break;
              world.truth -= quantity;
              world.unordered -= quantity;
              world.ordered += quantity;
              world.events.push({ kind: 'ORDER', quantity, covered: false });
              project(world);
              break;
            }
            case 'deliver': {
              const quantity = Math.min(step.quantity, world.ordered);
              if (quantity === 0) break;
              world.ordered -= quantity;
              world.onHand -= quantity;
              world.reserved -= quantity;
              break;
            }
            case 'cancelAtB': {
              const quantity = Math.min(step.quantity, world.ordered);
              if (quantity === 0) break;
              world.ordered -= quantity;
              world.unordered += quantity;
              world.events.push({ kind: 'ORDER_CANCEL', quantity, covered: false });
              // B keeping the cancelled stock unorderable is a real shortfall, reported as D.
              if (!step.returned) world.externalEver = true;
              if (step.returned) {
                world.truth += quantity;
                world.events.push({ kind: 'SOURCE_RETURN', quantity, covered: false });
              }
              project(world);
              break;
            }
            case 'externalSale': {
              const quantity = Math.min(step.quantity, world.truth);
              if (quantity === 0) break;
              world.truth -= quantity;
              world.externalSinceObservation = true;
              world.externalEver = true;
              break;
            }
            case 'observe': {
              world.baseline = world.truth;
              for (const event of world.events) event.covered = true;
              world.externalSinceObservation = false;
              project(world);
              const afterFirst = world.onHand;
              // Same observation again: nothing changes (T03/T04/T05).
              project(world);
              expect(world.onHand).toBe(afterFirst);
              break;
            }
          }

          const position = evaluate(world);
          // Ledger stays valid and, after every projected command, matches F.
          expect(world.reserved).toBeGreaterThanOrEqual(0);
          expect(world.onHand).toBeGreaterThanOrEqual(world.reserved);
          expect(position.effectiveSupplierQuantity).not.toBeNull();
          if (!world.externalSinceObservation) {
            // Without outside sales A tracks B exactly through recorded events.
            expect(position.effectiveSupplierQuantity).toBe(world.truth);
            expect(position.freeQuantity).toBe(Math.max(0, world.truth - world.unordered));
          }
          if (!world.externalEver) {
            // Commitments never exceed what B really holds: no double allocation. (An outside
            // sale A has not observed yet can still leave a shortfall D, which is reported.)
            expect(world.unordered).toBeLessThanOrEqual(world.truth);
          }
          if (step.kind === 'observe') {
            expect(position.freeQuantity).toBe(Math.max(0, world.truth - world.unordered));
            expect(position.shortfallQuantity).toBe(Math.max(0, world.unordered - world.truth));
            expect(world.onHand - world.reserved).toBe(position.freeQuantity);
          }
          // Free stock can only shrink between observations through outside sales, never grow.
          expect(position.freeQuantity).toBeLessThanOrEqual(
            Math.max(0, (position.effectiveSupplierQuantity ?? 0) - world.unordered),
          );
        }
      }),
      { numRuns: 400 },
    );
  });
});

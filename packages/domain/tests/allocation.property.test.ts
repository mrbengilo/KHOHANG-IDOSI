import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_POLICY_VERSION,
  allocateInventory,
  createInventorySnapshot,
  type AllocationDemand,
  type AllocationInput,
  type NewOrderPriority,
} from '../src/index.js';

const demandCases = fc.array(
  fc.record({
    quantity: fc.integer({ min: 1, max: 20 }),
    priority: fc.constantFrom<NewOrderPriority>('P0B', 'P1', 'P2', 'P3'),
  }),
  { minLength: 1, maxLength: 8 },
);

function demandsFromCases(
  cases: readonly Readonly<{ quantity: number; priority: NewOrderPriority }>[],
): readonly AllocationDemand[] {
  return cases.map((candidate, index) => ({
    demandId: `demand-${index}`,
    sessionId: 'session-property',
    storeId: `S${index}`,
    productId: 'product-property',
    requestedQuantity: candidate.quantity,
    priority: candidate.priority,
    source: 'ORDER_REQUEST',
    sourceIds: [`request-${index}`],
    sourceWaitTicketId: null,
  }));
}

function inputFor(
  demands: readonly AllocationDemand[],
  stock: number,
  startCursor: string | null,
): AllocationInput {
  return {
    allocationId: 'allocation-property',
    idempotencyKey: 'allocation-property-key',
    sessionId: 'session-property',
    policyVersion: ALLOCATION_POLICY_VERSION,
    allocatedAt: '2026-09-10T09:00:00.000Z',
    snapshot: createInventorySnapshot({
      id: 'snapshot-property',
      version: '1',
      productId: 'product-property',
      availableQuantity: stock,
      capturedAt: '2026-09-10T08:00:00.000Z',
    }),
    demands,
    storeOrder: demands.map((demand) => demand.storeId),
    startCursor,
  };
}

describe('allocation properties', () => {
  it('never allocates above snapshot or above any demand', () => {
    fc.assert(
      fc.property(demandCases, fc.integer({ min: 0, max: 100 }), (cases, stock) => {
        const demands = demandsFromCases(cases);
        const result = allocateInventory(inputFor(demands, stock, demands[0]?.storeId ?? null));
        const allocatedByDemand = new Map(
          result.allocations.map((allocation) => [allocation.demandId, allocation.quantity]),
        );

        expect(result.allocatedQuantity).toBeLessThanOrEqual(stock);
        expect(result.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(
          result.allocatedQuantity,
        );
        for (const demand of demands) {
          expect(allocatedByDemand.get(demand.demandId) ?? 0).toBeLessThanOrEqual(
            demand.requestedQuantity,
          );
        }
        for (const remainder of result.remainders) {
          expect(remainder.allocatedQuantity + remainder.remainingQuantity).toBe(
            remainder.requestedQuantity,
          );
        }
      }),
    );
  });

  it('is deterministic, retry-safe, and independent from demand permutation', () => {
    fc.assert(
      fc.property(demandCases, fc.integer({ min: 0, max: 100 }), (cases, stock) => {
        const demands = demandsFromCases(cases);
        const storeOrder = demands.map((demand) => demand.storeId);
        const firstInput = inputFor(demands, stock, storeOrder[0] ?? null);
        const reversedInput: AllocationInput = {
          ...firstInput,
          demands: [...demands].reverse(),
        };

        const first = allocateInventory(firstInput);
        expect(allocateInventory(firstInput)).toEqual(first);
        expect(allocateInventory(reversedInput)).toEqual(first);
        expect(firstInput.snapshot.availableQuantity).toBe(stock);
        expect(firstInput.demands).toEqual(demands);
      }),
    );
  });

  it('grants at most one unit to a store in each priority round', () => {
    fc.assert(
      fc.property(demandCases, fc.integer({ min: 0, max: 100 }), (cases, stock) => {
        const demands = demandsFromCases(cases);
        const result = allocateInventory(inputFor(demands, stock, demands[0]?.storeId ?? null));
        const roundStoreKeys = result.steps.map(
          (step) => `${step.priority}:${step.round}:${step.storeId}`,
        );

        expect(new Set(roundStoreKeys).size).toBe(roundStoreKeys.length);
      }),
    );
  });

  it('rotates stock=1 fairly across persistent cursors', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (storeCount) => {
        const demands = demandsFromCases(
          Array.from({ length: storeCount }, () => ({ quantity: 100, priority: 'P3' as const })),
        );
        const storeOrder = demands.map((demand) => demand.storeId);
        let cursor: string | null = storeOrder[0] ?? null;
        const served: string[] = [];

        for (let run = 0; run < storeCount * 3; run += 1) {
          const result = allocateInventory({
            ...inputFor(demands, 1, cursor),
            allocationId: `allocation-${run}`,
            idempotencyKey: `allocation-key-${run}`,
          });
          const servedStore = result.steps[0]?.storeId;
          expect(servedStore).toBe(storeOrder[run % storeCount]);
          if (servedStore !== undefined) {
            served.push(servedStore);
          }
          cursor = result.nextCursor;
        }

        const counts = storeOrder.map(
          (storeId) => served.filter((candidate) => candidate === storeId).length,
        );
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      }),
    );
  });
});

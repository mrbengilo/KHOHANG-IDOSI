import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_POLICY_VERSION,
  allocateInventory,
  buildAllocationDemands,
  createDailyPriorityOffer,
  createInventorySnapshot,
  createWaitTicket,
  confirmDailyPriorityOffer,
  type AllocationDemand,
  type AllocationInput,
  type AllocationPriority,
} from '../src/index.js';

const NOW = '2026-09-10T09:00:00.000Z';

function demand(
  storeId: string,
  requestedQuantity: number,
  priority: AllocationPriority = 'P3',
  suffix = '',
): AllocationDemand {
  const isConfirmedWait = priority === 'P0A';
  return {
    demandId: `demand-${storeId}${suffix}`,
    sessionId: 'session-1',
    storeId,
    productId: 'product-1',
    requestedQuantity,
    priority,
    source: isConfirmedWait ? 'CONFIRMED_WAIT' : 'ORDER_REQUEST',
    sourceIds: [`source-${storeId}${suffix}`],
    sourceWaitTicketId: isConfirmedWait ? `wait-${storeId}` : null,
  };
}

function allocationInput(
  demands: readonly AllocationDemand[],
  availableQuantity: number,
  startCursor: string | null,
  storeOrder: readonly string[],
): AllocationInput {
  return {
    allocationId: 'allocation-1',
    idempotencyKey: 'allocation-command-1',
    sessionId: 'session-1',
    policyVersion: ALLOCATION_POLICY_VERSION,
    allocatedAt: NOW,
    snapshot: createInventorySnapshot({
      id: 'snapshot-1',
      version: '17',
      productId: 'product-1',
      availableQuantity,
      capturedAt: '2026-09-10T08:00:00.000Z',
    }),
    demands,
    storeOrder,
    startCursor,
  };
}

function quantitiesByStore(
  allocations: ReturnType<typeof allocateInventory>['allocations'],
): Readonly<Record<string, number>> {
  const quantities: Record<string, number> = {};
  for (const allocation of allocations) {
    quantities[allocation.storeId] = (quantities[allocation.storeId] ?? 0) + allocation.quantity;
  }
  return quantities;
}

describe('allocateInventory', () => {
  it('allocates stock=3 as A1 B1 C1 and points the next run at D', () => {
    const demands = [
      demand('A', 2),
      demand('B', 3),
      demand('C', 1),
      demand('D', 2),
      demand('E', 4),
    ];

    const result = allocateInventory(allocationInput(demands, 3, 'A', ['A', 'B', 'C', 'D', 'E']));

    expect(quantitiesByStore(result.allocations)).toEqual({ A: 1, B: 1, C: 1 });
    expect(result.steps.map((step) => step.storeId)).toEqual(['A', 'B', 'C']);
    expect(result.nextCursor).toBe('D');
    expect(result.allocatedQuantity).toBe(3);
    expect(result.availableAfter).toBe(0);
  });

  it('persists rotation across runs through nextCursor', () => {
    const demands = [
      demand('A', 4),
      demand('B', 4),
      demand('C', 4),
      demand('D', 4),
      demand('E', 4),
    ];
    const stores = ['A', 'B', 'C', 'D', 'E'];
    const first = allocateInventory(allocationInput(demands, 3, 'A', stores));
    const second = allocateInventory({
      ...allocationInput(demands, 3, first.nextCursor, stores),
      allocationId: 'allocation-2',
      idempotencyKey: 'allocation-command-2',
    });

    expect(second.steps.map((step) => step.storeId)).toEqual(['D', 'E', 'A']);
    expect(second.nextCursor).toBe('B');
  });

  it('exhausts higher priorities before moving toward P3', () => {
    const result = allocateInventory(
      allocationInput([demand('A', 2, 'P0A'), demand('B', 5, 'P3')], 3, 'A', ['A', 'B']),
    );

    expect(result.steps.map(({ storeId, priority }) => `${priority}:${storeId}`)).toEqual([
      'P0A:A',
      'P0A:A',
      'P3:B',
    ]);
  });

  it('does not let duplicate candidates give a store two units in one round', () => {
    const result = allocateInventory(
      allocationInput(
        [demand('A', 2, 'P2', '-1'), demand('A', 2, 'P2', '-2'), demand('B', 3, 'P2')],
        6,
        'A',
        ['A', 'B'],
      ),
    );
    const keys = result.steps.map((step) => `${step.priority}:${step.round}:${step.storeId}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is independent from demand input order when storeOrder is explicit', () => {
    const demands = [demand('C', 1), demand('A', 2), demand('B', 3)];
    const forward = allocateInventory(allocationInput(demands, 5, 'B', ['A', 'B', 'C']));
    const reversed = allocateInventory(
      allocationInput([...demands].reverse(), 5, 'B', ['A', 'B', 'C']),
    );

    expect(reversed).toEqual(forward);
  });

  it('keeps the cursor when no allocation is made', () => {
    const result = allocateInventory(allocationInput([demand('A', 2)], 0, 'A', ['A', 'B']));

    expect(result.nextCursor).toBe('A');
    expect(result.steps).toEqual([]);
  });

  it('rejects a regular request trying to claim P0A', () => {
    const invalid = { ...demand('A', 1, 'P3'), priority: 'P0A' as const };

    expect(() => allocateInventory(allocationInput([invalid], 1, 'A', ['A']))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('buildAllocationDemands', () => {
  it('creates P0A demand only from a confirmed, still-open wait ticket offer', () => {
    const ticket = createWaitTicket([], {
      ticketId: 'wait-A',
      storeId: 'A',
      productId: 'product-1',
      quantity: 3,
      sourceType: 'ALLOCATION_REMAINDER',
      referenceId: 'old-allocation',
      idempotencyKey: 'old-remainder',
      requestedAt: '2026-09-01T09:00:00.000Z',
      recordedAt: '2026-09-01T09:00:01.000Z',
    });
    const pending = createDailyPriorityOffer(ticket, [], {
      id: 'offer-1',
      businessDate: '2026-09-10',
      offeredQuantity: 2,
      createdAt: '2026-09-10T08:00:00.000Z',
      expiresAt: '2026-09-10T09:00:00.000Z',
    });
    const confirmed = confirmDailyPriorityOffer(pending, ticket, {
      quantity: 2,
      confirmedAt: '2026-09-10T08:30:00.000Z',
      idempotencyKey: 'confirm-1',
    }).offer;

    const result = buildAllocationDemands({
      sessionId: 'session-1',
      mergedRequests: [],
      waitTickets: [ticket],
      priorityOffers: [pending, confirmed],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      priority: 'P0A',
      source: 'CONFIRMED_WAIT',
      sourceWaitTicketId: ticket.id,
      requestedQuantity: 2,
    });
  });
});

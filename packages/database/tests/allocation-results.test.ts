import { describe, expect, it, vi } from 'vitest';

import { allocationRoundsFromMetadata, listAllocationResults } from '../src/allocation-results.js';
import type { Database } from '../src/client.js';

const unreachableDatabase = {} as Database;

describe('allocation result projection query guards', () => {
  it('returns an empty page without touching PostgreSQL for an empty authorized store scope', async () => {
    await expect(
      listAllocationResults(unreachableDatabase, { page: 2, pageSize: 25, storeIds: [] }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 2, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
  });

  it('rejects pagination outside the public API bounds before querying', async () => {
    await expect(
      listAllocationResults(unreachableDatabase, { page: 0, pageSize: 20 }),
    ).rejects.toThrow('page must be a positive safe integer');
    await expect(
      listAllocationResults(unreachableDatabase, { page: 1, pageSize: 101 }),
    ).rejects.toThrow('pageSize must be between 1 and 100');
    await expect(
      listAllocationResults(unreachableDatabase, {
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 2,
      }),
    ).rejects.toThrow('pagination offset must be a non-negative safe integer');
  });

  it('derives authoritative round aggregates only from complete planner metadata', () => {
    expect(allocationRoundsFromMetadata({ policyRounds: [1, 2, 2] }, 3)).toEqual([
      { roundNumber: 1, allocatedQuantity: 1 },
      { roundNumber: 2, allocatedQuantity: 2 },
    ]);
    expect(allocationRoundsFromMetadata({ policyRounds: [] }, 0)).toEqual([]);
    expect(allocationRoundsFromMetadata({}, 2)).toEqual([]);
    expect(allocationRoundsFromMetadata({ policyRounds: [1, 2, 3] }, 2)).toEqual([]);
    expect(allocationRoundsFromMetadata({ policyRounds: [1, 0] }, 2)).toEqual([]);
  });

  it('reads count and rows sequentially in one read-only repeatable-read snapshot', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce(fakeQuery([{ value: 1 }]))
      .mockReturnValueOnce(
        fakeQuery([
          {
            id: '11111111-1111-4111-8111-111111111111',
            allocationRunId: '22222222-2222-4222-8222-222222222222',
            sessionId: '33333333-3333-4333-8333-333333333333',
            mergedOrderId: null,
            storeId: '44444444-4444-4444-8444-444444444444',
            productId: '55555555-5555-4555-8555-555555555555',
            priority: 'P1' as const,
            roundNumber: 1,
            sequenceInRound: 1,
            requestedQuantity: 3,
            allocatedQuantity: 3,
            waitlistedQuantity: 0,
            status: 'allocated' as const,
            reasonCode: 'ALLOCATED_BY_PRIORITY_ROUND_ROBIN',
            decisionMetadata: { policyRounds: [1, 2, 2] },
            createdAt: new Date('2026-09-17T02:00:00.000Z'),
          },
        ]),
      );
    const transaction = vi.fn(async (operation: (tx: { select: typeof select }) => unknown) =>
      operation({ select }),
    );
    const database = { transaction } as unknown as Database;

    const page = await listAllocationResults(database, { page: 1, pageSize: 20 });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
      deferrable: false,
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(page.data[0]?.rounds).toEqual([
      { roundNumber: 1, allocatedQuantity: 1 },
      { roundNumber: 2, allocatedQuantity: 2 },
    ]);
  });
});

interface FakeQuery<T> extends PromiseLike<T[]> {
  from(): FakeQuery<T>;
  innerJoin(): FakeQuery<T>;
  where(): FakeQuery<T>;
  orderBy(): FakeQuery<T>;
  limit(): FakeQuery<T>;
  offset(): FakeQuery<T>;
}

function fakeQuery<T>(rows: T[]): FakeQuery<T> {
  const query: FakeQuery<T> = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    offset: () => query,
    then: (onfulfilled, onrejected) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  return query;
}

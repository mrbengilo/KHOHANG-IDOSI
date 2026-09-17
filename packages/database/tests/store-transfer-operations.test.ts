import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  allocateTransferCostVnd,
  createStoreTransfer,
  dispatchStoreTransfer,
} from '../src/store-transfer-operations.js';
import * as schema from '../src/schema.js';

const IDS = {
  actor: '11111111-1111-4111-8111-111111111111',
  bag: '22222222-2222-4222-8222-222222222222',
  source: '33333333-3333-4333-8333-333333333333',
  destination: '44444444-4444-4444-8444-444444444444',
  transfer: '55555555-5555-4555-8555-555555555555',
};

describe('store transfer operation guards', () => {
  it('allocates whole VND without loss and moves all remaining cost for a full bag', () => {
    expect(allocateTransferCostVnd(101n, 3_000n, 1_000n)).toEqual({
      movedCostVnd: 33n,
      remainingCostVnd: 68n,
    });
    expect(allocateTransferCostVnd(101n, 3_000n, 3_000n)).toEqual({
      movedCostVnd: 101n,
      remainingCostVnd: 0n,
    });
  });
  it('rejects same-store movement before database I/O', async () => {
    const database = drizzle.mock({ schema });
    await expect(
      createStoreTransfer(database, {
        sourceStoreId: IDS.source,
        destinationStoreId: IDS.source,
        sourceInventoryBagId: IDS.bag,
        weightKg: '1.000',
        expectedSourceBagVersion: 0,
        note: null,
        actorUserId: IDS.actor,
        idempotencyKey: 'transfer-create-1',
        requestHash: 'hash-1',
      }),
    ).rejects.toThrow('must differ');
  });

  it('rejects non-positive exact weight before database I/O', async () => {
    const database = drizzle.mock({ schema });
    await expect(
      createStoreTransfer(database, {
        sourceStoreId: IDS.source,
        destinationStoreId: IDS.destination,
        sourceInventoryBagId: IDS.bag,
        weightKg: '0',
        expectedSourceBagVersion: 0,
        note: null,
        actorUserId: IDS.actor,
        idempotencyKey: 'transfer-create-2',
        requestHash: 'hash-2',
      }),
    ).rejects.toThrow('must be positive');
  });

  it('requires non-negative optimistic versions before dispatch I/O', async () => {
    const database = drizzle.mock({ schema });
    await expect(
      dispatchStoreTransfer(database, {
        transferId: IDS.transfer,
        expectedVersion: -1,
        expectedSourceBagVersion: 0,
        actorUserId: IDS.actor,
        idempotencyKey: 'transfer-dispatch-1',
        requestHash: 'hash-3',
      }),
    ).rejects.toThrow('non-negative');
  });
});

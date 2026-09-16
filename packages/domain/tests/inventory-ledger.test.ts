import { describe, expect, it } from 'vitest';

import {
  appendInventoryLedgerEntry,
  createInventoryLedger,
  inventoryLedgerBalance,
  reconcileInventoryLedger,
} from '../src/index.js';

describe('inventory ledger', () => {
  it('replays signed movements to the same current balance', () => {
    const opened = createInventoryLedger({
      id: 'ledger-1',
      locationId: 'warehouse-main',
      productId: 'product-1',
      openingBalance: 10,
      openedAt: '2026-09-10T00:00:00.000Z',
    });
    const received = appendInventoryLedgerEntry(opened, {
      id: 'entry-1',
      idempotencyKey: 'ledger-command-1',
      type: 'RECEIPT',
      referenceId: 'inbound-1',
      quantityDelta: 5,
      occurredAt: '2026-09-10T08:00:00.000Z',
      reason: 'Confirmed physical receipt',
    }).ledger;
    const held = appendInventoryLedgerEntry(received, {
      id: 'entry-2',
      idempotencyKey: 'ledger-command-2',
      type: 'ALLOCATION_HOLD',
      referenceId: 'allocation-1',
      quantityDelta: -3,
      occurredAt: '2026-09-10T09:00:00.000Z',
      reason: 'Allocation hold reduces available inventory',
    }).ledger;

    expect(inventoryLedgerBalance(held)).toBe(12);
    expect(reconcileInventoryLedger(held, 12)).toEqual({
      ledgerId: 'ledger-1',
      calculatedBalance: 12,
      recordedBalance: 12,
      observedBalance: 12,
      variance: 0,
      balanced: true,
    });
  });

  it('retries an append idempotently and rejects conflicting reuse', () => {
    const ledger = createInventoryLedger({
      id: 'ledger-1',
      locationId: 'warehouse-main',
      productId: 'product-1',
      openingBalance: 4,
      openedAt: '2026-09-10T00:00:00.000Z',
    });
    const input = {
      id: 'entry-1',
      idempotencyKey: 'ledger-command-1',
      type: 'ALLOCATION_HOLD' as const,
      referenceId: 'allocation-1',
      quantityDelta: -2,
      occurredAt: '2026-09-10T09:00:00.000Z',
      reason: 'hold',
    };
    const first = appendInventoryLedgerEntry(ledger, input);
    const retry = appendInventoryLedgerEntry(first.ledger, {
      ...input,
      id: 'retry-generated-id',
      occurredAt: '2026-09-10T09:01:00.000Z',
    });

    expect(retry.replayed).toBe(true);
    expect(retry.ledger.entries).toHaveLength(1);
    expect(() =>
      appendInventoryLedgerEntry(first.ledger, { ...input, quantityDelta: -3 }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('does not permit a movement to make available inventory negative', () => {
    const ledger = createInventoryLedger({
      id: 'ledger-1',
      locationId: 'warehouse-main',
      productId: 'product-1',
      openingBalance: 1,
      openedAt: '2026-09-10T00:00:00.000Z',
    });

    expect(() =>
      appendInventoryLedgerEntry(ledger, {
        id: 'entry-1',
        idempotencyKey: 'ledger-command-1',
        type: 'SHIPMENT',
        referenceId: 'shipment-1',
        quantityDelta: -2,
        occurredAt: '2026-09-10T09:00:00.000Z',
        reason: 'shipment',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_INVENTORY' }));
  });
});

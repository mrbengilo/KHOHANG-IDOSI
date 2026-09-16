import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  confirmDailyPriorityOffer,
  consumeDailyPriorityOffer,
  createDailyPriorityOffer,
  createReceiptReconciliation,
  createWaitTicket,
  expireDailyPriorityOffer,
  reconcileReceipt,
  reserveWaitTicket,
  settleWaitTicketReceipt,
  upsertActiveWaitTicket,
  type ReceiptReconciliation,
} from '../src/index.js';

function initialWaitTicket() {
  return createWaitTicket([], {
    ticketId: 'wait-1',
    storeId: 'store-A',
    productId: 'product-1',
    quantity: 5,
    sourceType: 'ALLOCATION_REMAINDER',
    referenceId: 'allocation-old',
    idempotencyKey: 'wait-source-1',
    requestedAt: '2026-09-02T09:00:00.000Z',
    recordedAt: '2026-09-02T09:00:01.000Z',
  });
}

describe('wait ticket invariants', () => {
  it('merges into the only active store/product ticket and preserves its oldest age', () => {
    const initial = initialWaitTicket();
    const merged = upsertActiveWaitTicket([initial], {
      ticketId: 'unused-on-merge',
      storeId: initial.storeId,
      productId: initial.productId,
      quantity: 2,
      sourceType: 'RECEIPT_SHORTAGE',
      referenceId: 'receipt-older',
      idempotencyKey: 'wait-source-2',
      requestedAt: '2026-09-01T09:00:00.000Z',
      recordedAt: '2026-09-03T09:00:00.000Z',
    });

    expect(merged.created).toBe(false);
    expect(merged.ticket.id).toBe(initial.id);
    expect(merged.ticket.openQuantity).toBe(7);
    expect(merged.ticket.originalRequestedAt).toBe('2026-09-01T09:00:00.000Z');

    const retry = upsertActiveWaitTicket(merged.tickets, {
      ticketId: 'another-unused-id',
      storeId: initial.storeId,
      productId: initial.productId,
      quantity: 2,
      sourceType: 'RECEIPT_SHORTAGE',
      referenceId: 'receipt-older',
      idempotencyKey: 'wait-source-2',
      requestedAt: '2026-09-01T09:00:00.000Z',
      recordedAt: '2026-09-03T09:05:00.000Z',
    });

    expect(retry.replayed).toBe(true);
    expect(retry.ticket.openQuantity).toBe(7);
  });

  it('refuses to create a second active ticket for the same store/product', () => {
    const existing = initialWaitTicket();

    expect(() =>
      createWaitTicket([existing], {
        ticketId: 'wait-2',
        storeId: existing.storeId,
        productId: existing.productId,
        quantity: 1,
        sourceType: 'MANUAL',
        referenceId: 'manual-1',
        idempotencyKey: 'manual-wait-1',
        requestedAt: '2026-09-04T09:00:00.000Z',
        recordedAt: '2026-09-04T09:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACTIVE_WAIT_TICKET_EXISTS' }));
  });

  it('rejects a second reservation for the same allocation under another key', () => {
    const first = reserveWaitTicket(initialWaitTicket(), {
      allocationId: 'allocation-1',
      quantity: 2,
      idempotencyKey: 'reservation-1',
      reservedAt: '2026-09-10T09:01:00.000Z',
    }).ticket;

    expect(() =>
      reserveWaitTicket(first, {
        allocationId: 'allocation-1',
        quantity: 1,
        idempotencyKey: 'reservation-2',
        reservedAt: '2026-09-10T09:02:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(first.reservedQuantity).toBe(2);
    expect(first.reservations).toHaveLength(1);
  });
});

describe('daily priority offer', () => {
  it('expires pending confirmation at the boundary without changing ticket age or quantity', () => {
    const ticket = initialWaitTicket();
    const offer = createDailyPriorityOffer(ticket, [], {
      id: 'offer-1',
      businessDate: '2026-09-10',
      offeredQuantity: 3,
      createdAt: '2026-09-10T08:00:00.000Z',
      expiresAt: '2026-09-10T09:00:00.000Z',
    });

    expect(() =>
      confirmDailyPriorityOffer(offer, ticket, {
        quantity: 2,
        confirmedAt: offer.expiresAt,
        idempotencyKey: 'confirmation-1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'OFFER_EXPIRED' }));
    expect(expireDailyPriorityOffer(offer, offer.expiresAt).status).toBe('EXPIRED');
    expect(ticket.openQuantity).toBe(5);
    expect(ticket.originalRequestedAt).toBe('2026-09-02T09:00:00.000Z');
  });

  it('confirms idempotently and permits the confirmed offer to become consumed', () => {
    const ticket = initialWaitTicket();
    const pending = createDailyPriorityOffer(ticket, [], {
      id: 'offer-1',
      businessDate: '2026-09-10',
      offeredQuantity: 3,
      createdAt: '2026-09-10T08:00:00.000Z',
      expiresAt: '2026-09-10T09:00:00.000Z',
    });
    const command = {
      quantity: 2,
      confirmedAt: '2026-09-10T08:59:59.999Z',
      idempotencyKey: 'confirmation-1',
    } as const;
    const first = confirmDailyPriorityOffer(pending, ticket, command);
    const retry = confirmDailyPriorityOffer(first.offer, ticket, command);
    const consumed = consumeDailyPriorityOffer(first.offer, {
      allocationId: 'allocation-1',
      allocatedQuantity: 2,
    });

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(consumed).toMatchObject({ status: 'CONSUMED', allocatedQuantity: 2 });
  });
});

describe('receipt reconciliation', () => {
  it('credits only actual receipt and does not add a wait shortage already represented by a ticket', () => {
    const ticket = reserveWaitTicket(initialWaitTicket(), {
      allocationId: 'allocation-1',
      quantity: 3,
      idempotencyKey: 'reservation-1',
      reservedAt: '2026-09-10T09:01:00.000Z',
    }).ticket;
    const receipt = createReceiptReconciliation({
      id: 'receipt-1',
      idempotencyKey: 'receipt-command-1',
      allocationId: 'allocation-1',
      storeId: ticket.storeId,
      productId: ticket.productId,
      sourceWaitTicketId: ticket.id,
      expectedQuantity: 3,
      receivedQuantity: 1,
      confirmedAt: '2026-09-10T12:00:00.000Z',
    });
    const settled = settleWaitTicketReceipt(ticket, receipt);
    const retry = settleWaitTicketReceipt(settled.ticket, receipt);

    expect(receipt).toMatchObject({
      status: 'SHORT',
      shortageQuantity: 2,
      inventoryCreditQuantity: 1,
      waitQuantityToAdd: 0,
    });
    expect(settled.ticket).toMatchObject({ openQuantity: 4, reservedQuantity: 0 });
    expect(retry.replayed).toBe(true);
    expect(retry.ticket.openQuantity).toBe(4);
  });

  it('returns a wait addition for shortage on a new-order allocation', () => {
    const receipt = createReceiptReconciliation({
      id: 'receipt-new-order',
      idempotencyKey: 'receipt-new-order-key',
      allocationId: 'new-order-allocation',
      storeId: 'store-A',
      productId: 'product-1',
      sourceWaitTicketId: null,
      expectedQuantity: 4,
      receivedQuantity: 2,
      confirmedAt: '2026-09-10T12:00:00.000Z',
    });

    expect(receipt.waitQuantityToAdd).toBe(2);
    expect(receipt.inventoryCreditQuantity).toBe(2);
  });

  it('models an idempotent receipt command without duplicate reconciliation', () => {
    const input = {
      id: 'receipt-1',
      idempotencyKey: 'receipt-command-1',
      allocationId: 'allocation-1',
      storeId: 'store-A',
      productId: 'product-1',
      sourceWaitTicketId: null,
      expectedQuantity: 3,
      receivedQuantity: 3,
      confirmedAt: '2026-09-10T12:00:00.000Z',
    } as const;
    const first = reconcileReceipt([], input);
    const retry = reconcileReceipt(first.reconciliations, {
      ...input,
      id: 'ignored-retry-id',
      confirmedAt: '2026-09-10T12:05:00.000Z',
    });

    expect(retry.replayed).toBe(true);
    expect(retry.reconciliation).toBe(first.reconciliation);
    expect(retry.reconciliations).toHaveLength(1);
  });

  it('rejects a received quantity above the shipment quantity', () => {
    expect(() =>
      createReceiptReconciliation({
        id: 'receipt-over',
        idempotencyKey: 'receipt-over-key',
        allocationId: 'allocation-over',
        storeId: 'store-A',
        productId: 'product-1',
        sourceWaitTicketId: null,
        expectedQuantity: 2,
        receivedQuantity: 3,
        confirmedAt: '2026-09-10T12:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'RECEIPT_QUANTITY_EXCEEDED' }));
  });

  it('rejects every forged negative receipt before changing a wait ticket', () => {
    const ticket = reserveWaitTicket(initialWaitTicket(), {
      allocationId: 'allocation-forged',
      quantity: 3,
      idempotencyKey: 'reservation-forged',
      reservedAt: '2026-09-10T09:01:00.000Z',
    }).ticket;
    const valid = createReceiptReconciliation({
      id: 'receipt-forged',
      idempotencyKey: 'receipt-forged-key',
      allocationId: 'allocation-forged',
      storeId: ticket.storeId,
      productId: ticket.productId,
      sourceWaitTicketId: ticket.id,
      expectedQuantity: 3,
      receivedQuantity: 0,
      confirmedAt: '2026-09-10T12:00:00.000Z',
    });

    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: -1 }), (receivedQuantity) => {
        const forged = {
          ...valid,
          receivedQuantity,
          inventoryCreditQuantity: receivedQuantity,
          shortageQuantity: valid.expectedQuantity - receivedQuantity,
        } as ReceiptReconciliation;

        expect(() => settleWaitTicketReceipt(ticket, forged)).toThrowError(
          expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
        );
        expect(ticket).toMatchObject({ openQuantity: 5, reservedQuantity: 3 });
      }),
    );
  });
});

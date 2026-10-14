import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  planWaitlistRequeue,
  planWaitTicketCancellation,
  waitTicketDisplay,
  waitTicketGroupKey,
  type WaitlistLine,
} from '../src/index.js';

const STORE = 'store-a';
const X = 'product-x';
const Y = 'product-y';

function line(
  id: string,
  productId: string,
  quantity: number,
  sourceWaitTicket: WaitlistLine['sourceWaitTicket'] = null,
): WaitlistLine {
  return { allocationLineId: id, storeId: STORE, productId, quantity, sourceWaitTicket };
}

describe('moving a result back to wait tickets', () => {
  it('requested 10, granted 6, worker queued 4: only the 6 granted bags are added (10, not 14)', () => {
    const active = new Map([[waitTicketGroupKey(STORE, X), 'pc-x']]);
    const [plan] = planWaitlistRequeue([line('l1', X, 6)], active);
    expect(plan).toMatchObject({ activeTicketId: 'pc-x', addQuantity: 6, restoreQuantity: 0 });
    // The PC held the worker's 4; after the move it waits for 4 + 6 = 10.
    expect(4 + plan!.addQuantity + plan!.restoreQuantity).toBe(10);
  });

  it('merges X into the existing ticket (3 + 2 = 5) and creates one ticket for Y (4)', () => {
    const active = new Map([[waitTicketGroupKey(STORE, X), 'pc-x']]);
    const plans = planWaitlistRequeue([line('l1', X, 2), line('l2', Y, 4)], active);
    const byProduct = new Map(plans.map((plan) => [plan.productId, plan]));
    expect(byProduct.get(X)).toMatchObject({ activeTicketId: 'pc-x', addQuantity: 2 });
    expect(3 + byProduct.get(X)!.addQuantity).toBe(5);
    expect(byProduct.get(Y)).toMatchObject({ activeTicketId: null, addQuantity: 4 });
  });

  it('restores bags granted from the active ticket instead of adding the demand twice', () => {
    const active = new Map([[waitTicketGroupKey(STORE, X), 'pc-x']]);
    const [plan] = planWaitlistRequeue(
      [line('l1', X, 2, { id: 'pc-x', status: 'active' }), line('l2', X, 3)],
      active,
    );
    expect(plan).toMatchObject({ restoreQuantity: 2, addQuantity: 3, skippedQuantity: 0 });
  });

  it('adds demand of a finished source to the active (or a new) ticket, never reopens it', () => {
    const fromFulfilled = line('l1', X, 2, { id: 'pc-old', status: 'fulfilled' });
    expect(planWaitlistRequeue([fromFulfilled], new Map())[0]).toMatchObject({
      activeTicketId: null,
      addQuantity: 2,
    });
    const active = new Map([[waitTicketGroupKey(STORE, X), 'pc-new']]);
    expect(planWaitlistRequeue([fromFulfilled], active)[0]).toMatchObject({
      activeTicketId: 'pc-new',
      addQuantity: 2,
      restoreQuantity: 0,
    });
    // A cancelled source is not requeued by an old request.
    expect(
      planWaitlistRequeue([line('l3', X, 2, { id: 'pc-c', status: 'cancelled' })], active)[0],
    ).toMatchObject({ addQuantity: 0, restoreQuantity: 0, skippedQuantity: 2 });
  });

  it('refuses a line twice and non-positive quantities', () => {
    expect(() => planWaitlistRequeue([line('l1', X, 1), line('l1', X, 1)], new Map())).toThrow(
      RangeError,
    );
    expect(() => planWaitlistRequeue([line('l1', X, 0)], new Map())).toThrow(RangeError);
  });

  it('conserves every planned bag and keeps one target per store x product', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            productId: fc.constantFrom(X, Y),
            quantity: fc.integer({ min: 1, max: 20 }),
            source: fc.constantFrom('none', 'active', 'fulfilled', 'cancelled'),
          }),
          { maxLength: 12 },
        ),
        fc.boolean(),
        (rows, hasActiveX) => {
          const active = new Map<string, string>();
          if (hasActiveX) active.set(waitTicketGroupKey(STORE, X), 'pc-x');
          const lines = rows.map((row, index) =>
            line(
              `l${index}`,
              row.productId,
              row.quantity,
              row.source === 'none'
                ? null
                : {
                    id: row.source === 'active' ? 'pc-x' : `pc-${index}`,
                    status: row.source as 'active' | 'fulfilled' | 'cancelled',
                  },
            ),
          );
          const plans = planWaitlistRequeue(lines, active);
          const planned = plans.reduce(
            (total, plan) => total + plan.restoreQuantity + plan.addQuantity + plan.skippedQuantity,
            0,
          );
          const keys = plans.map((plan) => waitTicketGroupKey(plan.storeId, plan.productId));
          return (
            planned === lines.reduce((total, item) => total + item.quantity, 0) &&
            new Set(keys).size === keys.length &&
            plans.every((plan) => plan.restoreQuantity === 0 || plan.activeTicketId === 'pc-x')
          );
        },
      ),
    );
  });
});

describe('cancelling a wait ticket with its unconfirmed grants', () => {
  it('cancels waiting demand of an active ticket', () => {
    expect(
      planWaitTicketCancellation({
        status: 'active',
        originalQuantity: 5,
        remainingQuantity: 5,
        fulfilledQuantity: 0,
        revocableQuantity: 0,
      }),
    ).toEqual({ ok: true, cancelledQuantity: 5, remainingAfter: 5, fulfilledAfter: 0 });
  });

  it('cancels a fulfilled ticket whose grant has no RE yet; RE-issued bags stay fulfilled', () => {
    // 5 waited: 3 issued with an RE order earlier (protected), 2 granted in a pending result.
    expect(
      planWaitTicketCancellation({
        status: 'fulfilled',
        originalQuantity: 5,
        remainingQuantity: 0,
        fulfilledQuantity: 5,
        revocableQuantity: 2,
      }),
    ).toEqual({ ok: true, cancelledQuantity: 2, remainingAfter: 2, fulfilledAfter: 3 });
    expect(
      planWaitTicketCancellation({
        status: 'fulfilled',
        originalQuantity: 5,
        remainingQuantity: 0,
        fulfilledQuantity: 5,
        revocableQuantity: 0,
      }),
    ).toEqual({ ok: false, reason: 'NOTHING_CANCELLABLE' });
  });

  it('never rewrites a cancelled or expired ticket and keeps conservation', () => {
    expect(
      planWaitTicketCancellation({
        status: 'cancelled',
        originalQuantity: 2,
        remainingQuantity: 2,
        fulfilledQuantity: 0,
        revocableQuantity: 0,
      }),
    ).toEqual({ ok: false, reason: 'ALREADY_CANCELLED' });
    expect(
      planWaitTicketCancellation({
        status: 'expired',
        originalQuantity: 2,
        remainingQuantity: 2,
        fulfilledQuantity: 0,
        revocableQuantity: 0,
      }),
    ).toEqual({ ok: false, reason: 'NOTHING_CANCELLABLE' });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (remaining, fulfilled, revocableSeed) => {
          if (remaining + fulfilled === 0) return true;
          const revocable = fulfilled === 0 ? 0 : revocableSeed % (fulfilled + 1);
          const plan = planWaitTicketCancellation({
            status: remaining > 0 ? 'active' : 'fulfilled',
            originalQuantity: remaining + fulfilled,
            remainingQuantity: remaining,
            fulfilledQuantity: fulfilled,
            revocableQuantity: revocable,
          });
          if (!plan.ok) return remaining === 0 && revocable === 0;
          return (
            plan.remainingAfter + plan.fulfilledAfter === remaining + fulfilled &&
            plan.fulfilledAfter >= 0 &&
            plan.cancelledQuantity === remaining + revocable
          );
        },
      ),
    );
  });
});

describe('three display labels', () => {
  it('classifies pending-linked fulfilled tickets as not processed and expired as legacy', () => {
    const base = { hasOpenOffer: false, fulfilledQuantity: 0, pendingDecisionQuantity: 0 };
    expect(waitTicketDisplay({ ...base, status: 'active' })).toEqual({
      status: 'UNPROCESSED',
      detail: 'WAITING',
    });
    expect(waitTicketDisplay({ ...base, status: 'active', hasOpenOffer: true }).detail).toBe(
      'OFFERED',
    );
    expect(
      waitTicketDisplay({
        ...base,
        status: 'fulfilled',
        fulfilledQuantity: 3,
        pendingDecisionQuantity: 3,
      }),
    ).toEqual({ status: 'UNPROCESSED', detail: 'PENDING_DECISION' });
    expect(waitTicketDisplay({ ...base, status: 'fulfilled', fulfilledQuantity: 3 })).toEqual({
      status: 'PROCESSED',
      detail: 'PROCESSED',
    });
    expect(waitTicketDisplay({ ...base, status: 'cancelled' }).status).toBe('CANCELLED');
    expect(waitTicketDisplay({ ...base, status: 'expired' })).toEqual({
      status: 'CANCELLED',
      detail: 'EXPIRED_LEGACY',
    });
  });
});

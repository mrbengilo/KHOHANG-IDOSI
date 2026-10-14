import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_DECISION_STATUSES,
  actionableAllocationQuantity,
  initialAllocationDecisionStatus,
  isShippableAllocationDecision,
  partitionRejectedShipmentSources,
  revokeFromPendingDecision,
  transitionAllocationDecision,
} from '../src/index.js';

describe('allocation result decisions', () => {
  it('asks the store only when the result grants goods', () => {
    expect(initialAllocationDecisionStatus(0)).toBe('NOT_REQUIRED');
    expect(initialAllocationDecisionStatus(1)).toBe('PENDING');
    expect(() => initialAllocationDecisionStatus(-1)).toThrow(RangeError);
    expect(() => initialAllocationDecisionStatus(1.5)).toThrow(RangeError);
  });

  it('moves PENDING exactly once and never flips an answer', () => {
    expect(
      transitionAllocationDecision({
        status: 'PENDING',
        version: 1,
        expectedVersion: 1,
        action: 'ACCEPT',
      }),
    ).toEqual({ ok: true, next: 'ACCEPTED' });
    expect(
      transitionAllocationDecision({
        status: 'PENDING',
        version: 1,
        expectedVersion: 1,
        action: 'WAITLIST',
      }),
    ).toEqual({ ok: true, next: 'WAITLISTED' });
    expect(
      transitionAllocationDecision({
        status: 'PENDING',
        version: 3,
        expectedVersion: 3,
        action: 'ACCEPT',
        actionableQuantity: 0,
      }),
    ).toEqual({ ok: false, reason: 'NOTHING_ACTIONABLE' });
    expect(
      transitionAllocationDecision({
        status: 'PENDING',
        version: 1,
        expectedVersion: 0,
        action: 'ACCEPT',
      }),
    ).toEqual({ ok: false, reason: 'STALE_VERSION' });
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOCATION_DECISION_STATUSES),
        fc.constantFrom('ACCEPT' as const, 'WAITLIST' as const),
        fc.integer({ min: 1, max: 5 }),
        (status, action, version) => {
          const result = transitionAllocationDecision({
            status,
            version,
            expectedVersion: version,
            action,
          });
          if (status === 'PENDING') return result.ok;
          if (status === 'ACCEPTED' || status === 'REJECTED' || status === 'WAITLISTED') {
            return !result.ok && result.reason === 'ALREADY_ANSWERED';
          }
          return !result.ok && result.reason === 'NOT_ANSWERABLE';
        },
      ),
    );
  });

  it('ships only accepted, not-required and legacy results', () => {
    expect(ALLOCATION_DECISION_STATUSES.filter(isShippableAllocationDecision)).toEqual([
      'ACCEPTED',
      'NOT_REQUIRED',
      'LEGACY',
    ]);
  });

  it('revokes only actionable goods and closes the result when nothing is left', () => {
    expect(actionableAllocationQuantity({ grantedQuantity: 6, revokedQuantity: 2 })).toBe(4);
    expect(() => actionableAllocationQuantity({ grantedQuantity: 6, revokedQuantity: 7 })).toThrow(
      RangeError,
    );
    expect(
      revokeFromPendingDecision({
        status: 'PENDING',
        grantedQuantity: 6,
        revokedQuantity: 0,
        revoke: 2,
      }),
    ).toEqual({ next: 'PENDING', revokedQuantity: 2 });
    expect(
      revokeFromPendingDecision({
        status: 'PENDING',
        grantedQuantity: 6,
        revokedQuantity: 2,
        revoke: 4,
      }),
    ).toEqual({ next: 'CANCELLED', revokedQuantity: 6 });
    expect(() =>
      revokeFromPendingDecision({
        status: 'PENDING',
        grantedQuantity: 6,
        revokedQuantity: 2,
        revoke: 5,
      }),
    ).toThrow(RangeError);
    expect(() =>
      revokeFromPendingDecision({
        status: 'ACCEPTED',
        grantedQuantity: 6,
        revokedQuantity: 0,
        revoke: 1,
      }),
    ).toThrow(RangeError);
    // Any sequence of revocations ends CANCELLED exactly when every granted bag is revoked.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 20 }),
        (granted, steps) => {
          let revoked = 0;
          let status: 'PENDING' | 'CANCELLED' = 'PENDING';
          for (const step of steps) {
            if (status !== 'PENDING') break;
            const revoke = Math.min(step, granted - revoked);
            const result = revokeFromPendingDecision({
              status,
              grantedQuantity: granted,
              revokedQuantity: revoked,
              revoke,
            });
            revoked = result.revokedQuantity;
            status = result.next;
          }
          return revoked <= granted && (status === 'CANCELLED') === (revoked === granted);
        },
      ),
    );
  });

  it('releases only the rejected result own sources, whatever SKU or shipment they share', () => {
    const rejected = { allocationRunId: 'run-new', storeId: 'store-a' };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            sourceAllocationRunId: fc.constantFrom('run-new', 'run-old-1', 'run-old-2'),
            productId: fc.constantFrom('p1', 'p2'),
          }),
        ),
        (rows) => {
          const sources = rows.map((row) => ({ ...row, storeId: 'store-a' }));
          const { release, keepHeld } = partitionRejectedShipmentSources(sources, rejected);
          return (
            release.length + keepHeld.length === sources.length &&
            release.every((row) => row.sourceAllocationRunId === 'run-new') &&
            keepHeld.every((row) => row.sourceAllocationRunId !== 'run-new')
          );
        },
      ),
    );
    expect(() =>
      partitionRejectedShipmentSources(
        [{ sourceAllocationRunId: 'run-new', storeId: 'store-b' }],
        rejected,
      ),
    ).toThrow(RangeError);
  });
});

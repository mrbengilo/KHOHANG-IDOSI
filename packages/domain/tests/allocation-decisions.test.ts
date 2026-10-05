import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_DECISION_STATUSES,
  initialAllocationDecisionStatus,
  isShippableAllocationDecision,
  normalizeAllocationDecisionReason,
  partitionRejectedShipmentSources,
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
        action: 'REJECT',
      }),
    ).toEqual({ ok: true, next: 'REJECTED' });
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
        fc.constantFrom('ACCEPT' as const, 'REJECT' as const),
        fc.integer({ min: 1, max: 5 }),
        (status, action, version) => {
          const result = transitionAllocationDecision({
            status,
            version,
            expectedVersion: version,
            action,
          });
          if (status === 'PENDING') return result.ok;
          if (status === 'ACCEPTED' || status === 'REJECTED') {
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

  it('accepts an optional, bounded rejection reason only', () => {
    expect(normalizeAllocationDecisionReason('REJECT', '  hết chỗ  ')).toBe('hết chỗ');
    expect(normalizeAllocationDecisionReason('REJECT', '   ')).toBeNull();
    expect(normalizeAllocationDecisionReason('ACCEPT', undefined)).toBeNull();
    expect(() => normalizeAllocationDecisionReason('ACCEPT', 'ok')).toThrow(RangeError);
    expect(() => normalizeAllocationDecisionReason('REJECT', 'x'.repeat(501))).toThrow(RangeError);
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

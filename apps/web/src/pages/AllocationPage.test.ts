import { describe, expect, it } from 'vitest';
import {
  allocationResultsViewState,
  availableSessionTransitions,
  defaultOrderSessionDraft,
  orderSessionInputFromDraft,
} from './AllocationPage';

const operationalSettings = {
  cutoffTime: '09:15',
  policyVersion: 'allocation-policy-v2',
  snapshotTime: '08:15',
} as const;

describe('production allocation session helpers', () => {
  it('uses the live operational policy and selects a usable business date', () => {
    expect(
      defaultOrderSessionDraft(operationalSettings, new Date('2026-09-16T23:00:00.000Z')),
    ).toEqual({
      allocationStartsTime: '09:15',
      businessDate: '2026-09-17',
      policyVersion: 'allocation-policy-v2',
      requestClosesTime: '08:15',
      requestOpensTime: '00:00',
    });
    expect(
      defaultOrderSessionDraft(operationalSettings, new Date('2026-09-17T02:00:00.000Z'))
        .businessDate,
    ).toBe('2026-09-18');
  });

  it('builds explicit UTC instants for the Vietnam business window', () => {
    expect(
      orderSessionInputFromDraft({
        allocationStartsTime: '09:15',
        businessDate: '2026-09-18',
        policyVersion: 'allocation-policy-v2',
        requestClosesTime: '08:15',
        requestOpensTime: '00:00',
      }),
    ).toEqual({
      error: null,
      input: {
        allocationStartsAt: '2026-09-18T02:15:00.000Z',
        businessDate: '2026-09-18',
        policyVersion: 'allocation-policy-v2',
        requestClosesAt: '2026-09-18T01:15:00.000Z',
        requestOpensAt: '2026-09-17T17:00:00.000Z',
      },
    });
  });

  it('rejects inverted windows before sending them to the backend', () => {
    expect(
      orderSessionInputFromDraft({
        allocationStartsTime: '09:00',
        businessDate: '2026-09-18',
        policyVersion: 'allocation-policy-v2',
        requestClosesTime: '08:00',
        requestOpensTime: '08:00',
      }),
    ).toEqual({ error: 'Giờ đóng nhận đơn phải sau giờ mở nhận đơn.', input: null });
  });

  it('only exposes state transitions accepted by the backend', () => {
    expect(availableSessionTransitions('SCHEDULED')).toEqual(['OPEN', 'CANCELLED']);
    expect(availableSessionTransitions('OPEN')).toEqual(['CLOSED', 'CANCELLED']);
    expect(availableSessionTransitions('CLOSED')).toEqual(['CANCELLED']);
    expect(availableSessionTransitions('ALLOCATING')).toEqual([]);
    expect(availableSessionTransitions('ALLOCATED')).toEqual([]);
    expect(availableSessionTransitions('CANCELLED')).toEqual([]);
  });

  it('keeps allocation result loading, error, empty and ready states explicit', () => {
    expect(allocationResultsViewState({ hasError: false, isPending: true, resultCount: 0 })).toBe(
      'LOADING',
    );
    expect(allocationResultsViewState({ hasError: true, isPending: false, resultCount: 0 })).toBe(
      'ERROR',
    );
    expect(allocationResultsViewState({ hasError: false, isPending: false, resultCount: 0 })).toBe(
      'EMPTY',
    );
    expect(allocationResultsViewState({ hasError: false, isPending: false, resultCount: 1 })).toBe(
      'READY',
    );
    expect(allocationResultsViewState({ hasError: true, isPending: false, resultCount: 2 })).toBe(
      'READY',
    );
  });
});

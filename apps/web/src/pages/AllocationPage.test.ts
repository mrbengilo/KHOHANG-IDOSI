import type { WorkerStatus } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';
import {
  allocationRoundText,
  allocationResultsViewState,
  availableSessionTransitions,
  defaultOrderSessionDraft,
  orderSessionInputFromDraft,
  overdueAllocationSessions,
  workerStatusNotice,
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
    // After the stock snapshot the backend refuses a cancel, so it is not offered.
    expect(availableSessionTransitions('OPEN', true)).toEqual(['CLOSED']);
    expect(availableSessionTransitions('CLOSED', true)).toEqual([]);
  });

  it('flags sessions still unfinished well after their allocation time', () => {
    const session = {
      id: '10000000-0000-4000-8000-000000000001',
      businessDate: '2026-09-17',
      status: 'OPEN' as const,
      requestOpensAt: '2026-09-16T17:00:00.000Z',
      requestClosesAt: '2026-09-17T01:00:00.000Z',
      allocationStartsAt: '2026-09-17T02:00:00.000Z',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      version: 1,
      createdAt: '2026-09-16T17:00:00.000Z',
      updatedAt: '2026-09-16T17:00:00.000Z',
    };
    const at = (iso: string) => Date.parse(iso);
    expect(overdueAllocationSessions([session], at('2026-09-17T02:10:00.000Z'))).toEqual([]);
    expect(overdueAllocationSessions([session], at('2026-09-17T02:20:00.000Z'))).toEqual([session]);
    expect(
      overdueAllocationSessions(
        [{ ...session, status: 'ALLOCATED' as const }],
        at('2026-09-17T05:00:00.000Z'),
      ),
    ).toEqual([]);
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

  it('renders authoritative planner-round aggregates without inventing legacy metadata', () => {
    expect(
      allocationRoundText({
        allocatedQuantity: 3,
        rounds: [
          { roundNumber: 1, allocatedQuantity: 1 },
          { roundNumber: 2, allocatedQuantity: 2 },
        ],
      }),
    ).toBe('Vòng 1: 1 · Vòng 2: 2');
    expect(allocationRoundText({ allocatedQuantity: 0, rounds: [] })).toBe('Không có lượt cấp');
    expect(allocationRoundText({ allocatedQuantity: 2, rounds: [] })).toBe('Chưa có dữ liệu vòng');
    expect(
      allocationRoundText({ allocatedQuantity: 100000, rounds: [], roundsOmitted: true }),
    ).toBe('Chi tiết vòng vượt giới hạn danh sách; tổng đã cấp: 100000');
  });
});

describe('allocation worker notice', () => {
  const base: Omit<WorkerStatus, 'status'> = {
    worker: 'allocation',
    lastTickStartedAt: '2026-09-24T02:29:00.000Z',
    lastTickCompletedAt: '2026-09-24T02:29:05.000Z',
    lastSuccessfulTickAt: '2026-09-24T01:59:05.000Z',
    lastError: null,
    failingJobs: [],
    updatedAt: '2026-09-24T02:29:05.000Z',
  };

  it('stays silent while the worker is healthy or has never reported', () => {
    expect(workerStatusNotice(undefined)).toBeNull();
    expect(workerStatusNotice({ ...base, status: 'HEALTHY' })).toBeNull();
    expect(workerStatusNotice({ ...base, status: 'UNKNOWN' })).toBeNull();
  });

  it('names the failing job, its time and its error', () => {
    const notice = workerStatusNotice({
      ...base,
      status: 'DEGRADED',
      lastError: 'Opening snapshot is missing',
      failingJobs: [
        {
          kind: 'snapshot-0800',
          sessionId: 'session-1',
          scheduledFor: '2026-09-24T01:00:00.000Z',
          status: 'FAILED',
          error: 'Opening snapshot is missing',
        },
        {
          kind: 'finalize-0900',
          sessionId: 'session-1',
          scheduledFor: '2026-09-24T02:00:00.000Z',
          status: 'BLOCKED',
          error: null,
        },
      ],
    });
    expect(notice).toContain('Chụp tồn 08:00 lúc 08:00: Opening snapshot is missing');
    expect(notice).toContain('Chốt phân bổ 09:00 lúc 09:00: chờ bước 08:00');
  });

  it('warns when the worker stopped reporting', () => {
    expect(workerStatusNotice({ ...base, status: 'STALE' })).toContain('không phản hồi từ 09:29');
  });
});

import type { WorkerStatus } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';
import {
  allocationTabs,
  readAllocationTab,
  sessionsOfBusinessDate,
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
  policyVersion: 'idosi-round-robin-p0a-p3-v1',
  snapshotTime: '08:15',
} as const;

describe('production allocation session helpers', () => {
  it('does not inherit an unsupported policy and rejects a tampered draft', () => {
    const draft = defaultOrderSessionDraft({
      ...operationalSettings,
      policyVersion: 'idosi-round-robin-p0a-p3-v3',
    });
    expect(draft.policyVersion).toBe('idosi-round-robin-p0a-p3-v1');
    expect(
      orderSessionInputFromDraft({ ...draft, policyVersion: 'idosi-round-robin-p0a-p3-v3' }).input,
    ).toBeNull();
  });
  it('uses the live operational policy and selects a usable business date', () => {
    expect(
      defaultOrderSessionDraft(operationalSettings, new Date('2026-09-16T23:00:00.000Z')),
    ).toEqual({
      allocationStartsTime: '09:15',
      businessDate: '2026-09-17',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
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
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        requestClosesTime: '08:15',
        requestOpensTime: '00:00',
      }),
    ).toEqual({
      error: null,
      input: {
        allocationStartsAt: '2026-09-18T02:15:00.000Z',
        businessDate: '2026-09-18',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
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
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        requestClosesTime: '08:00',
        requestOpensTime: '08:00',
      }),
    ).toEqual({ error: 'Giờ đóng nhận đơn phải sau giờ mở nhận đơn.', input: null });
    // Priority offers need a response window: allocation cannot start at the close itself.
    expect(
      orderSessionInputFromDraft({
        allocationStartsTime: '14:00',
        businessDate: '2026-09-18',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        requestClosesTime: '14:00',
        requestOpensTime: '12:00',
      }).error,
    ).toContain('phải sau giờ đóng nhận đơn');
    expect(
      orderSessionInputFromDraft({
        allocationStartsTime: '14:30',
        businessDate: '2026-09-18',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        requestClosesTime: '14:00',
        requestOpensTime: '12:00',
      }).error,
    ).toBeNull();
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
      kind: 'DEFAULT' as const,
      completedAt: null,
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
    expect(notice).toContain('Chụp tồn lúc 08:00: Opening snapshot is missing');
    expect(notice).toContain('Chốt phân bổ lúc 09:00: chờ bước chụp tồn');
  });

  it('warns when the worker stopped reporting', () => {
    expect(workerStatusNotice({ ...base, status: 'STALE' })).toContain('không phản hồi từ 09:29');
  });

  it('shows order history to ADMIN and HTKD and the create tab to ADMIN only', () => {
    const ids = (role: Parameters<typeof allocationTabs>[0]) =>
      allocationTabs(role).map((tab) => tab.id);
    expect(ids('ADMIN')).toEqual(['sessions', 'history', 'wait-tickets', 'create']);
    expect(ids('HTKD')).toEqual(['sessions', 'history']);
    expect(ids('STORE')).toEqual(['sessions']);
    expect(ids('WHOLESALE')).toEqual(['sessions']);
    // A tab outside the role falls back to the shared one instead of rendering it.
    expect(readAllocationTab(new URLSearchParams('tab=create'), 'HTKD')).toBe('sessions');
    expect(readAllocationTab(new URLSearchParams('tab=history'), 'STORE')).toBe('sessions');
    expect(readAllocationTab(new URLSearchParams('tab=history'), 'HTKD')).toBe('history');
  });

  it('lists the sessions of one business date in schedule order', () => {
    const make = (id: string, close: string, created: string, businessDate = '2026-10-02') => ({
      id,
      businessDate,
      kind: 'MANUAL' as const,
      completedAt: null,
      status: 'SCHEDULED' as const,
      requestOpensAt: '2026-10-01T17:00:00.000Z',
      requestClosesAt: close,
      allocationStartsAt: close,
      policyVersion: 'p',
      version: 0,
      createdAt: created,
      updatedAt: created,
    });
    const sessions = [
      make('late', '2026-10-02T07:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      make('early-b', '2026-10-02T01:00:00.000Z', '2026-10-01T02:00:00.000Z'),
      make('early-a', '2026-10-02T01:00:00.000Z', '2026-10-01T01:00:00.000Z'),
      make('other-day', '2026-10-03T01:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-03'),
    ];
    expect(sessionsOfBusinessDate(sessions, '2026-10-02').map((session) => session.id)).toEqual([
      'early-a',
      'early-b',
      'late',
    ]);
  });
});

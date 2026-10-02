import type { OrderSession, StoreOrderRequest } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';
import { formatRequestSubmittedAt, sessionRequestRows } from './session-request-rows';

const session = (id: string, businessDate = '2026-09-23'): OrderSession =>
  ({ id, businessDate }) as OrderSession;
const request = (
  id: string,
  sessionId: string,
  storeId: string,
  submittedAt: string,
): StoreOrderRequest => ({ id, sessionId, storeId, submittedAt }) as StoreOrderRequest;
const stores = [
  { id: 'vl', code: 'VL', name: 'Sỉ Vĩnh Long' },
  { id: 'ct', code: 'CT', name: 'Sỉ Cần Thơ' },
];

describe('session request rows', () => {
  it('navigates once per store after allocation without merging different sessions or stores', () => {
    const done = { ...session('s1'), status: 'ALLOCATED' as const };
    const sources = [
      request('r1', 's1', 'vl', '2026-09-23T01:00:00Z'),
      request('r2', 's1', 'vl', '2026-09-23T02:00:00Z'),
      request('r3', 's1', 'ct', '2026-09-23T03:00:00Z'),
    ];
    const rows = sessionRequestRows([done], sources, stores);
    expect(rows.map((row) => row.request?.storeId)).toEqual(['ct', 'vl']);
    expect(sources).toHaveLength(3);
  });
  it('gives every request its own row, newest first, inside the session order', () => {
    const rows = sessionRequestRows(
      [session('s2'), session('s1')],
      [
        request('r1', 's2', 'vl', '2026-09-23T05:14:49.099Z'),
        request('r2', 's2', 'ct', '2026-09-23T05:15:09.196Z'),
        request('r3', 's1', 'vl', '2026-09-22T01:00:00.000Z'),
      ],
      stores,
    );
    expect(
      rows.map((row) => [row.key, row.session.id, row.store?.code, row.firstOfSession]),
    ).toEqual([
      ['r2', 's2', 'CT', true],
      ['r1', 's2', 'VL', false],
      ['r3', 's1', 'VL', true],
    ]);
  });

  it('keeps a session without requests visible as a single row', () => {
    const rows = sessionRequestRows([session('empty')], [], stores);
    expect(rows).toEqual([
      {
        key: 'empty',
        session: session('empty'),
        request: null,
        firstOfSession: true,
        firstOfDay: true,
        dayLabel: '23/09/2026',
        store: null,
      },
    ]);
  });

  it('starts a date group only when the Vietnam submission day changes', () => {
    const rows = sessionRequestRows(
      [session('s2', '2026-09-24'), session('s1', '2026-09-23')],
      [
        request('r1', 's2', 'vl', '2026-09-23T18:00:00.000Z'),
        request('r2', 's2', 'ct', '2026-09-23T16:00:00.000Z'),
        request('r3', 's1', 'vl', '2026-09-23T01:00:00.000Z'),
      ],
      stores,
    );
    expect(rows.map((row) => [row.key, row.dayLabel, row.firstOfDay])).toEqual([
      ['r1', '24/09/2026', true],
      ['r2', '23/09/2026', true],
      ['r3', '23/09/2026', false],
    ]);
  });

  it('drops requests of sessions that are not listed', () => {
    const rows = sessionRequestRows(
      [session('s1')],
      [request('orphan', 'other', 'vl', '2026-09-23T05:14:49.099Z')],
      stores,
    );
    expect(rows.map((row) => row.key)).toEqual(['s1']);
  });

  it('formats the send time on the Vietnam clock', () => {
    // 05:14 UTC is 12:14 in Vietnam, and 17:30 UTC already falls on the next Vietnam day.
    expect(formatRequestSubmittedAt('2026-09-23T05:14:49.099Z')).toEqual({
      date: '23/09/2026',
      time: '12:14',
    });
    expect(formatRequestSubmittedAt('2026-09-23T17:30:00.000Z').date).toBe('24/09/2026');
  });

  it('keeps three same-day sessions apart with their own keys and session rows', () => {
    const sessions = ['s1', 's2', 's3'].map((id) => ({
      ...session(id),
      status: 'OPEN' as const,
    }));
    const rows = sessionRequestRows(
      sessions,
      [
        request('a', 's1', 'vl', '2026-09-23T01:00:00Z'),
        request('b', 's2', 'vl', '2026-09-23T02:00:00Z'),
        request('c', 's2', 'ct', '2026-09-23T02:30:00Z'),
      ],
      stores,
    );
    expect(rows.map((row) => [row.session.id, row.key, row.firstOfSession])).toEqual([
      ['s1', 'a', true],
      ['s2', 'c', true],
      ['s2', 'b', false],
      ['s3', 's3', true],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

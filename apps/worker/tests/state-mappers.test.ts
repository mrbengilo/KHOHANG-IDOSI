import { describe, expect, it } from 'vitest';

import {
  isRunnableSessionStatus,
  mapDatabaseNewOrderPriority,
  mapDatabaseOfferStatus,
  mapDatabaseOrderRequestStatus,
  mapDatabaseWaitStatus,
} from '../src/state-mappers.js';

describe('database/domain state mappings', () => {
  it('maps every priority-offer state explicitly and detects invalid consumption', () => {
    expect(mapDatabaseOfferStatus('offered', false)).toBe('PENDING');
    expect(mapDatabaseOfferStatus('accepted', false)).toBe('CONFIRMED');
    expect(mapDatabaseOfferStatus('declined', false)).toBe('DECLINED');
    expect(mapDatabaseOfferStatus('expired', false)).toBe('EXPIRED');
    expect(mapDatabaseOfferStatus('cancelled', false)).toBe('EXPIRED');
    expect(mapDatabaseOfferStatus('accepted', true)).toBe('CONSUMED');
    expect(() => mapDatabaseOfferStatus('expired', true)).toThrow(/accepted database offer/u);
  });

  it('maps wait, request, and runnable session states without enum casts', () => {
    expect(mapDatabaseWaitStatus('active')).toBe('ACTIVE');
    expect(mapDatabaseWaitStatus('fulfilled')).toBe('FULFILLED');
    expect(mapDatabaseWaitStatus('expired')).toBe('CANCELLED');
    expect(mapDatabaseOrderRequestStatus('submitted')).toBe('SUBMITTED');
    expect(mapDatabaseOrderRequestStatus('merged')).toBe('MERGED');
    expect(mapDatabaseOrderRequestStatus('cancelled')).toBe('CANCELLED');
    expect(() => mapDatabaseOrderRequestStatus('draft')).toThrow(/draft/u);
    expect(isRunnableSessionStatus('open')).toBe(true);
    expect(isRunnableSessionStatus('completed')).toBe(false);
  });

  it('rejects P0A on regular order request lines', () => {
    expect(mapDatabaseNewOrderPriority('P0B')).toBe('P0B');
    expect(mapDatabaseNewOrderPriority('P3')).toBe('P3');
    expect(() => mapDatabaseNewOrderPriority('P0A')).toThrow(/reserved/u);
  });
});

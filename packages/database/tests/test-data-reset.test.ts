import { describe, expect, it } from 'vitest';
import {
  canonical,
  classifyResetAudit,
  resetAction,
  resetHash,
  RESET_KEEP_TABLES,
  RESET_PURGE_TABLES,
} from '../src/test-data-reset.js';

describe('reset plan safety', () => {
  it('classifies SQL-only counters and the migration journal, rejects unknown schemas', () => {
    expect(resetAction('public', 'document_code_counters')).toBe('KEEP');
    expect(resetAction('public', 'store_inventory_bag_code_counters')).toBe('KEEP');
    expect(resetAction('drizzle', '__drizzle_migrations')).toBe('KEEP');
    expect(resetAction('external', 'users')).toBe('REVIEW');
    expect(resetAction('public', 'future_transactions')).toBe('REVIEW');
    expect(
      RESET_PURGE_TABLES.filter((t) => (RESET_KEEP_TABLES as readonly string[]).includes(t)),
    ).toEqual([]);
  });
  it('fingerprints canonical objects while preserving arrays and nulls', () => {
    expect(resetHash({ a: 1, b: { c: null, d: [1, 2] } })).toBe(
      resetHash({ b: { d: [1, 2], c: null }, a: 1 }),
    );
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(resetHash({ x: '1' })).not.toBe(resetHash({ x: 1 }));
  });
  it('purges derived IDOSI inventory audits and blocks mixed/unknown audit payloads', () => {
    const row = {
      action: 'IDOSI_SALE_STOCK_CONSUMED',
      entity_type: 'store_sorting_event',
      before: null,
      after: { weightKg: '1' },
      metadata: {},
    };
    expect(classifyResetAudit(row)).toBe('PURGE');
    expect(
      classifyResetAudit({ ...row, entity_type: 'user', after: { receiptId: 'old-test-id' } }),
    ).toBe('REVIEW');
    expect(classifyResetAudit({ ...row, entity_type: 'unknown' })).toBe('REVIEW');
    for (const [entity_type, action] of [
      ['store', 'STORE_CREATED'],
      ['store_group', 'STORE_GROUP_UPDATED'],
      ['idosi_product_link', 'IDOSI_PRODUCT_LINK_CREATED'],
    ]) {
      expect(
        classifyResetAudit({
          ...row,
          entity_type: entity_type!,
          action: action!,
          after: { name: 'Configuration' },
        }),
      ).toBe('KEEP');
    }
    expect(
      classifyResetAudit({
        ...row,
        action: 'ACCOUNT_STATUS_UPDATED',
        entity_type: 'user',
        after: { status: 'locked' },
      }),
    ).toBe('KEEP');
  });
});

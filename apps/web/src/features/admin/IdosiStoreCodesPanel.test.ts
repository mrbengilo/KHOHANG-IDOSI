import type { IdosiStoreCode } from '@idosi/contracts';
import { describe, expect, it } from 'vitest';

import { storesMissingIdosiCode } from './IdosiStoreCodesPanel';

const row = (storeCode: string, source: IdosiStoreCode['source']): IdosiStoreCode => ({
  storeId: `00000000-0000-4000-8000-${storeCode.padStart(12, '0')}`,
  storeCode,
  storeName: storeCode,
  idosiStoreCode: source === 'STORE' ? `I${storeCode}` : null,
  effectiveIdosiStoreCode: source === 'MISSING' ? null : storeCode,
  source,
});

describe('IDOSI store codes', () => {
  it('flags only stores whose sales cannot be synced', () => {
    expect(
      storesMissingIdosiCode([
        row('1', 'STORE'),
        row('2', 'ENVIRONMENT_MAP'),
        row('3', 'MISSING'),
        row('4', 'STORE_CODE'),
      ]).map((item) => item.storeCode),
    ).toEqual(['3']);
  });
});

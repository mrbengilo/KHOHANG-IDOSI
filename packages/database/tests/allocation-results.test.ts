import { describe, expect, it } from 'vitest';

import { listAllocationResults } from '../src/allocation-results.js';
import type { Database } from '../src/client.js';

const unreachableDatabase = {} as Database;

describe('allocation result projection query guards', () => {
  it('returns an empty page without touching PostgreSQL for an empty authorized store scope', async () => {
    await expect(
      listAllocationResults(unreachableDatabase, { page: 2, pageSize: 25, storeIds: [] }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 2, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
  });

  it('rejects pagination outside the public API bounds before querying', async () => {
    await expect(
      listAllocationResults(unreachableDatabase, { page: 0, pageSize: 20 }),
    ).rejects.toThrow('page must be a positive safe integer');
    await expect(
      listAllocationResults(unreachableDatabase, { page: 1, pageSize: 101 }),
    ).rejects.toThrow('pageSize must be between 1 and 100');
  });
});

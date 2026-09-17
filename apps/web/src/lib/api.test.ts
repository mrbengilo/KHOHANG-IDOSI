import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCatalog } from './api';

const pagination = { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 };

describe('catalog API projection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a missing conversion explicit instead of inventing a one-to-one ratio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        const payload = url.includes('/product-conversions')
          ? { data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } }
          : {
              data: [
                {
                  createdAt: '2026-09-17T00:00:00.000Z',
                  id: '00000000-0000-4000-8000-000000000001',
                  measurement: 'UNIT',
                  name: 'Mặt hàng chưa quy đổi',
                  sku: 'MISSING-001',
                  status: 'ACTIVE',
                  unitLabel: 'cái',
                  updatedAt: '2026-09-17T00:00:00.000Z',
                },
              ],
              pagination,
            };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        );
      }),
    );

    await expect(listCatalog()).resolves.toEqual([
      expect.objectContaining({
        conversionMissing: true,
        itemQuantity: null,
        weightKilograms: null,
      }),
    ]);
  });
});

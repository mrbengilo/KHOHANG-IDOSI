import type { Store } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdosiSalesWorkspace } from './IdosiSalesWorkspace';
import { IdosiStatisticsPanel } from './IdosiStatisticsPanel';
import { ProductionOutboundPage } from '../inventory/InventoryOperations';

afterEach(() => vi.useRealTimers());
const storeId = '20000000-0000-4000-8000-000000000001';
const timestamp = '2026-09-17T03:00:00.000Z';
const retail: Store = {
  id: storeId,
  code: 'TEST_RETAIL',
  name: 'Cửa hàng kiểm thử',
  kind: 'RETAIL',
  status: 'ACTIVE',
  address: null,
  groupId: '30000000-0000-4000-8000-000000000001',
  version: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('IDOSI workspace source isolation', () => {
  it('keeps IDOSI visible on the sales page when the warehouse catalog fails', async () => {
    // Preserve the settled error during static rendering instead of retrying on mount.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    await client.prefetchQuery({
      queryKey: ['catalog'],
      queryFn: () => Promise.reject(new Error('Warehouse unavailable')),
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProductionOutboundPage, { role: 'ADMIN', storeKind: null, mode: 'SALE' }),
      ),
    );
    expect(html).toContain('Không thể tải dữ liệu vận hành');
    expect(html).toContain('Doanh thu &amp; hàng đã bán');
    expect(html).toContain('Kỳ thống kê IDOSI');
    client.clear();
  });

  it('keeps IDOSI visible while warehouse data loads without adding it to sorting', () => {
    for (const mode of ['SALE', 'SORTING'] as const) {
      const client = new QueryClient();
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ProductionOutboundPage, { role: 'ADMIN', storeKind: null, mode }),
        ),
      );
      expect(html.includes('Doanh thu &amp; hàng đã bán')).toBe(mode === 'SALE');
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey[0] === 'idosi-sales-summary'),
      ).toBe(mode === 'SALE');
      client.clear();
    }
  });

  it('does not issue a broad statistics query while the store identity is unresolved', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(IdosiSalesWorkspace, { role: 'STORE', principalStoreId: '', stores: [] }),
      ),
    );
    expect(html).toContain('Đang xác minh cửa hàng');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('uses one period and the principal store for both summary and detail queries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(IdosiSalesWorkspace, {
          role: 'STORE',
          principalStoreId: storeId,
          stores: [],
        }),
      ),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([
      ['idosi-sales-summary', '2026-09', storeId],
      ['idosi-statistics', storeId, '2026-09'],
    ]);
    expect(html.match(/type="month"/g)).toHaveLength(1);
    expect(html).not.toContain('<select');
  });

  it('only offers retail stores and renders the summary independently of warehouse queries', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(IdosiSalesWorkspace, {
          role: 'HTKD',
          principalStoreId: '',
          stores: [
            retail,
            {
              ...retail,
              id: '20000000-0000-4000-8000-000000000002',
              kind: 'WHOLESALE',
              code: 'TEST_WHOLESALE',
            },
          ],
        }),
      ),
    );
    expect(html).toContain('TEST_RETAIL');
    expect(html).not.toContain('TEST_WHOLESALE');
    expect(html).toContain('Doanh thu &amp; hàng đã bán');
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey[0]),
    ).toEqual(['idosi-sales-summary']);
  });

  it('honors a historical shared period instead of silently querying the current month', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(IdosiStatisticsPanel, { storeId, period: '2025-12' }),
      ),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([['idosi-statistics', storeId, '2025-12']]);
    expect(html).toContain('Kỳ thống kê: 2025-12');
    expect(html).not.toContain('type="month"');
  });
});

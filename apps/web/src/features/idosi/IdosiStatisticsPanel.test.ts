import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IdosiStatisticsState } from '@idosi/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  currentIdosiPeriod,
  IdosiStatisticsPanel,
  idosiFreshnessView,
} from './IdosiStatisticsPanel';

const baseState: IdosiStatisticsState = {
  freshness: 'EMPTY',
  integrationStatus: 'CONFIGURED',
  latestAttempt: null,
  scope: {
    date: null,
    paymentMethod: null,
    period: '2026-09',
    shiftId: null,
    storeId: '20000000-0000-4000-8000-000000000001',
  },
  snapshot: null,
};

describe('IDOSI statistics presentation', () => {
  it('uses the Vietnam business month at a UTC month boundary', () => {
    expect(currentIdosiPeriod(new Date('2026-08-31T18:00:00.000Z'))).toBe('2026-09');
  });

  it('makes stale data explicit instead of presenting it as current', () => {
    expect(idosiFreshnessView({ ...baseState, freshness: 'STALE' })).toMatchObject({
      label: 'Dữ liệu cũ',
      tone: 'warning',
    });
  });

  it('prioritizes missing server configuration over snapshot freshness', () => {
    expect(
      idosiFreshnessView({
        ...baseState,
        freshness: 'CURRENT',
        integrationStatus: 'NOT_CONFIGURED',
      }),
    ).toMatchObject({ label: 'Chưa cấu hình', tone: 'warning' });
  });

  it('disables the sync action when the server integration is not configured', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T03:00:00.000Z'));
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
      });
      queryClient.setQueryData(['idosi-statistics', baseState.scope.storeId, '2026-09'], {
        ...baseState,
        integrationStatus: 'NOT_CONFIGURED',
      });
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IdosiStatisticsPanel, { storeId: baseState.scope.storeId }),
        ),
      );

      expect(html).toContain('Chưa cấu hình');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Đồng bộ ngay/su);
      expect(html).toContain('không dùng để trừ tồn kho');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompts oversight users to choose one store before reading or syncing', () => {
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(IdosiStatisticsPanel, { storeId: '' }),
      ),
    );

    expect(html).toContain('Chưa chọn cửa hàng');
    expect(html).not.toContain('Đồng bộ ngay');
  });
});

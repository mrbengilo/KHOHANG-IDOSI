import type { IdosiOrderStatisticsPayload } from '@idosi/contracts';
import type { DueIdosiStatisticsTarget } from '@idosi/database';
import { describe, expect, it, vi } from 'vitest';

import {
  businessMonthAt,
  IdosiStatisticsSyncWorker,
  type ScheduledIdosiSyncRepository,
} from '../src/idosi-sync.js';

const now = new Date('2026-09-17T03:00:00.000Z');

function target(storeId: string, storeCode: string): DueIdosiStatisticsTarget {
  return {
    storeId,
    storeCode,
    storeName: storeCode,
    scope: {
      storeId,
      period: '2026-09',
      date: null,
      shiftId: null,
      paymentMethod: null,
    },
    intervalMinutes: 15,
  };
}

class FakeRepository implements ScheduledIdosiSyncRepository {
  readonly successes: string[] = [];
  readonly failures: { readonly storeCode: string; readonly code: string }[] = [];

  public constructor(readonly targets: readonly DueIdosiStatisticsTarget[]) {}

  public async listDue(period: string, instant: Date, limit: number) {
    expect(period).toBe('2026-09');
    expect(instant).toEqual(now);
    return this.targets.slice(0, limit);
  }

  public async recordSuccess(
    scheduled: DueIdosiStatisticsTarget,
    _payload: IdosiOrderStatisticsPayload,
  ) {
    this.successes.push(scheduled.storeCode);
  }

  public async recordFailure(scheduled: DueIdosiStatisticsTarget, errorCode: string) {
    this.failures.push({ storeCode: scheduled.storeCode, code: errorCode });
  }
}

describe('scheduled IDOSI statistics sync', () => {
  it('uses the Vietnam business month across UTC boundaries', () => {
    expect(businessMonthAt(new Date('2026-08-31T18:00:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe(
      '2026-09',
    );
  });

  it('continues other stores, records safe failure state and never sends the secret in the URL', async () => {
    const repository = new FakeRepository([
      target('20000000-0000-4000-8000-000000000001', 'DS_NVT'),
      target('20000000-0000-4000-8000-000000000002', 'DS_BD'),
    ]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).not.toContain('worker-secret');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer worker-secret');
      const requestedCode = url.searchParams.get('storeId') ?? '';
      expect(['S01', 'S02']).toContain(requestedCode);
      const responseCode = requestedCode === 'S02' ? 'WRONG_STORE' : requestedCode;
      return new Response(JSON.stringify(payload(responseCode)));
    });
    const worker = new IdosiStatisticsSyncWorker(repository, {
      endpoint: 'https://idosi.io.vn/api/integrations/warehouse/v1/order-statistics',
      secret: 'worker-secret',
      storeIdMap: { DS_NVT: 'S01', DS_BD: 'S02' },
      timeZone: 'Asia/Ho_Chi_Minh',
      maxStoresPerTick: 10,
      fetch: fetchMock,
      now: () => now,
    });

    await expect(worker.runOnce(now)).resolves.toEqual({
      period: '2026-09',
      due: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(repository.successes).toEqual(['DS_NVT']);
    expect(repository.failures).toEqual([{ storeCode: 'DS_BD', code: 'IDOSI_RESPONSE_INVALID' }]);
  });
});

function payload(storeCode: string): IdosiOrderStatisticsPayload {
  const bucket = {
    actualKg: 0,
    estimatedKg: 0,
    knownKg: 0,
    totalKg: 0,
    isComplete: true,
    missingFactorLines: 0,
    invalidLines: 0,
    unclassifiedOrders: 0,
  };
  const weight = {
    ...bucket,
    schemaVersion: 1,
    unit: 'KG' as const,
    tableVersion: 'IDOSI-2026-09-15-v2',
    byRevenueType: { NORMAL: bucket, SALE_KG: bucket, SALE_PIECE: bucket },
  };
  return {
    ok: true,
    apiVersion: 1,
    storeId: storeCode,
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: '2026-09-17T03:00:00.000Z',
    store: { id: storeCode, name: storeCode },
    filters: { period: '2026-09', date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders: 0,
      cash: 0,
      transfer: 0,
      revenue: 0,
      cashOrders: 0,
      transferOrders: 0,
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
      unclassifiedRevenue: 0,
      unclassifiedOrders: 0,
      weight,
    },
    products: {
      totalQuantity: 0,
      salePieceQuantity: 0,
      totalWeightKg: 0,
      productTypes: 0,
      ordersWithItems: 0,
      unclassifiedOrders: 0,
      items: [],
      weight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
    serverTime: '2026-09-17T03:00:00.000Z',
    requestId: 'remote-worker-request',
  };
}

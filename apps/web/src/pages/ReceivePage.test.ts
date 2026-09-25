import type { DeclareStoreReceiptRequest, StoreReceiptSource } from '@idosi/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listStoreReceiptSources } from '../features/receipts/receiptSourceApi';
import {
  confirmReceiptDeclaration,
  PendingSourceCount,
  resolveReceivingStoreId,
  receiptSourceDraftLines,
  removeDeclaredReceiptSource,
  receiptTotalsPreview,
  receiptWeightTotal,
} from './ReceivePage';

describe('receipt totals with manually entered VAT', () => {
  it('keeps VAT out of the landed cost but adds it to the receipt total', () => {
    expect(
      receiptTotalsPreview({
        priced: [{ weightsKg: ['100', '150'], pricePerKgVnd: '20000' }],
        freightVnd: '200000',
        handlingVnd: '100000',
        vatVnd: '500000',
      }),
    ).toEqual({
      goodsVnd: 5_000_000n,
      freightVnd: 200_000n,
      handlingVnd: 100_000n,
      costVnd: 5_300_000n,
      vatVnd: 500_000n,
      totalVnd: 5_800_000n,
    });
  });

  it('rounds each bag like the server and waits for missing inputs', () => {
    const preview = receiptTotalsPreview({
      priced: [
        { weightsKg: ['2.333'], pricePerKgVnd: '1001' },
        { weightsKg: ['0.5'], pricePerKgVnd: '3' },
      ],
      freightVnd: '0',
      handlingVnd: '0',
      vatVnd: '',
    });
    // 2.333 kg × 1,001 = 2,335.333 → 2,335; 0.5 kg × 3 = 1.5 → 2 (half up).
    expect(preview.goodsVnd).toBe(2_337n);
    expect(preview.costVnd).toBe(2_337n);
    expect(preview.vatVnd).toBeNull();
    expect(preview.totalVnd).toBeNull();
    expect(
      receiptTotalsPreview({
        priced: [{ weightsKg: ['30', ''], pricePerKgVnd: '1000' }],
        freightVnd: '0',
        handlingVnd: '0',
        vatVnd: '0',
      }),
    ).toMatchObject({ goodsVnd: null, costVnd: null, totalVnd: null, vatVnd: 0n });
  });
});

describe('actual received bag totals', () => {
  it('totals three received bags exactly without trailing decimals', () => {
    expect(receiptWeightTotal(['30', '50', '60'])).toBe('140 kg');
    expect(receiptWeightTotal(['2.33', '4.777'])).toBe('7,11 kg');
    expect(receiptWeightTotal(['30', '', '60'])).toBe('Chưa nhập đủ');
    expect(receiptWeightTotal([])).toBe('0 kg');
  });
});

const declaration: DeclareStoreReceiptRequest = {
  discrepancyNote: null,
  lines: [
    {
      approvedUnits: 2,
      productId: '40000000-0000-4000-8000-000000000001',
      receivedUnits: 2,
    },
  ],
  outboundRequestId: '30000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
};

const source: StoreReceiptSource = {
  id: declaration.outboundRequestId,
  requestNumber: 'OUT-2026-0001',
  storeId: declaration.storeId,
  dispatchedAt: '2026-09-17T08:00:00+07:00',
  lines: [
    {
      approvedUnits: 2,
      dispatchedUnits: 2,
      productId: declaration.lines[0]?.productId ?? '',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('receipt declaration confirmation', () => {
  it('preserves the draft when the API operation fails', async () => {
    const resetDraft = vi.fn();
    const declare = vi.fn(async () => false);

    await expect(confirmReceiptDeclaration(declaration, declare, resetDraft)).resolves.toBe(false);

    expect(declare).toHaveBeenCalledWith(declaration);
    expect(resetDraft).not.toHaveBeenCalled();
  });

  it('clears the draft only after the API confirms creation', async () => {
    const resetDraft = vi.fn();
    const declare = vi.fn(async () => true);

    await expect(confirmReceiptDeclaration(declaration, declare, resetDraft)).resolves.toBe(true);

    expect(resetDraft).toHaveBeenCalledOnce();
  });
});

describe('receipt source selection', () => {
  it('prefills server-owned product and approval facts with the dispatched quantity', () => {
    expect(receiptSourceDraftLines(source)).toEqual([
      {
        approvedUnits: 2,
        productId: declaration.lines[0]?.productId,
        receivedUnits: 2,
      },
    ]);
  });

  it('removes a declared outbound source without affecting other sources', () => {
    const another = {
      ...source,
      id: '30000000-0000-4000-8000-000000000002',
      requestNumber: 'OUT-2026-0002',
    };
    expect(removeDeclaredReceiptSource([source, another], source.id)).toEqual([another]);
  });

  it('loads validated sources from the authenticated API without a fallback', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [source],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listStoreReceiptSources({ storeId: source.storeId })).resolves.toEqual([source]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/store-receipt-sources?page=1&pageSize=100');
    expect(String(url)).toContain(`storeId=${source.storeId}`);
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('loads every dispatched source page instead of truncating after 100 rows', async () => {
    const second = {
      ...source,
      id: '30000000-0000-4000-8000-000000000002',
      requestNumber: 'OUT-2026-0002',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = String(input).includes('page=2') ? 2 : 1;
      return new Response(
        JSON.stringify({
          data: [page === 1 ? source : second],
          pagination: { page, pageSize: 100, totalItems: 101, totalPages: 2 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listStoreReceiptSources()).resolves.toEqual([source, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a network error instead of inventing receipt sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );

    await expect(listStoreReceiptSources()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });
});

describe('receiving store scope', () => {
  const wholesaleA = '20000000-0000-4000-8000-00000000000a';
  const wholesaleB = '20000000-0000-4000-8000-00000000000b';

  it('keeps a store account on its own store whatever is selected', () => {
    expect(resolveReceivingStoreId('STORE', 'own', [wholesaleA], wholesaleA)).toBe('own');
  });

  it('lets the wholesale desk receive for the wholesale store it picked', () => {
    expect(resolveReceivingStoreId('WHOLESALE', '', [wholesaleA, wholesaleB], wholesaleB)).toBe(
      wholesaleB,
    );
    // Nothing picked yet, or a store outside its reach: the first wholesale store.
    expect(resolveReceivingStoreId('WHOLESALE', '', [wholesaleA, wholesaleB], '')).toBe(wholesaleA);
    expect(resolveReceivingStoreId('WHOLESALE', '', [wholesaleA], 'retail-store')).toBe(wholesaleA);
    expect(resolveReceivingStoreId('WHOLESALE', '', [], '')).toBe('');
  });

  it('never makes a reviewer a receiver', () => {
    expect(resolveReceivingStoreId('HTKD', '', [wholesaleA], wholesaleA)).toBe('');
    expect(resolveReceivingStoreId('ADMIN', '', [wholesaleA], wholesaleA)).toBe('');
  });
});

describe('pending receipt count', () => {
  const render = (props: { count: number; error: boolean; pending: boolean }) =>
    renderToStaticMarkup(createElement(PendingSourceCount, props));

  it('shows the number of shipments waiting to be received, prominently', () => {
    const html = render({ count: 3, error: false, pending: false });
    expect(html).toContain('<strong class="receipt-source-count__value">3</strong>');
    expect(html).toContain('phiếu chờ nhận hàng');
    expect(html).toContain('receipt-source-count--active');
  });

  it('shows an explicit zero only once the server has answered', () => {
    const html = render({ count: 0, error: false, pending: false });
    expect(html).toContain('>0</strong>');
    expect(html).not.toContain('receipt-source-count--active');
  });

  it('never reads loading or a failed load as zero', () => {
    const loading = render({ count: 0, error: false, pending: true });
    expect(loading).toContain('Đang tải phiếu chờ nhận');
    expect(loading).not.toContain('receipt-source-count__value');
    const failed = render({ count: 4, error: true, pending: false });
    expect(failed).toContain('Chưa tải được phiếu chờ nhận');
    expect(failed).not.toContain('receipt-source-count__value');
  });
});

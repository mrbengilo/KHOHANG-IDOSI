import type { StoreInventoryBag } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { normalSalePendingKg, openBagNotice, ProductionOpenBagPage } from './InventoryOperations';
import { isOpenBagSelectionCurrent, OpenBagConfirmation } from './OpenBagConfirmation';

const bag: StoreInventoryBag = {
  id: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
  productId: '30000000-0000-4000-8000-000000000001',
  sourceReceiptBagId: '40000000-0000-4000-8000-000000000001',
  outboundOrderId: '50000000-0000-4000-8000-000000000001',
  sourceTransferId: null,
  sourceInventoryBagId: null,
  bagCode: 'MB-00001',
  originalWeightKg: '5.009',
  receivedWeightKg: '5.009',
  remainingWeightKg: '5.009',
  status: 'AVAILABLE',
  version: 2,
  receivedAt: '2026-09-17T01:00:00.000Z',
  updatedAt: '2026-09-17T01:00:00.000Z',
};

describe('open bag confirmation', () => {
  it('accepts only the current version owned by the signed-in store', () => {
    expect(isOpenBagSelectionCurrent(bag, bag, bag.storeId)).toBe(true);
    expect(isOpenBagSelectionCurrent(bag, bag, '')).toBe(false);
    expect(isOpenBagSelectionCurrent(bag, bag, 'another-store')).toBe(false);
    expect(isOpenBagSelectionCurrent(bag, undefined, bag.storeId)).toBe(false);
    for (const changed of [
      { ...bag, id: 'another-bag' },
      { ...bag, storeId: 'another-store' },
      { ...bag, version: 3 },
      { ...bag, remainingWeightKg: '4.009' },
      { ...bag, status: 'OPEN' as const },
      { ...bag, status: 'QUARANTINED' as const },
    ]) {
      expect(isOpenBagSelectionCurrent(bag, changed, bag.storeId)).toBe(false);
    }
  });

  it('previews unchanged exact weight without invoking the command during render', () => {
    const onConfirm = vi.fn();
    const html = renderToStaticMarkup(
      createElement(OpenBagConfirmation, {
        bag,
        busy: false,
        canConfirm: true,
        onCancel: vi.fn(),
        onConfirm,
      }),
    );
    expect(html.match(/5,01 kg/g)).toHaveLength(1);
    expect(html).toContain('MB-00001');
    expect(html).toContain('Chưa khui');
    expect(html).toContain('IDOSI đang chờ');
    expect(html).toContain('Khui 1 bao');
    expect(html).not.toContain('disabled=""');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('blocks stale confirmation and blocks cancellation while submitting', () => {
    const props = { bag, onCancel: vi.fn(), onConfirm: vi.fn() };
    const stale = renderToStaticMarkup(
      createElement(OpenBagConfirmation, { ...props, busy: false, canConfirm: false }),
    );
    expect(stale).toContain('role="alert"');
    expect(stale.match(/disabled=""/g)).toHaveLength(1);
    const pending = renderToStaticMarkup(
      createElement(OpenBagConfirmation, { ...props, busy: true, canConfirm: true }),
    );
    expect(pending.match(/disabled=""/g)).toHaveLength(2);
  });

  it('renders unopened cards with a separate empty history', () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(['session'], { principal: { storeId: bag.storeId } });
    client.setQueryData(['stores', 'accessible'], []);
    client.setQueryData(['catalog'], [{ id: bag.productId, name: 'Đầm' }]);
    client.setQueryData(['store-inventory-bags', 'unopened', { storeId: bag.storeId }, 1], {
      data: [bag],
      pagination: { totalItems: 1, totalPages: 1 },
    });
    client.setQueryData(['store-bag-openings', { storeId: bag.storeId }, {}, 1], {
      data: [],
      pagination: { totalItems: 0, totalPages: 0 },
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProductionOpenBagPage, { role: 'STORE', storeKind: 'RETAIL' }),
      ),
    );
    expect(html).toContain('Tất cả mặt hàng');
    expect(html).toContain('Đầm');
    expect(html).toContain('Bao chưa khui');
    expect(html).toContain('Lịch sử khui');
    expect(html).toContain('MB-00001');
    expect(html).not.toContain('Khui 1 bao');
    client.clear();
  });
});

describe('IDOSI regular-price sales on opening', () => {
  const women = '30000000-0000-4000-8000-000000000002';
  const pending = [
    { storeId: bag.storeId, productId: women, pendingWeightKg: '20.000' },
    { storeId: '20000000-0000-4000-8000-000000000009', productId: women, pendingWeightKg: '5.000' },
  ];

  it('shows the pending weight of the selected product in the selected store only', () => {
    expect(normalSalePendingKg(pending, women, bag.storeId)).toBe('20.000');
    expect(normalSalePendingKg(pending, women)).toBe('25.000');
    expect(normalSalePendingKg(pending, bag.productId, bag.storeId)).toBeNull();
  });

  it('says how much was taken on opening and what is left to sell or sort', () => {
    const before = { ...bag, remainingWeightKg: '50.000' };
    expect(openBagNotice(before, { ...before, status: 'OPEN' })).toContain(
      'tồn đang bán tăng 1 bao',
    );
    const notice = openBagNotice(before, {
      ...before,
      status: 'OPEN',
      remainingWeightKg: '30.000',
    });
    expect(notice).toContain('trừ 20 kg bán thường IDOSI');
    expect(notice).toContain('còn 30 kg để bán hoặc lọc');
  });
});

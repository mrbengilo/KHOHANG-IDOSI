import type { StoreInventoryBag } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProductionOpenBagPage } from './InventoryOperations';
import { isOpenBagSelectionCurrent, OpenBagConfirmation } from './OpenBagConfirmation';

const bag: StoreInventoryBag = {
  id: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
  productId: '30000000-0000-4000-8000-000000000001',
  sourceReceiptBagId: '40000000-0000-4000-8000-000000000001',
  outboundOrderId: '50000000-0000-4000-8000-000000000001',
  sourceTransferId: null,
  sourceInventoryBagId: null,
  bagCode: 'TEST-BAG-001',
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
    expect(html.match(/5,009 kg/g)).toHaveLength(2);
    expect(html).toContain('không phải tổng tồn cửa hàng');
    expect(html).toContain('Chưa khui');
    expect(html).toContain('Đang bán tại CH');
    expect(html).toContain('Xác nhận khui 1 bao');
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

  it('offers preview, not an immediate confirmation, on the initial store screen', () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(['session'], { principal: { storeId: bag.storeId } });
    client.setQueryData(['stores', 'accessible'], []);
    client.setQueryData(['store-inventory-bags', bag.storeId, 'AVAILABLE'], [bag]);
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProductionOpenBagPage, { role: 'STORE', storeKind: 'RETAIL' }),
      ),
    );
    expect(html).toContain('Xem trước khui');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Xác nhận khui');
    client.clear();
  });
});

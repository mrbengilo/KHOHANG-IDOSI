import type { Session } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { nextTabIndex } from '../../components/Tabs';
import { sessionQueryKey } from '../../lib/auth';
import { nextDraftIds } from '../../lib/draft-guard';
import { ProductionInventoryPage } from './InventoryOperations';

const adminSession: Session = {
  createdAt: '2026-09-25T00:00:00.000Z',
  expiresAt: '2026-09-26T00:00:00.000Z',
  id: '51000000-0000-4000-8000-000000000001',
  lastSeenAt: '2026-09-25T00:05:00.000Z',
  principal: {
    accountId: '50000000-0000-4000-8000-000000000001',
    assignedStoreIds: [],
    displayName: 'Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    storeId: null,
    username: 'admin',
  },
};

function render(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(sessionQueryKey, adminSession);
  client.setQueryData(['stores', 'accessible'], []);
  client.setQueryData(['catalog'], []);
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ProductionInventoryPage role="ADMIN" storeKind={null} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const keys = client
    .getQueryCache()
    .getAll()
    .map((query) => String(query.queryKey[0]));
  return { html, keys };
}

describe('admin inventory tabs', () => {
  it('renders an accessible tab bar with the three scopes and one panel for the open tab', () => {
    const { html } = render('/inventory?tab=adjustments');
    expect(html).toContain('role="tablist"');
    for (const label of ['Kho tổng', 'Kho cửa hàng', 'Phiếu sai lệch']) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toMatch(
      /aria-controls="inventory-panel-adjustments" aria-selected="true"[^>]*id="inventory-tab-adjustments"/u,
    );
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="inventory-tab-adjustments"');
    expect(html).toContain('<h1>Tồn kho &amp; lịch sử</h1>');
  });

  it('mounts only the store tab queries: no warehouse or discrepancy request, no ledger yet', () => {
    const { html, keys } = render('/inventory?tab=store');
    expect(html).toContain('Tồn cửa hàng');
    expect(html).toContain('Sổ phát sinh');
    expect(keys).toContain('store-inventory-bags');
    expect(keys).not.toContain('warehouse-inventory');
    expect(keys).not.toContain('warehouse-outbound-history');
    expect(keys).not.toContain('warehouse-shortage-checks');
    expect(keys.some((key) => key.startsWith('receipt-adjustment'))).toBe(false);
    expect(keys).not.toContain('store-inventory-ledger');
  });

  it('keeps the warehouse module lazy until its tab is opened', () => {
    const { keys } = render('/inventory');
    expect(keys).not.toContain('store-inventory-bags');
    expect(keys.some((key) => key.startsWith('receipt-adjustment'))).toBe(false);
  });
});

describe('tab keyboard support and draft bookkeeping', () => {
  it('moves focus with arrows (wrapping), Home and End', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 1, 3)).toBeNull();
  });

  it('tracks which forms hold a draft without churning when nothing changes', () => {
    const empty: ReadonlySet<string> = new Set();
    const one = nextDraftIds(empty, 'a', true);
    expect([...one]).toEqual(['a']);
    expect(nextDraftIds(one, 'a', true)).toBe(one);
    expect(nextDraftIds(one, 'a', false).size).toBe(0);
    expect(nextDraftIds(empty, 'b', false)).toBe(empty);
  });
});

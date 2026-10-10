import type { Session } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { AppOutletContext } from '../../components/AppShell';
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

function sessionFor(context: AppOutletContext): Session {
  if (context.role === 'ADMIN') return adminSession;
  return {
    ...adminSession,
    principal: {
      ...adminSession.principal,
      accountId: '50000000-0000-4000-8000-000000000009',
      role: context.role,
      storeId: context.role === 'STORE' ? '20000000-0000-4000-8000-00000000000a' : null,
      username: context.role.toLowerCase(),
    },
  };
}

function render(url: string, context: AppOutletContext = { role: 'ADMIN', storeKind: null }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(sessionQueryKey, sessionFor(context));
  client.setQueryData(['stores', 'accessible'], []);
  client.setQueryData(['catalog'], []);
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ProductionInventoryPage role={context.role} storeKind={context.storeKind} />
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

describe('read-only warehouse tab for store accounts and the wholesale desk', () => {
  const tabLabels = (html: string) =>
    [...html.matchAll(/id="inventory-tab-[a-z]+"[^>]*>([^<]+)<\/button>/gu)].map(
      (match) => match[1],
    );

  it('gives a retail store its own stock by default plus the warehouse, never discrepancy slips', () => {
    const { html, keys } = render('/inventory', { role: 'STORE', storeKind: 'RETAIL' });
    expect(tabLabels(html)).toEqual(['Kho tổng', 'Kho cửa hàng']);
    expect(html).toMatch(/aria-selected="true"[^>]*id="inventory-tab-store"/u);
    expect(keys).toContain('store-inventory-bags');
    expect(keys).not.toContain('warehouse-inventory');
    expect(html).toContain('<h1>Tồn kho &amp; lịch sử</h1>');
  });

  it('opens the warehouse tab for a store from the URL without mounting store queries', () => {
    const { html, keys } = render('/inventory?tab=warehouse', {
      role: 'STORE',
      storeKind: 'RETAIL',
    });
    expect(html).toMatch(/aria-selected="true"[^>]*id="inventory-tab-warehouse"/u);
    expect(keys).not.toContain('store-inventory-bags');
  });

  it('shows the wholesale desk only the warehouse, even for a store-stock deep link', () => {
    for (const context of [
      { role: 'WHOLESALE', storeKind: null },
      { role: 'STORE', storeKind: 'WHOLESALE' },
    ] as const) {
      const { html, keys } = render('/inventory?tab=store&ch=ledger', context);
      expect(tabLabels(html)).toEqual(['Kho tổng']);
      expect(html).toMatch(/aria-selected="true"[^>]*id="inventory-tab-warehouse"/u);
      expect(keys).not.toContain('store-inventory-bags');
      expect(keys.some((key) => key.startsWith('receipt-adjustment'))).toBe(false);
    }
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

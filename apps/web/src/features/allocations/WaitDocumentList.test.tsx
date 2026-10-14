import type {
  ListStoreWaitDocumentsResponse,
  StoreWaitDocument,
  StoreWaitDocumentDetail,
  StoreWaitDocumentEvent,
} from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { Role } from '../../lib/types';
import { waitDocumentKey } from './WaitDocumentDetail';
import { WaitDocumentList } from './WaitDocumentList';
import {
  clearWaitDocumentFilters,
  readOpenWaitDocument,
  readWaitDocumentFilters,
  readWaitTicketTabView,
  waitDocumentEventDescription,
  waitDocumentLabel,
  withWaitDocumentFilters,
  withWaitTicketTabView,
} from './waitDocumentNavigation';

const storeId = '20000000-0000-4000-8000-000000000001';
const nam = '30000000-0000-4000-8000-000000000001';
const nu = '30000000-0000-4000-8000-000000000002';
const tre = '30000000-0000-4000-8000-000000000003';
const ids = {
  b: '61000000-0000-4000-8000-000000000001',
  c: '61000000-0000-4000-8000-000000000002',
  d: '61000000-0000-4000-8000-000000000003',
};

const event = (overrides: Partial<StoreWaitDocumentEvent> = {}): StoreWaitDocumentEvent => ({
  id: '62000000-0000-4000-8000-000000000001',
  kind: 'ALLOCATION_RUN',
  occurredAt: '2026-10-14T02:00:00.000Z',
  actor: null,
  reason: null,
  session: { id: '10000000-0000-4000-8000-000000000001', code: 'PDH-000042' },
  allocationRunId: null,
  allocationDecisionId: null,
  reshareOrderCode: null,
  waitTicket: null,
  priorityOffer: null,
  storeReceipt: null,
  ...overrides,
});

const line = (
  productId: string,
  productName: string,
  values: Partial<StoreWaitDocument['lines'][number]>,
): StoreWaitDocument['lines'][number] => ({
  productId,
  sku: productName.toUpperCase(),
  productName,
  unit: 'BAG',
  carriedInQuantity: 0,
  addedQuantity: 0,
  openingRemainingQuantity: 0,
  openingPendingQuantity: 0,
  confirmedQuantity: null,
  cancelledQuantity: null,
  adjustedQuantity: null,
  carriedOutQuantity: null,
  remainingQuantity: null,
  pendingQuantity: null,
  ...values,
});

/** C of example B: 3 nam + 2 nữ + 3 trẻ em, 1 nam and 2 nữ granted and awaiting the answer. */
const currentC: StoreWaitDocument = {
  id: ids.c,
  code: 'PCT-000003',
  storeId,
  storeCode: 'CH01',
  storeName: 'Cửa hàng Một',
  status: 'CURRENT',
  version: 1,
  chainId: ids.b,
  chainSequence: 2,
  openedAt: '2026-10-14T02:00:00.000Z',
  closedAt: null,
  waitingSince: '2026-10-13T02:00:00.000Z',
  predecessor: { id: ids.b, code: 'PCT-000002' },
  successor: null,
  openedEvent: event(),
  closedEvent: null,
  lines: [
    line(nam, 'Nam', {
      carriedInQuantity: 2,
      addedQuantity: 1,
      openingRemainingQuantity: 3,
      remainingQuantity: 2,
      pendingQuantity: 1,
    }),
    line(nu, 'Nữ', {
      carriedInQuantity: 2,
      openingRemainingQuantity: 2,
      remainingQuantity: 0,
      pendingQuantity: 2,
    }),
    line(tre, 'Trẻ em', {
      addedQuantity: 3,
      openingRemainingQuantity: 3,
      remainingQuantity: 3,
      pendingQuantity: 0,
    }),
  ],
};

/** B of example A: handed 2 nam + 2 nữ to C. */
const mergedB: StoreWaitDocument = {
  ...currentC,
  id: ids.b,
  code: 'PCT-000002',
  status: 'MERGED',
  version: 2,
  chainSequence: 1,
  openedAt: '2026-10-13T02:00:00.000Z',
  closedAt: '2026-10-14T02:00:00.000Z',
  predecessor: null,
  successor: { id: ids.c, code: 'PCT-000003' },
  closedEvent: event(),
  lines: [
    line(nam, 'Nam', {
      addedQuantity: 2,
      openingRemainingQuantity: 2,
      confirmedQuantity: 0,
      cancelledQuantity: 0,
      adjustedQuantity: 0,
      carriedOutQuantity: 2,
    }),
    line(nu, 'Nữ', {
      addedQuantity: 2,
      openingRemainingQuantity: 2,
      confirmedQuantity: 0,
      cancelledQuantity: 0,
      adjustedQuantity: 0,
      carriedOutQuantity: 2,
    }),
  ],
};

const page = (data: StoreWaitDocument[]): ListStoreWaitDocumentsResponse => ({
  data,
  pagination: { page: 1, pageSize: 20, totalItems: data.length, totalPages: data.length ? 1 : 0 },
});

function render(
  url: string,
  role: Role,
  response?: ListStoreWaitDocumentsResponse,
  detail?: StoreWaitDocumentDetail,
) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const params = new URL(url, 'http://local').searchParams;
  if (response) {
    client.setQueryData(['wait-documents', 'account-1', readWaitDocumentFilters(params)], response);
  }
  if (detail) client.setQueryData(waitDocumentKey('account-1', detail.id), detail);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <WaitDocumentList
          accountKey="account-1"
          onOpenDecision={() => undefined}
          products={[]}
          role={role}
          stores={[
            { id: storeId, code: 'CH01', name: 'Cửa hàng Một' },
            { id: '20000000-0000-4000-8000-000000000002', code: 'CH02', name: 'Cửa hàng Hai' },
          ]}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('wait document navigation', () => {
  it('reads and writes the list filters in the URL, resetting the page', () => {
    const params = new URLSearchParams('tab=wait-tickets&wdView=HISTORY&wdStatus=MERGED&wdPage=3');
    expect(readWaitDocumentFilters(params)).toMatchObject({
      view: 'HISTORY',
      status: 'MERGED',
      page: 3,
    });
    const next = withWaitDocumentFilters(params, { q: 'PCT-000003' });
    expect(next.get('wdQ')).toBe('PCT-000003');
    expect(next.get('wdPage')).toBeNull();
    expect(next.get('tab')).toBe('wait-tickets');
    // The history status means nothing in the active view.
    const active = withWaitDocumentFilters(params, { view: 'ACTIVE' });
    expect(active.get('wdView')).toBeNull();
    expect(active.get('wdStatus')).toBeNull();
    expect(readWaitDocumentFilters(new URLSearchParams('wdStatus=MERGED')).status).toBe('');
    expect(clearWaitDocumentFilters(next).get('wdQ')).toBeNull();
    expect(clearWaitDocumentFilters(next).get('wdView')).toBe('HISTORY');
  });

  it('keeps deep links: an opened document, and old PC links opening the line list', () => {
    expect(readOpenWaitDocument(new URLSearchParams(`wdOpen=${ids.c}`))).toBe(ids.c);
    expect(readOpenWaitDocument(new URLSearchParams('wdOpen=not-an-id'))).toBeNull();
    expect(readWaitTicketTabView(new URLSearchParams('tab=wait-tickets'))).toBe('documents');
    expect(readWaitTicketTabView(new URLSearchParams('tab=wait-tickets&wt.q=PC-0000012'))).toBe(
      'lines',
    );
    const back = withWaitTicketTabView(
      new URLSearchParams('waitView=lines&wt.q=PC-1'),
      'documents',
    );
    expect([...back.keys()]).toEqual([]);
  });

  it('names the successor in the processed tag and describes events from data', () => {
    expect(waitDocumentLabel(mergedB)).toBe('Đã xử lý · Gộp vào phiếu PCT-000003');
    expect(
      waitDocumentLabel({ status: 'ROLLED_OVER', successor: { id: ids.d, code: 'PCT-000004' } }),
    ).toBe('Đã xử lý · Chuyển phần còn lại sang phiếu PCT-000004');
    expect(waitDocumentLabel({ status: 'COMPLETED', successor: null })).toBe('Đã xử lý xong');
    expect(
      waitDocumentEventDescription(
        event({ kind: 'RESULT_ACCEPTED', reshareOrderCode: 'RE-000012' }),
      ),
    ).toBe('Xác nhận phân bổ kết quả phiên PDH-000042 · đơn RE-000012');
    expect(
      waitDocumentEventDescription(event({ kind: 'WAIT_DOCUMENT_CANCELLED', reason: 'Không cần' })),
    ).toBe('Hủy phiếu chờ · lý do: Không cần');
  });
});

describe('wait document list', () => {
  it('shows the current document with waiting and awaiting-answer bags, no zero waiting rows', () => {
    const html = render('/allocations?tab=wait-tickets', 'STORE', page([currentC]));
    expect(html).toContain('Phiếu chờ PCT-000003');
    expect(html).toContain('Đang hoạt động');
    expect(html).toContain('Còn chờ phân bổ · có hàng chờ xác nhận');
    expect(html).toContain('còn chờ 5 bao · chờ xác nhận 3 bao');
    expect(html).toContain('Từ phiếu PCT-000002');
    // A store account sees its own store only: no store column, no store filter.
    expect(html).not.toContain('Cửa hàng Hai');
    expect(html).not.toContain(' · Cửa hàng Một</span>');
  });

  it('keeps every product in the processed history with the exact tag', () => {
    const html = render('/allocations?tab=wait-tickets&wdView=HISTORY', 'ADMIN', page([mergedB]));
    expect(html).toContain('Đã xử lý · Gộp vào phiếu PCT-000003');
    expect(html).toContain('Nam');
    expect(html).toContain('Nữ');
    expect(html).toContain('Chuyển tiếp');
    expect(html).toContain('Cửa hàng Hai');
  });

  it('separates loading, empty and filtered-empty states', () => {
    expect(render('/allocations?tab=wait-tickets', 'STORE')).toContain('Đang tải phiếu chờ');
    expect(render('/allocations?tab=wait-tickets', 'STORE', page([]))).toContain(
      'Không có phiếu chờ đang hoạt động',
    );
    expect(render('/allocations?tab=wait-tickets&wdQ=PCT-9', 'STORE', page([]))).toContain(
      'Không có phiếu nào khớp bộ lọc',
    );
  });

  it('opens a processed document with its chain, the current document and frozen numbers', () => {
    const detail: StoreWaitDocumentDetail = {
      ...mergedB,
      members: [],
      pendingResults: [],
      chain: [
        {
          id: ids.b,
          code: 'PCT-000002',
          status: 'MERGED',
          chainSequence: 1,
          openedAt: mergedB.openedAt,
          closedAt: mergedB.closedAt,
          openedEventKind: 'ALLOCATION_RUN',
          closedEventKind: 'ALLOCATION_RUN',
        },
        {
          id: ids.c,
          code: 'PCT-000003',
          status: 'CURRENT',
          chainSequence: 2,
          openedAt: currentC.openedAt,
          closedAt: null,
          openedEventKind: 'ALLOCATION_RUN',
          closedEventKind: null,
        },
      ],
      currentDocument: { id: ids.c, code: 'PCT-000003' },
    };
    const html = render(
      `/allocations?tab=wait-tickets&wdView=HISTORY&wdOpen=${ids.b}`,
      'HTKD',
      page([mergedB]),
      detail,
    );
    expect(html).toContain('Phần còn chờ của cửa hàng nằm ở phiếu hiện hành');
    expect(html).toContain('Sang phiếu PCT-000003');
    expect(html).toContain('Dòng thời gian phiếu');
    expect(html).toContain('aria-current="true"');
    // A processed document can no longer be cancelled.
    expect(html).not.toContain('>Hủy phiếu chờ<');
  });
});

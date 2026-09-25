import type {
  ReceiptAdjustment,
  ReceiptAdjustmentListItem,
  ReceiptAdjustmentStatus,
} from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { readInventoryNavigation } from '../../inventory/inventoryNavigation';
import { AdminAdjustmentWorkspace, describeAdjustmentFilters } from './AdminAdjustmentWorkspace';

const adjustmentId = '10000000-0000-4000-8000-000000000001';
const receiptId = '30000000-0000-4000-8000-000000000001';
const storeId = '20000000-0000-4000-8000-000000000001';
const storeAccount = '50000000-0000-4000-8000-000000000001';
const htkdAccount = '50000000-0000-4000-8000-000000000002';
const adminAccount = '50000000-0000-4000-8000-000000000003';
const dress = '40000000-0000-4000-8000-000000000001';
const jeans = '40000000-0000-4000-8000-000000000002';

function listItem(
  status: ReceiptAdjustmentStatus,
  overrides: Partial<ReceiptAdjustmentListItem> = {},
): ReceiptAdjustmentListItem {
  const decided = status === 'APPLIED' || status === 'REJECTED' || status === 'CANCELLED';
  return {
    id: adjustmentId,
    code: 'PSL-000001',
    receiptId,
    receiptNumber: 'PNH-000001',
    storeId,
    storeCode: 'Q1',
    storeName: 'Cửa hàng Quận 1',
    status,
    version: decided ? 2 : 1,
    reason: 'Khui bao thấy 1 bao là jeans',
    cause: 'SOURCE_MISCLASSIFICATION',
    lineCount: 1,
    shortageQuantity: 1,
    goodsDeltaVnd: -200_000,
    reportedBy: { accountId: storeAccount, displayName: 'Cửa hàng Q1', username: 'store.q1' },
    reportedAt: '2026-09-25T01:00:00.000Z',
    verifiedBy: { accountId: htkdAccount, displayName: 'HTKD Lan', username: 'htkd.lan' },
    verifiedAt: '2026-09-25T02:00:00.000Z',
    decidedBy: decided
      ? { accountId: adminAccount, displayName: 'Admin Minh', username: 'admin.minh' }
      : null,
    decidedAt: decided ? '2026-09-25T03:00:00.000Z' : null,
    decisionNote: decided ? 'Đồng ý điều chỉnh' : null,
    appliedAt: status === 'APPLIED' ? '2026-09-25T03:00:00.000Z' : null,
    updatedAt: '2026-09-25T03:00:00.000Z',
    ...overrides,
  };
}

const money = {
  goodsVnd: 3_000_000,
  freightVnd: 0,
  handlingVnd: 0,
  costVnd: 3_000_000,
  vatVnd: 0,
  totalVnd: 3_000_000,
};

function detail(
  status: ReceiptAdjustmentStatus,
  allowedActions: ReceiptAdjustment['allowedActions'],
): ReceiptAdjustment {
  const item = listItem(status);
  return {
    id: item.id,
    code: item.code,
    receiptId,
    receiptNumber: item.receiptNumber,
    receiptFinalizedAt: '2026-09-20T01:00:00.000Z',
    storeId,
    status,
    version: item.version,
    reason: item.reason,
    evidenceNote: 'Ảnh gửi nhóm HTKD',
    discoveredAt: '2026-09-25T00:30:00.000Z',
    cause: 'SOURCE_MISCLASSIFICATION',
    appliedSequence: status === 'APPLIED' ? 1 : null,
    delta: { goodsVnd: -200_000, freightVnd: 0, handlingVnd: 0, vatVnd: 0 },
    money: {
      original: money,
      before: money,
      after: { ...money, goodsVnd: 2_800_000, costVnd: 2_800_000, totalVnd: 2_800_000 },
    },
    reportedByAccountId: storeAccount,
    reportedBy: item.reportedBy,
    reportedAt: item.reportedAt,
    verifiedByAccountId: htkdAccount,
    verifiedBy: item.verifiedBy,
    verifiedAt: item.verifiedAt,
    verificationNote: 'Đã đối chiếu ảnh',
    infoRequestNote: null,
    decidedByAccountId: item.decidedBy?.accountId ?? null,
    decidedBy: item.decidedBy,
    decidedAt: item.decidedAt,
    decisionNote: item.decisionNote,
    appliedAt: item.appliedAt,
    createdAt: item.reportedAt,
    updatedAt: item.updatedAt,
    allowedActions,
    lines: [
      {
        id: '60000000-0000-4000-8000-000000000001',
        receiptBagId: '61000000-0000-4000-8000-000000000001',
        receiptBagNumber: 1,
        inventoryBagId: '62000000-0000-4000-8000-000000000001',
        bagDisplayCode: 'Q1-DAM-001',
        bagStatus: status === 'APPLIED' ? 'AVAILABLE' : 'QUARANTINED',
        bagCurrentWeightKg: '20.000',
        approvedProductId: dress,
        recordedProductId: dress,
        actualProductId: jeans,
        disposition: 'KEEP',
        recordedWeightKg: '20.000',
        recordedPricePerKgVnd: 50_000,
        recordedCostVnd: 1_000_000,
        verifiedWeightKg: '20.000',
        verifiedPricePerKgVnd: 40_000,
        verifiedCostVnd: 800_000,
        weightChangeNote: null,
        shortageQuantity: 1,
        holdState: status === 'APPLIED' ? 'RELEASED' : 'HELD',
        blockers: [],
        entitlement: null,
        returns: [],
      },
    ],
  };
}

function render(url: string, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['stores', 'accessible'], []);
  client.setQueryData(
    ['catalog'],
    [
      { id: dress, name: 'Đầm', status: 'ACTIVE' },
      { id: jeans, name: 'Jeans', status: 'ACTIVE' },
    ],
  );
  seed(client);
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <AdminAdjustmentWorkspace />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { client, html };
}

function listKey(url: string) {
  const filters = readInventoryNavigation(
    new URL(url, 'http://localhost').searchParams,
  ).adjustments;
  return [
    'receipt-adjustments',
    'admin',
    filters.status,
    filters.storeId,
    filters.q,
    filters.dateField,
    filters.from,
    filters.to,
    filters.page,
  ];
}

describe('admin discrepancy workspace', () => {
  it('opens on documents HTKD sent to the admin, with store, people and a draft delta', () => {
    const url = '/inventory?tab=adjustments';
    const { html } = render(url, (client) =>
      client.setQueryData(listKey(url), {
        data: [listItem('PENDING_ADMIN')],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }),
    );
    expect(html).toContain('Đang xem: Chờ Admin duyệt · Mọi cửa hàng · 1 hồ sơ');
    expect(html).toContain('PSL-000001');
    expect(html).toContain('Phiếu nhận PNH-000001');
    expect(html).toContain('Q1 · Cửa hàng Quận 1');
    expect(html).toContain('Cửa hàng Q1');
    expect(html).toContain('HTKD Lan');
    expect(html).toContain('Tạm tính, chưa hiệu lực');
    expect(html).toContain('Chờ Admin duyệt');
    // The list never asks for each document's detail.
    expect(html).not.toContain('Chi tiết hồ sơ sai lệch');
  });

  it('shows a processed document as "Đã xử lý" with who decided, and its detail without actions', () => {
    const url = `/inventory?tab=adjustments&psl.status=APPLIED&psl.open=${adjustmentId}`;
    const { client, html } = render(url, (seeded) => {
      seeded.setQueryData(listKey(url), {
        data: [listItem('APPLIED')],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      });
      seeded.setQueryData(['receipt-adjustment', adjustmentId], detail('APPLIED', []));
    });
    expect(html).toContain('Đang xem: Đã xử lý');
    expect(html.match(/Đã xử lý/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('Admin Minh');
    expect(html).toContain('Đồng ý điều chỉnh');
    expect(html).toContain('Đã có hiệu lực');
    expect(html).toContain('Chi tiết hồ sơ sai lệch');
    expect(html).toContain('Lịch sử xử lý');
    expect(html).not.toContain('Duyệt và áp dụng');
    expect(html).not.toContain('Đã áp dụng');
    // The admin never resubmits, so the receipt's bag context query stays disabled.
    const context = client
      .getQueryCache()
      .find({ queryKey: ['receipt-adjustment-context', receiptId] });
    expect(context?.isDisabled() ?? true).toBe(true);
  });

  it('offers the admin the apply action only on a verified document', () => {
    const url = `/inventory?tab=adjustments&psl.open=${adjustmentId}`;
    const { html } = render(url, (client) => {
      client.setQueryData(listKey(url), {
        data: [listItem('PENDING_ADMIN')],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      });
      client.setQueryData(
        ['receipt-adjustment', adjustmentId],
        detail('PENDING_ADMIN', ['REQUEST_INFO', 'RETURN_TO_VERIFIER', 'REJECT', 'APPLY']),
      );
    });
    expect(html).toContain('Duyệt và áp dụng');
    expect(html).toContain('Trả HTKD xác minh lại');
    expect(html).toContain('Sau điều chỉnh (tạm tính, chưa hiệu lực)');
  });

  it('shows an empty slice as empty and a failed first load as an error, never mixed up', () => {
    const url = '/inventory?tab=adjustments&psl.status=ALL&psl.q=PSL-9';
    const empty = render(url, (client) =>
      client.setQueryData(listKey(url), {
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
    ).html;
    expect(empty).toContain('Không có phiếu sai lệch');
    expect(empty).toContain('Tất cả trạng thái · Mọi cửa hàng · mã chứa “PSL-9”');
    const loading = render('/inventory?tab=adjustments', () => undefined).html;
    expect(loading).not.toContain('Không có phiếu sai lệch');
    expect(loading).toContain('Đang tải dữ liệu');
  });

  it('describes the active filters in words', () => {
    expect(
      describeAdjustmentFilters(
        {
          status: 'REJECTED',
          storeId,
          q: '',
          dateField: 'DECIDED',
          from: '2026-09-01',
          to: '',
          page: 1,
        },
        'Q1 · Quận 1',
      ),
    ).toBe('Bị từ chối · Q1 · Quận 1 · Ngày xử lý 2026-09-01 → …');
  });
});

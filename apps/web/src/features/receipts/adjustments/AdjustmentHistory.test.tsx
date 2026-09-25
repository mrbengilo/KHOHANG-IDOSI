import type { ReceiptAdjustmentHistoryEvent } from '@idosi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdjustmentHistory, formatEventTime, historyFacts } from './AdjustmentHistory';

const adjustmentId = '10000000-0000-4000-8000-000000000001';
const storeId = '20000000-0000-4000-8000-000000000001';

const noChanges: ReceiptAdjustmentHistoryEvent['changes'] = {
  reason: null,
  evidenceNote: null,
  cause: null,
  lineCount: null,
  goodsDeltaVnd: null,
  freightDeltaVnd: null,
  handlingDeltaVnd: null,
  vatDeltaVnd: null,
  totalBeforeVnd: null,
  totalAfterVnd: null,
  costBeforeVnd: null,
  costAfterVnd: null,
  appliedSequence: null,
  releasedBagCount: null,
  returnCount: null,
  entitlementCount: null,
};

function event(
  index: number,
  overrides: Partial<ReceiptAdjustmentHistoryEvent>,
): ReceiptAdjustmentHistoryEvent {
  return {
    id: `70000000-0000-4000-8000-00000000000${index}`,
    occurredAt: `2026-09-25T0${index}:00:00.000Z`,
    type: 'REPORTED',
    action: 'RECEIPT_ADJUSTMENT_REPORTED',
    subject: 'ADJUSTMENT',
    returnCode: null,
    actor: {
      accountId: '50000000-0000-4000-8000-000000000001',
      displayName: 'Cửa hàng Q1',
      username: 'store.q1',
      role: 'STORE',
    },
    store: { storeId, code: 'Q1', name: 'Cửa hàng Quận 1' },
    statusBefore: null,
    statusAfter: 'PENDING_HTKD',
    note: null,
    changes: noChanges,
    ...overrides,
  };
}

const timeline: ReceiptAdjustmentHistoryEvent[] = [
  event(1, { changes: { ...noChanges, reason: 'Bao là jeans', lineCount: 1 } }),
  event(2, {
    type: 'VERIFIED',
    action: 'RECEIPT_ADJUSTMENT_VERIFIED',
    actor: {
      accountId: '50000000-0000-4000-8000-000000000002',
      displayName: 'HTKD Lan',
      username: 'htkd.lan',
      role: 'HTKD',
    },
    statusBefore: 'PENDING_HTKD',
    statusAfter: 'PENDING_ADMIN',
    note: 'Đã đối chiếu ảnh',
    changes: {
      ...noChanges,
      cause: 'SOURCE_MISCLASSIFICATION',
      goodsDeltaVnd: -200_000,
      freightDeltaVnd: 0,
      totalBeforeVnd: 3_000_000,
      totalAfterVnd: 2_800_000,
    },
  }),
  event(3, {
    type: 'APPLIED',
    action: 'RECEIPT_ADJUSTMENT_APPLIED',
    actor: {
      accountId: '50000000-0000-4000-8000-000000000003',
      displayName: 'Admin Minh',
      username: 'admin.minh',
      role: 'ADMIN',
    },
    statusBefore: 'PENDING_ADMIN',
    statusAfter: 'APPLIED',
    note: 'Đồng ý',
    changes: { ...noChanges, appliedSequence: 1, entitlementCount: 1, returnCount: 0 },
  }),
  // A legacy row: nobody, no status, nothing recorded.
  event(4, {
    type: 'OTHER',
    action: 'LEGACY_ACTION',
    actor: { accountId: null, displayName: null, username: null, role: null },
    store: { storeId: null, code: null, name: null },
    statusAfter: null,
  }),
];

function render(page: { data: ReceiptAdjustmentHistoryEvent[]; totalItems: number }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['receipt-adjustment-history', adjustmentId, 1], {
    data: page.data,
    pagination: {
      page: 1,
      pageSize: 20,
      totalItems: page.totalItems,
      totalPages: Math.ceil(page.totalItems / 20),
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdjustmentHistory adjustmentId={adjustmentId} />
    </QueryClientProvider>,
  );
}

describe('adjustment history timeline', () => {
  it('lists events oldest first with actor, role at the time, store, states and note', () => {
    const html = render({ data: timeline, totalItems: 4 });
    const order = ['Cửa hàng báo sai lệch', 'Xác minh, gửi Admin duyệt', 'Admin duyệt và áp dụng'];
    const positions = order.map((label) => html.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('HTKD Lan · HTKD · Q1 · Cửa hàng Quận 1');
    expect(html).toContain('Admin Minh · Admin');
    expect(html).toContain('Ghi chú: Đồng ý');
    expect(html).toContain('Đã xử lý');
    expect(html).toContain('Tạo mới');
  });

  it('never invents a missing actor, state or note on legacy rows', () => {
    const html = render({ data: [timeline[3]!], totalItems: 1 });
    expect(html).toContain('Thao tác khác (LEGACY_ACTION)');
    expect(html).toContain('Chưa ghi nhận · Vai trò chưa ghi nhận · Chưa ghi nhận');
    expect(html).toContain('Ghi chú: Chưa ghi nhận');
  });

  it('pages long histories on the server instead of cutting them', () => {
    const html = render({ data: timeline, totalItems: 45 });
    expect(html).toContain('Trang 1/3 · 45 sự kiện');
    expect(html).toContain('Sự kiện sau');
  });

  it('summarizes only what the event recorded', () => {
    expect(historyFacts(timeline[1]!)).toEqual([
      'Nguyên nhân: Phân loại sai từ nguồn nhập',
      'Chênh lệch tiền hàng −200.000 ₫',
      'Tổng 3.000.000 ₫ → 2.800.000 ₫',
    ]);
    expect(historyFacts(timeline[2]!)).toEqual(['Điều chỉnh thứ 1', '1 quyền chờ bù P0B']);
    expect(historyFacts(timeline[3]!)).toEqual([]);
  });

  it('prints event times in Vietnam time', () => {
    expect(formatEventTime('2026-09-24T17:30:05.000Z')).toContain('25/09/2026');
    expect(formatEventTime('2026-09-24T17:30:05.000Z')).toContain('00:30:05');
  });
});

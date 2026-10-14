import type { ReshareOrderHistoryRow, ReshareStatusHistoryEvent } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { businessDayEnd, businessDayStart } from './ReshareOrdersPanel';
import { ReshareOrderHistoryTable, reshareStatusNote } from './ReshareOrderHistoryTable';
import { historyActorName, historyContent } from './ReshareStatusHistory';

const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(overrides: Partial<ReshareOrderHistoryRow> = {}): ReshareOrderHistoryRow {
  return {
    decisionId: id(1),
    decisionStatus: 'ACCEPTED',
    sessionId: id(2),
    sessionCode: 'PDH-000010',
    businessDate: '2026-10-13',
    runVersion: 1,
    sessionOpenedAt: '2026-10-12T17:00:00.000Z',
    allocationCompletedAt: '2026-10-13T02:00:05.000Z',
    publishedAt: '2026-10-13T02:00:05.000Z',
    acceptedAt: '2026-10-13T02:20:00.000Z',
    acceptedByName: 'Cửa hàng A',
    storeId: id(3),
    storeName: 'Cửa hàng A có tên rất dài ở trung tâm thành phố',
    status: 'ORDERED',
    order: {
      id: id(4),
      code: 'RE-000001',
      orderedAt: '2026-10-13T02:20:00.000Z',
      origin: 'ACCEPTANCE',
      actorName: 'Cửa hàng A',
      actorRole: 'STORE',
      cancelledAt: null,
      cancelReason: null,
    },
    lines: [
      { productId: id(5), productName: 'Quần dài nữ', productSku: 'QDN', quantity: 2 },
      { productId: id(6), productName: 'Áo', productSku: 'AO', quantity: 3 },
    ],
    totalQuantity: 5,
    delivery: {
      issuedQuantity: 5,
      receivedQuantity: 0,
      shortageQuantity: 0,
      awaitingReceiptQuantity: 5,
      onShipmentQuantity: 5,
    },
    ...overrides,
  };
}

function render(rows: readonly ReshareOrderHistoryRow[]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReshareOrderHistoryTable caption="Lịch sử" rows={rows} />
    </MemoryRouter>,
  );
}

describe('RE order history table', () => {
  it('shows one order with one line per product and its total once', () => {
    const html = render([row()]);
    const table = html;
    expect(table.match(/RE-000001/gu)).toHaveLength(1);
    expect(table).toContain('rowSpan="2"');
    expect(table).toContain('Quần dài nữ');
    expect(table).toContain('Áo');
    // The order total appears once (5), never 10.
    expect(table).toContain('<strong>5</strong>');
    expect(table).not.toContain('>10<');
    expect(html).toContain('Đã đặt Reshare');
    // Only the store name, never its code.
    expect(html).toContain('Cửa hàng A có tên rất dài ở trung tâm thành phố');
    // Full Vietnam time to the second, independent of the browser zone.
    expect(html).toContain('Mở phiên: 00:00:00 13/10/2026');
    expect(html).toContain('Hoàn tất phân bổ: 09:00:05 13/10/2026');
  });

  it('shows a pending result as not ordered, without a fabricated code', () => {
    const pending = row({
      decisionStatus: 'PENDING',
      status: 'NOT_ORDERED',
      order: null,
      delivery: null,
      acceptedAt: null,
    });
    const html = render([pending]);
    expect(html).toContain('Chưa đặt Reshare');
    expect(html).not.toContain('RE-0');
    expect(reshareStatusNote(pending)).toBe('Chờ cửa hàng/HTKD xác nhận kết quả phân bổ.');
  });

  it('keeps delivery facts apart from the order status', () => {
    expect(reshareStatusNote(row())).toContain('Đã xuất kho 5 bao');
    expect(reshareStatusNote(row())).toContain('chờ nhận 5');
    expect(
      reshareStatusNote(
        row({
          delivery: {
            issuedQuantity: 4,
            receivedQuantity: 3,
            shortageQuantity: 1,
            awaitingReceiptQuantity: 0,
            onShipmentQuantity: 0,
          },
        }),
      ),
    ).toContain('thiếu 1 đang xử lý');
  });

  it('names the real last editor and role, never a hard-coded Admin, and hides SKUs', () => {
    const edited = row({
      statusControl: {
        version: 2,
        updatedAt: '2026-10-13T03:00:00.000Z',
        updatedByName: 'Nguyễn HTKD',
        updatedByRole: 'HTKD',
      },
    });
    expect(reshareStatusNote(edited)).toContain(
      'Cập nhật lần cuối bởi Nguyễn HTKD (HTKD) lúc 10:00:00 13/10/2026.',
    );
    expect(reshareStatusNote(edited)).not.toContain('Admin Nguyễn');
    const html = render([edited]);
    expect(html).not.toContain('QDN');
    expect(html).not.toContain('>AO<');
  });

  it('describes history events from what was recorded, without guessing', () => {
    const base: ReshareStatusHistoryEvent = {
      id: id(9),
      occurredAt: '2026-10-13T03:00:00.000Z',
      kind: 'STATUS_CHANGED',
      source: 'MANUAL',
      statusBefore: 'NOT_ORDERED',
      statusAfter: 'ORDERED',
      version: 1,
      orderCode: 'RE-000001',
      actor: { accountId: id(8), role: 'HTKD', nameAtEvent: 'HTKD lúc đó', currentName: null },
      requestId: 'req-1',
    };
    expect(historyActorName(base)).toBe('HTKD lúc đó');
    expect(
      historyActorName({
        ...base,
        actor: { ...base.actor, nameAtEvent: null, currentName: 'Tên mới' },
      }),
    ).toBe('Tên mới (tên hiện tại)');
    expect(
      historyActorName({
        ...base,
        actor: { accountId: null, role: null, nameAtEvent: null, currentName: null },
      }),
    ).toBe('Hệ thống');
    expect(historyContent(base)).toBe('Cập nhật trạng thái đặt Reshare (lần 1)');
    expect(historyContent({ ...base, kind: 'CREATED', source: 'ACCEPTANCE' })).toBe(
      'Tạo đơn RE-000001 khi chấp nhận kết quả phân bổ',
    );
    expect(historyContent({ ...base, kind: 'CREATED', source: 'BACKFILL' })).toBe(
      'Tạo đơn RE-000001 khi chuyển đổi dữ liệu cũ',
    );
  });

  it('converts business-day filters to Vietnam instants', () => {
    expect(businessDayStart('2026-10-13')).toBe('2026-10-12T17:00:00.000Z');
    expect(businessDayEnd('2026-10-13')).toBe('2026-10-13T17:00:00.000Z');
  });
});

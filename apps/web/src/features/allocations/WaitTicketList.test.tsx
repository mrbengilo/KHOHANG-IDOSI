import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitTicketSchema } from '@idosi/contracts';
import { WaitTicketTable, waitTicketTime } from './WaitTicketTable';
import {
  readWaitTicketListNavigation,
  withWaitTicketListNavigation,
} from './waitTicketListNavigation';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('admin wait ticket list', () => {
  it('keeps independent URL filters, defaults to all statuses and validates dates', () => {
    const params = new URLSearchParams(
      'tab=wait-tickets&history.q=keep&wt.page=3&wt.status=CANCELLED',
    );
    expect(readWaitTicketListNavigation(params)).toMatchObject({ page: 3, status: 'CANCELLED' });
    const next = withWaitTicketListNavigation(params, { q: 'PUT-000001' });
    expect(next.get('history.q')).toBe('keep');
    expect(next.has('wt.page')).toBe(false);
    expect(readWaitTicketListNavigation(new URLSearchParams())).not.toHaveProperty('status');
    expect(
      readWaitTicketListNavigation(new URLSearchParams('wt.createdFrom=2026-02-30')).page,
    ).toBe(1);
  });
  it('renders nine columns, page ordinal, cancelled quantity and honest legacy reason', () => {
    const ticket = WaitTicketSchema.parse({
      id: id(1),
      code: 'PC-0000001',
      sessionId: id(2),
      mergedOrderId: null,
      storeId: id(3),
      productId: id(4),
      priority: 'P0B',
      requested: { kind: 'UNIT', quantity: 5 },
      fulfilled: { kind: 'UNIT', quantity: 2 },
      remaining: { kind: 'UNIT', quantity: 3 },
      status: 'CANCELLED',
      createdAt: '2026-10-05T17:00:00Z',
      updatedAt: '2026-10-05T17:00:00Z',
    });
    const html = renderToStaticMarkup(
      <WaitTicketTable tickets={[ticket]} offset={20} onHistory={() => {}} onCancel={() => {}} />,
    );
    expect(html.match(/<th>/g)).toHaveLength(9);
    expect(html).toContain('<td>21</td>');
    expect(html).toContain('Đã bị hủy');
    expect(html).toContain('Dữ liệu cũ chưa ghi nhận lý do hủy');
    expect(html).toContain('Chưa phát sinh phiếu ưu tiên');
    expect(html).toContain('3 bao');
    expect(html).not.toContain('Hủy phiếu chờ</span>');
    expect(html).toContain('06/10/2026 00:00:00');
    expect(waitTicketTime('2026-10-05T16:59:59Z')).toBe('05/10/2026 23:59:59');
  });
});

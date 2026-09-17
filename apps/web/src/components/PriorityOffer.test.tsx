import type { PriorityOffer as PriorityOfferRecord } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PriorityOffer } from './PriorityOffer';

const offer: PriorityOfferRecord = {
  accepted: null,
  expiresAt: '2099-09-17T01:00:00.000Z',
  id: '71000000-0000-4000-8000-000000000001',
  offered: { kind: 'UNIT', quantity: 3 },
  offeredAt: '2026-09-17T00:05:00.000Z',
  productId: '40000000-0000-4000-8000-000000000001',
  respondedAt: null,
  status: 'PENDING',
  storeId: '20000000-0000-4000-8000-000000000001',
  waitTicketId: '70000000-0000-4000-8000-000000000001',
};

describe('controlled priority offer', () => {
  it('shows response controls only for the target store experience', () => {
    const html = renderToStaticMarkup(
      <PriorityOffer
        busyAction={null}
        canRespond
        error={null}
        offer={offer}
        onExpired={vi.fn()}
        onOpenTicket={vi.fn()}
        onRespond={vi.fn()}
        productName="Đồ nam"
      />,
    );

    expect(html).toContain('Nhận đủ');
    expect(html).toContain('Từ chối');
    expect(html).toContain('Mở phiếu');
  });

  it('keeps ADMIN and HTKD oversight read-only', () => {
    const html = renderToStaticMarkup(
      <PriorityOffer
        busyAction={null}
        canRespond={false}
        error={null}
        offer={offer}
        onExpired={vi.fn()}
        onOpenTicket={vi.fn()}
        onRespond={vi.fn()}
        productName="Đồ nam"
      />,
    );

    expect(html).not.toContain('Nhận đủ');
    expect(html).not.toContain('Từ chối');
    expect(html).toContain('Mở phiếu');
  });

  it('keeps response controls visible but disabled while another mutation is running', () => {
    const html = renderToStaticMarkup(
      <PriorityOffer
        busyAction={null}
        canRespond
        error={null}
        interactionDisabled
        offer={offer}
        onExpired={vi.fn()}
        onOpenTicket={vi.fn()}
        onRespond={vi.fn()}
        productName="Đồ nam"
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Nhận đủ/s);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Từ chối/s);
    expect(html).toContain('Mở phiếu');
  });

  it('turns an elapsed pending offer into a non-actionable expiry state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'));
    try {
      const html = renderToStaticMarkup(
        <PriorityOffer
          busyAction={null}
          canRespond
          error={null}
          offer={offer}
          onExpired={vi.fn()}
          onOpenTicket={vi.fn()}
          onRespond={vi.fn()}
          productName="Đồ nam"
        />,
      );

      expect(html).toContain('Lượt ưu tiên đã hết hạn');
      expect(html).toContain('00:00');
      expect(html).not.toContain('Nhận đủ</span>');
      expect(html).not.toContain('Từ chối</span>');
    } finally {
      vi.useRealTimers();
    }
  });
});

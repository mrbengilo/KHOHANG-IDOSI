import { StoreBagOpeningSchema, StoreInventoryBagStatusSchema } from '@idosi/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BagOpeningHistoryTable, formatOpeningTime } from './BagOpeningHistoryTable';

const row = StoreBagOpeningSchema.parse({
  id: '10000000-0000-4000-8000-000000000001',
  bagId: '20000000-0000-4000-8000-000000000001',
  storeId: '30000000-0000-4000-8000-000000000001',
  productId: null,
  bagCode: 'MB-00003',
  weightBeforeKg: '60.125',
  weightAfterKg: '5.000',
  normalSaleAppliedKg: '55.125',
  actorAccountId: '40000000-0000-4000-8000-000000000001',
  actorDisplayName: 'NGUYỄN DUY THÀNH VỚI TÊN RẤT DÀI',
  actorRole: 'HTKD',
  openedAt: '2026-09-25T09:00:23Z',
  source: 'BUTTON',
  currentStatus: 'OPEN',
});
const render = (overrides = {}) =>
  renderToStaticMarkup(
    <BagOpeningHistoryTable
      rows={[{ ...row, ...overrides }]}
      stores={[]}
      productName={() => 'Đầm'}
      showStore={false}
    />,
  );

describe('bag opening history', () => {
  it('uses Vietnam time, time first, including seconds and date rollover', () => {
    expect(formatOpeningTime(row.openedAt)).toBe('16:00:23 25/09/2026');
    expect(formatOpeningTime('2026-09-24T17:00:00Z')).toBe('00:00:00 25/09/2026');
    expect(formatOpeningTime(null)).toBe('Chưa ghi nhận');
    expect(formatOpeningTime('invalid')).toBe('Chưa ghi nhận');
  });
  it('renders six semantic columns in order and exactly one body row per bag', () => {
    const html = render();
    expect([...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1])).toEqual([
      'Thời gian khui',
      'Mã bao',
      'Mặt hàng',
      'Khối lượng',
      'Người thực hiện',
      'Trạng thái',
    ]);
    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain('60,125 kg');
    expect(html).not.toContain('>5 kg<');
    expect(html).toContain(row.actorDisplayName);
    expect(html).toContain('HTKD');
    expect(html).not.toContain(row.actorAccountId);
    expect(html).toContain('16:00:23 25/09/2026');
    expect(html).toContain('Đầm');
    expect(html).toContain('trạng thái hiện tại');
  });
  it('keeps zero and legacy unknown values without inventing an actor or role', () => {
    expect(render({ weightBeforeKg: '0.000' })).toContain('0 kg');
    const html = render({ actorDisplayName: null, actorRole: null, weightBeforeKg: null });
    expect(html.match(/Chưa ghi nhận/g)).toHaveLength(3);
    expect(html).not.toContain('Hệ thống');
    expect(html).not.toContain('HTKD');
    expect(render({ actorDisplayName: null })).toContain('HTKD');
    expect(render({ actorRole: null })).toContain(row.actorDisplayName);
  });
  it('maps every current status without calling every bag opened', () => {
    const labels = [
      'Đang vận chuyển',
      'Chưa khui',
      'Đang bán tại CH',
      'Đã hết',
      'Cách ly',
      'Đã trả',
      'Thất lạc',
    ];
    StoreInventoryBagStatusSchema.options.forEach((currentStatus, i) => {
      expect(render({ currentStatus })).toContain(labels[i]);
    });
  });
});

import { expect, it } from 'vitest';
import { stockHint } from '../../pages/PriorityOrdersPage';
const stock = {
  productId: 'p',
  name: 'Nữ',
  sku: 'NU',
  availableBags: 1,
  maxAdditionalBags: 1,
  orderable: true,
  blockingReason: null,
  observedAt: new Date().toISOString(),
};
it('reports zero, overstock, invalid input and pending without silently clamping', () => {
  expect(stockHint(stock, 2)).toBe('Kho chỉ còn 1 bao khả dụng, chỉ được đặt tối đa 1 bao.');
  expect(stockHint(stock, 1)).toBe('Được đặt thêm tối đa: 1 bao');
  expect(stockHint(stock, 0.5)).toContain('số nguyên');
  expect(stockHint(undefined, 1)).toContain('Đang kiểm tra');
  expect(
    stockHint(
      {
        ...stock,
        maxAdditionalBags: 0,
        blockingReason: 'Tồn khả dụng = 0, không thể đặt mặt hàng này.',
      },
      1,
    ),
  ).toContain('không thể đặt');
});

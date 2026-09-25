import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupInboundProducts, InboundReceiptDetails } from './InboundReceiptDetails';
import { ProductBagPicker } from '../components/ProductBagPicker';

describe('warehouse receipt history', () => {
  it('counts three dresses and five jeans as eight documented bags', () => {
    const bags = [
      ...Array.from({ length: 3 }, () => ({ productId: 'dress' })),
      ...Array.from({ length: 5 }, () => ({ productId: 'jeans' })),
    ];
    const lines = groupInboundProducts(bags, [
      { id: 'dress', name: 'Đầm' },
      { id: 'jeans', name: 'Jeans' },
    ]);
    expect(lines.map((line) => line.quantity)).toEqual([3, 5]);
    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(8);
  });
  it('groups every bag by product ID, including inactive catalog entries and equal names', () => {
    const products = [
      { id: 'a', name: 'Đầm' },
      { id: 'b', name: 'Đầm' },
    ];
    expect(
      groupInboundProducts([{ productId: 'a' }, { productId: 'b' }, { productId: 'a' }], products),
    ).toEqual([
      { productId: 'a', name: 'Đầm', quantity: 2 },
      { productId: 'b', name: 'Đầm', quantity: 1 },
    ]);
    expect(groupInboundProducts([{ productId: 'missing' }], [])[0]).toMatchObject({
      quantity: 1,
      name: 'Chưa tải được tên mặt hàng (missing)',
    });
  });

  it('renders product counts and the actual received time in Vietnam, not browser timezone', () => {
    const html = renderToStaticMarkup(
      createElement(InboundReceiptDetails, {
        receipt: {
          referenceCode: 'PN00001-20/09/2026',
          receivedAt: '2026-09-20T18:30:00.000Z',
          bags: [
            {
              id: 'bag',
              receiptId: 'receipt',
              productId: 'a',
              bagCode: 'B1',
              weightKg: null,
              createdAt: '2026-09-20T18:30:00.000Z',
            },
          ],
        },
        products: [{ id: 'a', name: 'Đầm' }],
      }),
    );
    expect(html).toContain('Đầm');
    expect(html).toContain('1 bao');
    expect(html).toContain('21/09/2026');
    expect(html).toContain('01:30');
    expect(html).toContain('dateTime="2026-09-20T18:30:00.000Z"');
    expect(html).not.toContain(' kg');
  });

  it('marks selected quantities required without requiring every checkbox or changing other screens', () => {
    const props = {
      products: [{ id: 'a', name: 'Đầm' }],
      quantities: { a: 3 },
      onSelect: () => {},
      onQuantityChange: () => {},
    };
    const html = renderToStaticMarkup(
      createElement(ProductBagPicker, { ...props, required: true }),
    );
    expect(html).toMatch(/type="number" required=""/);
    expect(html).not.toMatch(/type="checkbox" required/);
    expect(html).toContain('var(--danger)');
    expect(renderToStaticMarkup(createElement(ProductBagPicker, props))).not.toContain(
      'required=""',
    );
  });
});

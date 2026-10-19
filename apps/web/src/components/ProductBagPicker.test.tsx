import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductBagPicker } from './ProductBagPicker';

const products = [
  { id: 'jeans', name: 'Quần jean' },
  { id: 'dress', name: 'Đầm' },
];

function render(props: Partial<Parameters<typeof ProductBagPicker>[0]> = {}) {
  return renderToStaticMarkup(
    <ProductBagPicker
      products={products}
      quantities={{}}
      onSelect={() => undefined}
      onQuantityChange={() => undefined}
      {...props}
    />,
  );
}

describe('ProductBagPicker stock feedback', () => {
  it('renders no notice by default', () => {
    const html = render();
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Đang kiểm tra');
  });

  it('shows a blocking message under the product it belongs to', () => {
    const message = 'Mặt hàng Đầm ở kho tổng đang hết hàng (tồn = 0), chưa thể đặt.';
    const html = render({ messages: { dress: message } });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    const dress = html.slice(html.indexOf('Đầm'));
    expect(dress).toContain(message);
    expect(html.slice(0, html.indexOf('Đầm'))).not.toContain(message);
    expect(html).toMatch(/aria-describedby="[^"]+-dress-message"/);
  });

  it('keeps the checkbox of a product being checked ticked, disabled and without quantity', () => {
    const html = render({ checkingIds: new Set(['jeans']) });
    expect(html).toContain('Đang kiểm tra tồn kho tổng…');
    const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toContain('checked=""');
    expect(checkboxes[0]).toContain('disabled=""');
    expect(checkboxes[1]).not.toContain('checked=""');
    expect(checkboxes[1]).not.toContain('disabled=""');
    expect(html).not.toContain('type="number"');
  });

  it('greys out an unavailable product and keeps a picked one removable', () => {
    const html = render({ unavailableIds: new Set(['dress']) });
    expect(html.match(/bag-picker__item--unavailable/g)).toHaveLength(1);
    const noted = render({
      unavailableIds: new Set(['dress']),
      messages: { dress: 'Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.' },
    });
    expect(noted).toContain('class="bag-picker__message"');
    expect(noted).not.toContain('role="alert"');
    const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes[0]).not.toContain('disabled=""');
    expect(checkboxes[1]).toContain('disabled=""');
    const picked = render({ unavailableIds: new Set(['dress']), quantities: { dress: 1 } });
    expect((picked.match(/<input type="checkbox"[^>]*>/g) ?? [])[1]).not.toContain('disabled=""');
  });
});

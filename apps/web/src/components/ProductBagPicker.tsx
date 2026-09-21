import { useId, type ReactNode } from 'react';
import { Button } from './Button';
import './product-bag-picker.css';

interface ProductBagPickerProps {
  products: readonly { id: string; name: string }[];
  quantities: Readonly<Record<string, number>>;
  disabled?: boolean;
  required?: boolean;
  max?: number;
  onSelect: (id: string, selected: boolean) => void;
  onQuantityChange: (id: string, quantity: number) => void;
  renderDetails?: (id: string) => ReactNode;
}

export function ProductBagPicker({
  products,
  quantities,
  disabled = false,
  required = false,
  max = 2000,
  onSelect,
  onQuantityChange,
  renderDetails,
}: ProductBagPickerProps) {
  const prefix = useId();
  return (
    <fieldset className="product-bag-picker" disabled={disabled}>
      <legend>
        Chọn mặt hàng và số bao{' '}
        {required ? (
          <span style={{ color: 'var(--danger)' }} aria-hidden="true">
            *
          </span>
        ) : null}
      </legend>
      {required ? (
        <small>Chọn ít nhất một mặt hàng. Số bao của mặt hàng đã chọn là bắt buộc.</small>
      ) : null}
      {products.length === 0 ? <p>Không có mặt hàng đang hoạt động.</p> : null}
      {products.map((product) => {
        const selected = Object.hasOwn(quantities, product.id);
        const quantity = quantities[product.id] ?? 1;
        const inputId = `${prefix}-${product.id}`;
        return (
          <div className="bag-picker__item" key={product.id}>
            <div className="bag-picker__row">
              <label className="bag-picker__choice">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => onSelect(product.id, event.target.checked)}
                />
                <span>
                  {product.name}
                  {required && selected ? (
                    <>
                      {' '}
                      <span style={{ color: 'var(--danger)' }} aria-hidden="true">
                        *
                      </span>
                    </>
                  ) : null}
                </span>
              </label>
              {selected ? (
                <div className="bag-picker__stepper">
                  <label className="sr-only" htmlFor={inputId}>
                    Số bao — {product.name}
                  </label>
                  <Button
                    tone="secondary"
                    aria-label={`Giảm số bao ${product.name}`}
                    disabled={disabled || quantity <= 1}
                    onClick={() => onQuantityChange(product.id, Math.max(1, quantity - 1))}
                  >
                    −
                  </Button>
                  <input
                    id={inputId}
                    type="number"
                    required={required}
                    inputMode="numeric"
                    min={1}
                    max={max}
                    step={1}
                    value={quantity || ''}
                    aria-invalid={!Number.isSafeInteger(quantity) || quantity < 1 || quantity > max}
                    onChange={(event) =>
                      onQuantityChange(
                        product.id,
                        event.target.value === '' ? 0 : event.target.valueAsNumber,
                      )
                    }
                  />
                  <Button
                    tone="secondary"
                    aria-label={`Tăng số bao ${product.name}`}
                    disabled={disabled || quantity >= max}
                    onClick={() =>
                      onQuantityChange(product.id, Math.min(max, Math.max(0, quantity) + 1))
                    }
                  >
                    +
                  </Button>
                </div>
              ) : null}
            </div>
            {selected && renderDetails ? (
              <div className="bag-picker__details">{renderDetails(product.id)}</div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

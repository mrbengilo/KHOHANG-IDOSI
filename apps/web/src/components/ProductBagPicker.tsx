import { useId, type ReactNode } from 'react';
import { Button } from './Button';
import './product-bag-picker.css';

interface ProductBagPickerProps {
  products: readonly { id: string; name: string }[];
  quantities: Readonly<Record<string, number>>;
  disabled?: boolean;
  required?: boolean;
  max?: number;
  /** Products whose pick is being checked (e.g. against stock); their checkbox waits. */
  checkingIds?: ReadonlySet<string>;
  /** Products that cannot be picked (e.g. out of stock): greyed out; an already picked one can only be removed. */
  unavailableIds?: ReadonlySet<string>;
  /** Blocking message shown under a product, e.g. why it could not be picked. */
  messages?: Readonly<Record<string, string>>;
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
  checkingIds,
  unavailableIds,
  messages,
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
        const messageId = `${inputId}-message`;
        const checking = checkingIds?.has(product.id) ?? false;
        const message = messages?.[product.id];
        const unavailable = unavailableIds?.has(product.id) ?? false;
        return (
          <div
            className={`bag-picker__item${unavailable ? ' bag-picker__item--unavailable' : ''}`}
            key={product.id}
          >
            <div className="bag-picker__row">
              <label className="bag-picker__choice">
                <input
                  type="checkbox"
                  // Shows the click at once; the parent decides once the check answers.
                  checked={selected || checking}
                  disabled={checking || (unavailable && !selected)}
                  aria-busy={checking || undefined}
                  aria-describedby={message ? messageId : undefined}
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
              {checking ? (
                <small className="bag-picker__checking" role="status">
                  Đang kiểm tra tồn kho tổng…
                </small>
              ) : null}
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
            {message ? (
              // A standing note of an unavailable product is not announced; a fresh refusal is.
              <p
                className="bag-picker__message"
                id={messageId}
                role={unavailable ? undefined : 'alert'}
              >
                {message}
              </p>
            ) : null}
            {selected && renderDetails ? (
              <div className="bag-picker__details">{renderDetails(product.id)}</div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

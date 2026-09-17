import type { ReactNode } from 'react';

import { Button } from './Button';
import { classes } from './utils';

export interface ProductQuantityCardProps {
  readonly name: string;
  readonly stockLabel: string;
  readonly quantity: number;
  readonly onQuantityChange?: (quantity: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly locked?: boolean;
  readonly lockedReason?: string;
  readonly icon?: ReactNode;
  readonly className?: string;
}

export function ProductQuantityCard({
  className,
  icon,
  locked = false,
  lockedReason,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
  name,
  onQuantityChange,
  quantity,
  stockLabel,
}: ProductQuantityCardProps) {
  const setQuantity = (next: number) => {
    if (!locked) onQuantityChange?.(Math.min(max, Math.max(min, next)));
  };

  return (
    <article
      className={classes('idosi-product-quantity', locked && 'is-locked', className)}
      aria-disabled={locked || undefined}
    >
      <div className="idosi-product-quantity__product">
        <span className="idosi-product-quantity__icon" aria-hidden="true">
          {icon ?? name.slice(0, 1)}
        </span>
        <div>
          <h3>{name}</h3>
          <p className={classes(locked && 'is-danger')}>{lockedReason ?? stockLabel}</p>
        </div>
      </div>
      <div className="idosi-stepper" aria-label={`Số lượng ${name}`}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Giảm ${name}`}
          disabled={locked || quantity <= min}
          onClick={() => setQuantity(quantity - 1)}
        >
          −
        </Button>
        <output aria-live="polite" aria-label={`${quantity} bao`}>
          {quantity}
        </output>
        <Button
          variant="primary"
          size="sm"
          aria-label={`Tăng ${name}`}
          disabled={locked || quantity >= max}
          onClick={() => setQuantity(quantity + 1)}
        >
          +
        </Button>
      </div>
    </article>
  );
}

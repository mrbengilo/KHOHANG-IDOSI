import { formatKgExact } from '../lib/format';
import {
  MAX_BAGS_PER_DISPATCH,
  parseBagCount,
  resizeBagWeights,
  type BagWeightsCheck,
} from '../lib/bag-weights';
import './bag-weights.css';

/** Bag count followed by one weight field per bag, with a running total. */
export function BagWeightsInput({
  idPrefix,
  productName,
  availableKg,
  count,
  weights,
  check,
  onChange,
}: {
  readonly idPrefix: string;
  readonly productName: string;
  readonly availableKg: string;
  readonly count: string;
  readonly weights: readonly string[];
  readonly check: BagWeightsCheck;
  readonly onChange: (count: string, weights: string[]) => void;
}) {
  const bags = parseBagCount(count);
  return (
    <div className="bag-weights">
      <label className="bag-weights__count" htmlFor={`${idPrefix}-count`}>
        Số lượng (bao)
        <input
          id={`${idPrefix}-count`}
          type="number"
          min="1"
          max={MAX_BAGS_PER_DISPATCH}
          step="1"
          inputMode="numeric"
          value={count}
          placeholder="Ví dụ: 2"
          onChange={(event) =>
            onChange(
              event.target.value,
              resizeBagWeights(weights, parseBagCount(event.target.value)),
            )
          }
        />
      </label>
      {bags !== null ? (
        <div className="bag-weights__grid" role="group" aria-label="Khối lượng từng bao">
          {Array.from({ length: bags }, (_, index) => (
            <label key={index} htmlFor={`${idPrefix}-bag-${index}`}>
              Bao {index + 1} · {productName} (kg)
              <input
                id={`${idPrefix}-bag-${index}`}
                type="number"
                min="0.001"
                step="0.001"
                inputMode="decimal"
                placeholder="0.000"
                value={weights[index] ?? ''}
                onChange={(event) =>
                  onChange(
                    count,
                    weights.map((weight, position) =>
                      position === index ? event.target.value : weight,
                    ),
                  )
                }
              />
            </label>
          ))}
        </div>
      ) : null}
      <p
        className={`bag-weights__summary${check.error ? ' bag-weights__summary--error' : ''}`}
        role={check.error ? 'alert' : 'status'}
      >
        Tổng {formatKgExact(check.totalKg)} / đang có {formatKgExact(availableKg)}
        {check.error ? ` — ${check.error}` : ''}
      </p>
    </div>
  );
}

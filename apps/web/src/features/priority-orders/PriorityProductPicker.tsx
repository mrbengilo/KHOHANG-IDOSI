import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { PriorityAvailability } from '@idosi/contracts';

export function PriorityProductPicker({
  products,
  value,
  onChange,
  disabled,
}: {
  products: PriorityAvailability[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = products.find((p) => p.productId === value);
  const filtered = products.filter((p) =>
    p.name.toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi')),
  );
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === searchInput.current && ['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const options = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End' || (event.key === 'ArrowUp' && current < 0)
          ? options.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
    options[next]?.focus();
  }
  return (
    <div
      className="priority-picker"
      ref={root}
      onKeyDown={navigate}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span id={`${id}-label`}>Mặt hàng</span>
      <button
        className="priority-picker-trigger"
        type="button"
        ref={trigger}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={`${id}-options`}
        disabled={disabled}
        onClick={() => {
          setSearch('');
          setOpen(!open);
        }}
      >
        <span id={`${id}-value`}>{selected?.name ?? 'Chọn mặt hàng'}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <div className="priority-picker-menu">
          <input
            ref={searchInput}
            aria-label="Tìm mặt hàng"
            placeholder="Tìm mặt hàng…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div role="listbox" id={`${id}-options`} aria-labelledby={`${id}-label`}>
            {filtered.map((product) => (
              <div className="priority-picker-row" key={product.productId}>
                <button
                  type="button"
                  role="option"
                  aria-label={product.name}
                  aria-selected={value === product.productId}
                  aria-describedby={`${id}-${product.productId}`}
                  disabled={!product.orderable || product.maxAdditionalBags === 0}
                  onClick={() => {
                    onChange(product.productId);
                    close();
                  }}
                >
                  <span>{product.name}</span>
                  <span
                    className="priority-picker-stock"
                    id={`${id}-${product.productId}`}
                    aria-label={`${product.maxAdditionalBags} bao khả dụng`}
                  >
                    {product.maxAdditionalBags}
                  </span>
                </button>
                <span role="tooltip" className="priority-picker-tooltip">
                  {product.maxAdditionalBags}
                </span>
              </div>
            ))}
            {filtered.length === 0 && <p>Không có mặt hàng phù hợp.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

import { useLayoutEffect, useReducer, useRef, type InputHTMLAttributes } from 'react';
import { caretAfterDigits, formatMoneyDigits, parseMoneyInput } from '../lib/money-input';

export type MoneyInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'inputMode' | 'min' | 'step'
> & {
  /** Raw integer digits, e.g. "1000000". */
  value: string;
  onValueChange: (digits: string) => void;
};

/**
 * Ô nhập số tiền VND hiển thị phân cách hàng nghìn (1,000 · 2,000) trong khi state của
 * form vẫn giữ chuỗi chữ số thô, nên validate và payload API không đổi.
 */
export function MoneyInput({ value, onValueChange, ...props }: MoneyInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // Re-render even when the digits did not change (typed a letter or deleted a comma),
  // so the field text is reformatted and the caret restored.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const display = formatMoneyDigits(value);

  useLayoutEffect(() => {
    const element = input.current;
    if (pendingCaret.current === null || !element || document.activeElement !== element) return;
    const position = caretAfterDigits(display, pendingCaret.current);
    pendingCaret.current = null;
    element.setSelectionRange(position, position);
  });

  return (
    <input
      autoComplete="off"
      {...props}
      ref={input}
      type="text"
      inputMode="numeric"
      value={display}
      onChange={(event) => {
        const { value: text, selectionStart } = event.target;
        const parsed = parseMoneyInput(text, selectionStart ?? text.length);
        pendingCaret.current = parsed.digitsBeforeCaret;
        onValueChange(parsed.digits);
        rerender();
      }}
    />
  );
}

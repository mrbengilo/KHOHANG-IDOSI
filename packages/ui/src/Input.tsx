import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

import { classes } from './utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly trailingAction?: ReactNode;
  readonly containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, containerClassName, error, hint, id, label, trailingAction, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const supportId = `${inputId}-support`;

  return (
    <div className={classes('idosi-field', containerClassName)}>
      <label className="idosi-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className={classes('idosi-field__control', error && 'is-error')}>
        <input
          {...props}
          ref={ref}
          id={inputId}
          className={classes('idosi-input', className)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={hint || error ? supportId : undefined}
        />
        {trailingAction ? <span className="idosi-field__action">{trailingAction}</span> : null}
      </div>
      {hint || error ? (
        <span id={supportId} className={classes('idosi-field__support', error && 'is-error')}>
          {error ?? hint}
        </span>
      ) : null}
    </div>
  );
});

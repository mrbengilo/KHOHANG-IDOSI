import clsx from 'clsx';
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, PropsWithChildren {
  tone?: 'primary' | 'secondary' | 'danger' | 'success';
  busy?: boolean;
}

export function Button({
  busy = false,
  children,
  className,
  disabled,
  tone = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={busy}
      className={clsx('button', `button--${tone}`, className)}
      disabled={disabled || busy}
      type="button"
      {...props}
    >
      <span className={clsx('button__content', busy && 'button__content--hidden')}>{children}</span>
      {busy ? <span aria-hidden="true" className="button__spinner" /> : null}
    </button>
  );
}

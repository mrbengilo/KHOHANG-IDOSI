import type { HTMLAttributes } from 'react';

import { classes } from './utils';

export type BadgeTone =
  'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'priority';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
}

export function Badge({ children, className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span {...props} className={classes('idosi-badge', `idosi-badge--${tone}`, className)}>
      {children}
    </span>
  );
}

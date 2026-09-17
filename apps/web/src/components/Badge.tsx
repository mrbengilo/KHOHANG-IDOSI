import clsx from 'clsx';
import type { PropsWithChildren } from 'react';
import type { StatusTone } from '../lib/types';

interface BadgeProps extends PropsWithChildren {
  tone?: StatusTone;
}

export function Badge({ children, tone = 'neutral' }: BadgeProps) {
  return <span className={clsx('badge', `badge--${tone}`)}>{children}</span>;
}

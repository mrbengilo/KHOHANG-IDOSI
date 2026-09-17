import type { HTMLAttributes, ReactNode } from 'react';

import { classes } from './utils';

export type KpiTone = 'neutral' | 'brand' | 'warning' | 'success';

export interface KPIProps extends HTMLAttributes<HTMLElement> {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly tone?: KpiTone;
}

export function KPI({ className, detail, label, tone = 'neutral', value, ...props }: KPIProps) {
  return (
    <article {...props} className={classes('idosi-kpi', `idosi-kpi--${tone}`, className)}>
      <span className="idosi-kpi__label">{label}</span>
      <strong className="idosi-kpi__value">{value}</strong>
      {detail ? <span className="idosi-kpi__detail">{detail}</span> : null}
    </article>
  );
}

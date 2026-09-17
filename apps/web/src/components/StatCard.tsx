import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { StatusTone } from '../lib/types';
import { Badge } from './Badge';

interface StatCardProps {
  label: string;
  value: string;
  detail: string;
  tone?: StatusTone;
  badge?: ReactNode;
}

export function StatCard({ badge, detail, label, tone = 'neutral', value }: StatCardProps) {
  return (
    <article className={clsx('stat-card', `stat-card--${tone}`)}>
      <div className="stat-card__topline">
        <span>{label}</span>
        {badge ? <Badge tone={tone}>{badge}</Badge> : null}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

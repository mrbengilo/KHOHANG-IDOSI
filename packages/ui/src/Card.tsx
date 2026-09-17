import type { HTMLAttributes, ReactNode } from 'react';

import { classes } from './utils';

export type CardTone = 'surface' | 'brand' | 'warning' | 'success' | 'info';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly title?: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly tone?: CardTone;
  readonly as?: 'article' | 'section' | 'div';
}

export function Card({
  action,
  as: Element = 'section',
  children,
  className,
  description,
  title,
  tone = 'surface',
  ...props
}: CardProps) {
  return (
    <Element {...props} className={classes('idosi-card', `idosi-card--${tone}`, className)}>
      {title || description || action ? (
        <header className="idosi-card__header">
          <div className="idosi-card__heading">
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action ? <div className="idosi-card__action">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </Element>
  );
}

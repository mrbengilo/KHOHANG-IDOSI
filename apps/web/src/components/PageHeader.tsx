import { useRef, type ReactNode } from 'react';
import { useRouteContentTarget } from './RouteContentNavigation';

interface PageHeaderProps {
  title: string;
  description: string;
  actions?: ReactNode;
}

export function PageHeader({ actions, description, title }: PageHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useRouteContentTarget(heading, 'page');
  return (
    <header className="page-header">
      <div>
        <h1 ref={heading} tabIndex={-1} className="content-target">
          {title}
        </h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

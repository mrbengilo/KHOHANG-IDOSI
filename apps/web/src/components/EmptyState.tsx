import { PackageOpen } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  detail: string;
}

export function EmptyState({ detail, title }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <PackageOpen aria-hidden="true" size={30} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

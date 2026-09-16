import type { ReactNode } from 'react';

import { Button } from './Button';

export function LoadingState({ label = 'Đang tải dữ liệu' }: { readonly label?: string }) {
  return (
    <div className="idosi-state" role="status" aria-live="polite">
      <span className="idosi-state__loader" aria-hidden="true" />
      <strong>{label}</strong>
      <p>Giữ nguyên dữ liệu đang có trong lúc hệ thống đồng bộ.</p>
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}

export function EmptyState({ action, description, title }: EmptyStateProps) {
  return (
    <div className="idosi-state">
      <span className="idosi-state__mark" aria-hidden="true">
        ○
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
}

export function ErrorState({ message, onRetry, title = 'Không thể tải dữ liệu' }: ErrorStateProps) {
  return (
    <div className="idosi-state idosi-state--error" role="alert">
      <span className="idosi-state__mark" aria-hidden="true">
        !
      </span>
      <strong>{title}</strong>
      <p>{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Thử lại
        </Button>
      ) : null}
    </div>
  );
}

export function PermissionState({
  action,
  description = 'Tài khoản hiện tại không có quyền xem dữ liệu này.',
}: {
  readonly action?: ReactNode;
  readonly description?: string;
}) {
  return (
    <div className="idosi-state idosi-state--permission" role="alert">
      <span className="idosi-state__mark" aria-hidden="true">
        ×
      </span>
      <strong>Bạn không có quyền truy cập</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

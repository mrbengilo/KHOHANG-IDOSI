import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../components/Button';
import type { Role } from '../../lib/types';
import { adminErrorMessage, getAdminSession } from './adminApi';
import './admin.css';

export const adminSessionQueryKey = ['admin', 'session'] as const;

/**
 * Cổng quyền phía giao diện. Backend vẫn là nơi quyết định: danh sách vai trò ở đây chỉ
 * để không hiển thị màn hình mà tài khoản chắc chắn bị từ chối, không thay thế kiểm tra
 * quyền phía máy chủ.
 */
export function AdminAccess({
  children,
  roles = ['ADMIN'],
}: {
  readonly children: ReactNode;
  readonly roles?: readonly Role[];
}) {
  const sessionQuery = useQuery({
    queryFn: getAdminSession,
    queryKey: adminSessionQueryKey,
    retry: false,
    staleTime: 30_000,
  });

  if (sessionQuery.isPending) {
    return (
      <div className="admin-feature">
        <section aria-live="polite" className="admin-state" role="status">
          <span aria-hidden="true" className="admin-spinner" />
          <strong>Đang xác minh quyền quản trị…</strong>
        </section>
      </div>
    );
  }

  if (sessionQuery.isError) {
    return (
      <div className="admin-feature">
        <section className="admin-state admin-state--error" role="alert">
          <ShieldAlert aria-hidden="true" size={28} />
          <strong>Không thể xác minh phiên đăng nhập</strong>
          <p>{adminErrorMessage(sessionQuery.error)}</p>
          <Button className="admin-clickable" onClick={() => void sessionQuery.refetch()}>
            Thử lại
          </Button>
        </section>
      </div>
    );
  }

  if (!roles.includes(sessionQuery.data.principal.role)) {
    return (
      <div className="admin-feature">
        <section className="admin-state admin-state--permission" role="alert">
          <ShieldAlert aria-hidden="true" size={28} />
          <strong>Chỉ tài khoản {roles.join(' hoặc ')} được truy cập</strong>
          <p>Backend đã từ chối mọi thao tác quản trị cho vai trò hiện tại.</p>
        </section>
      </div>
    );
  }

  return <div className="admin-feature">{children}</div>;
}

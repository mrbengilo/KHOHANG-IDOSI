import { TriangleAlert } from 'lucide-react';
import {
  Link,
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError,
} from 'react-router-dom';
import { ApiClientError } from '../lib/api';

// Browsers word a failed `import()` differently; Vite adds its own CSS preload failure.
const chunkLoadFailure =
  /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && chunkLoadFailure.test(error.message);
}

/**
 * Route-level fallback. `layout="page"` replaces the whole document (errors in the shell itself);
 * `layout="workspace"` renders inside the shell so navigation stays usable.
 */
export function RouteErrorBoundary({ layout }: { readonly layout: 'page' | 'workspace' }) {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const chunkFailed = isChunkLoadError(error);
  const requestId = error instanceof ApiClientError ? error.requestId : undefined;

  // React.lazy caches a rejected import, so only a full reload can fetch the chunk again.
  // Other render errors reset by re-entering the same location through the router.
  const retry = () => {
    if (chunkFailed) window.location.reload();
    else void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true });
  };

  return (
    <section
      className={layout === 'page' ? 'route-error route-error--page' : 'route-error'}
      role="alert"
    >
      <TriangleAlert aria-hidden="true" size={30} />
      <h1>{chunkFailed ? 'Không tải được màn hình' : 'Màn hình gặp lỗi khi hiển thị'}</h1>
      <p>
        {chunkFailed
          ? 'Mạng bị gián đoạn hoặc hệ thống vừa được cập nhật phiên bản mới. Tải lại trang để lấy phiên bản hiện hành.'
          : isRouteErrorResponse(error) && error.status === 404
            ? 'Đường dẫn không tồn tại hoặc tài khoản không có quyền truy cập.'
            : 'Dữ liệu đã lưu không bị ảnh hưởng. Thử hiển thị lại; nếu lỗi lặp lại, quay về tổng quan và báo cho quản trị viên.'}
      </p>
      {requestId ? <p className="route-error__request">Mã yêu cầu: {requestId}</p> : null}
      <div className="route-error__actions">
        <button className="button button--primary" onClick={retry} type="button">
          {chunkFailed ? 'Tải lại trang' : 'Thử hiển thị lại'}
        </button>
        <Link className="button button--secondary" to="/">
          Về tổng quan
        </Link>
      </div>
    </section>
  );
}

import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <strong>404</strong>
      <h1>Không tìm thấy màn hình</h1>
      <p>Đường dẫn không tồn tại hoặc tài khoản không có quyền truy cập.</p>
      <Link to="/">Về tổng quan</Link>
    </main>
  );
}

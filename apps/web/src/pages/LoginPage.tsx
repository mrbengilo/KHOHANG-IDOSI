import { ArrowRight, LockKeyhole, User } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { ApiClientError, login, mockModeEnabled } from '../lib/api';
import { installAuthenticatedSession, useSession } from '../lib/auth';
import { safeReturnPath } from '../lib/navigation';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const sessionQuery = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const returnPath = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('login') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!username || !password) {
      setError('Nhập đầy đủ tên đăng nhập và mật khẩu.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (mockModeEnabled) {
        navigate(returnPath, { replace: true });
        return;
      }
      const session = await login({ username, password });
      installAuthenticatedSession(queryClient, session);
      navigate(returnPath, { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Dữ liệu phản hồi không hợp lệ. Vui lòng liên hệ quản trị viên.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!mockModeEnabled && sessionQuery.data) {
    return <Navigate replace to={returnPath} />;
  }

  return (
    <main className="login-page login-page--compact">
      <section className="login-panel">
        <form onSubmit={submit}>
          <img
            className="app-logo"
            src="/idosi-kho-app-1024.png"
            alt="IDOSI Kho hàng"
            width="112"
            height="84"
          />
          <div>
            <span>Chào mừng trở lại</span>
            <h1>Đăng nhập Kho hàng IDOSI</h1>
            <p className="login-slogan">QUẢN LÝ &amp; PHÂN BỔ HÀNG HÓA HỆ THỐNG IDOSI</p>
            <p>Sử dụng tài khoản được quản trị viên cấp.</p>
          </div>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <label>
            <span>
              Tên đăng nhập{' '}
              <span className="required-mark" aria-hidden="true">
                *
              </span>
            </span>
            <div className="input-with-icon">
              <User aria-hidden="true" size={18} />
              <input
                required
                aria-label="Tên đăng nhập"
                autoComplete="username"
                name="login"
                placeholder="Tên đăng nhập"
              />
            </div>
          </label>
          <label>
            <span>
              Mật khẩu{' '}
              <span className="required-mark" aria-hidden="true">
                *
              </span>
            </span>
            <div className="input-with-icon">
              <LockKeyhole aria-hidden="true" size={18} />
              <input
                required
                aria-label="Mật khẩu"
                autoComplete="current-password"
                name="password"
                placeholder="Mật khẩu"
                type="password"
              />
            </div>
          </label>
          <Button busy={busy || (!mockModeEnabled && sessionQuery.isPending)} type="submit">
            Đăng nhập <ArrowRight aria-hidden="true" size={17} />
          </Button>
          <small>
            Nếu quên mật khẩu, liên hệ Admin để đặt lại. Hệ thống không thể xem mật khẩu hiện tại.
          </small>
        </form>
      </section>
    </main>
  );
}

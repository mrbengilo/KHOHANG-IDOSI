import type {
  Account,
  AccountRole,
  AccountStatus,
  CreateAccountRequest,
  ListAccountsQuery,
  Store,
  UpdateAccountRequest,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { AdminAccess } from './AdminAccess';
import {
  adminErrorMessage,
  createAdminAccount,
  listActiveStoresForAccounts,
  listAdminAccounts,
  resetAdminAccountPassword,
  updateAdminAccount,
} from './adminApi';

const accountQueryKey = ['admin', 'accounts'] as const;
const auditQueryKey = ['admin', 'audit-logs'] as const;
const pageSize = 20;

const roleLabels: Record<AccountRole, string> = {
  ADMIN: 'Quản trị',
  HTKD: 'HTKD',
  STORE: 'Cửa hàng',
};

const statusLabels: Record<AccountStatus, string> = {
  ACTIVE: 'Hoạt động',
  DISABLED: 'Vô hiệu hóa',
  LOCKED: 'Đã khóa',
};

const statusTone: Record<AccountStatus, 'success' | 'danger' | 'warning'> = {
  ACTIVE: 'success',
  DISABLED: 'danger',
  LOCKED: 'warning',
};

interface AccountFilters {
  readonly search: string;
  readonly role: '' | AccountRole;
  readonly status: '' | AccountStatus;
}

export interface CreateAccountDraft {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly confirmPassword: string;
  readonly role: AccountRole;
  readonly storeId: string;
}

const emptyFilters: AccountFilters = { role: '', search: '', status: '' };
const emptyCreateDraft: CreateAccountDraft = {
  confirmPassword: '',
  displayName: '',
  password: '',
  role: 'HTKD',
  storeId: '',
  username: '',
};

export function accountQueryFromFilters(filters: AccountFilters, page: number): ListAccountsQuery {
  return {
    page,
    pageSize,
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export function validatePasswordReset(password: string, confirmation: string): string | null {
  if (password.length < 12) return 'Mật khẩu mới phải có ít nhất 12 ký tự.';
  if (password.length > 256) return 'Mật khẩu mới không được quá 256 ký tự.';
  if (password !== confirmation) return 'Hai lần nhập mật khẩu chưa trùng khớp.';
  return null;
}

export function createAccountInputFromDraft(draft: CreateAccountDraft): {
  readonly input: CreateAccountRequest | null;
  readonly error: string | null;
} {
  if (draft.username.trim().length < 3) {
    return { error: 'Tên đăng nhập phải có ít nhất 3 ký tự.', input: null };
  }
  if (!draft.displayName.trim()) {
    return { error: 'Tên hiển thị không được để trống.', input: null };
  }
  const passwordError = validatePasswordReset(draft.password, draft.confirmPassword);
  if (passwordError) return { error: passwordError, input: null };
  if (draft.role === 'STORE' && !draft.storeId) {
    return { error: 'Hãy chọn cửa hàng cho tài khoản STORE.', input: null };
  }
  return {
    error: null,
    input: {
      displayName: draft.displayName.trim(),
      password: draft.password,
      role: draft.role,
      storeId: draft.role === 'STORE' ? draft.storeId : null,
      username: draft.username.trim(),
    },
  };
}

export function accountStatusRequest(
  account: Account,
  status: AccountStatus,
): UpdateAccountRequest {
  return { expectedSessionVersion: account.sessionVersion, status };
}

export function AdminUsersPage() {
  return (
    <AdminAccess>
      <AdminUsersContent />
    </AdminAccess>
  );
}

function AdminUsersContent() {
  const queryClient = useQueryClient();
  const [filterDraft, setFilterDraft] = useState<AccountFilters>(emptyFilters);
  const [filters, setFilters] = useState<AccountFilters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateAccountDraft>(emptyCreateDraft);
  const [creating, setCreating] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const [resetting, setResetting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const createLock = useRef(false);
  const statusLock = useRef(false);
  const resetLock = useRef(false);

  const accountsQuery = useQuery({
    queryFn: () => listAdminAccounts(accountQueryFromFilters(filters, page)),
    queryKey: [...accountQueryKey, filters, page],
    retry: false,
  });
  const storesQuery = useQuery({
    queryFn: listActiveStoresForAccounts,
    queryKey: ['admin', 'active-stores'],
    retry: false,
    staleTime: 60_000,
  });
  const storesById = useMemo(
    () => new Map((storesQuery.data ?? []).map((store) => [store.id, store] as const)),
    [storesQuery.data],
  );

  const refreshData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: accountQueryKey }),
      queryClient.invalidateQueries({ queryKey: auditQueryKey }),
    ]);
  };

  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setFilters({ ...filterDraft });
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createLock.current) return;
    const parsed = createAccountInputFromDraft(createDraft);
    if (!parsed.input) {
      setActionError(parsed.error ?? 'Dữ liệu tạo tài khoản chưa hợp lệ.');
      return;
    }
    createLock.current = true;
    setCreating(true);
    setActionError('');
    setSuccessMessage('');
    try {
      const created = await createAdminAccount(parsed.input);
      setCreateDraft(emptyCreateDraft);
      setShowCreate(false);
      setSuccessMessage(`Đã tạo tài khoản ${created.username}.`);
      await refreshData();
    } catch (error) {
      setActionError(adminErrorMessage(error));
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  };

  const saveStatus = async (account: Account, status: AccountStatus) => {
    if (statusLock.current || status === account.status) return;
    statusLock.current = true;
    setStatusBusyId(account.id);
    setActionError('');
    setSuccessMessage('');
    try {
      const updated = await updateAdminAccount(account.id, accountStatusRequest(account, status));
      setSuccessMessage(`Đã cập nhật ${updated.username}: ${statusLabels[updated.status]}.`);
      await refreshData();
    } catch (error) {
      setActionError(adminErrorMessage(error));
      if (error instanceof Error && 'code' in error && error.code === 'VERSION_CONFLICT') {
        await queryClient.invalidateQueries({ queryKey: accountQueryKey });
      }
    } finally {
      statusLock.current = false;
      setStatusBusyId(null);
    }
  };

  const submitPasswordReset = async (password: string) => {
    if (!resetTarget || resetLock.current) return;
    resetLock.current = true;
    setResetting(true);
    setActionError('');
    setSuccessMessage('');
    try {
      const result = await resetAdminAccountPassword(resetTarget.id, {
        expectedSessionVersion: resetTarget.sessionVersion,
        newPassword: password,
        revokeSessions: true,
      });
      setSuccessMessage(
        `Đã đặt lại mật khẩu ${resetTarget.username}; thu hồi ${result.sessionsRevoked} phiên.`,
      );
      setResetTarget(null);
      await refreshData();
    } catch (error) {
      setActionError(adminErrorMessage(error));
      if (error instanceof Error && 'code' in error && error.code === 'VERSION_CONFLICT') {
        await queryClient.invalidateQueries({ queryKey: accountQueryKey });
      }
    } finally {
      resetLock.current = false;
      setResetting(false);
    }
  };

  const closeCreate = () => {
    if (creating) return;
    setCreateDraft(emptyCreateDraft);
    setShowCreate(false);
    setActionError('');
  };

  const accounts = accountsQuery.data?.data ?? [];
  const pagination = accountsQuery.data?.pagination;

  return (
    <>
      <PageHeader
        actions={
          <Button
            aria-expanded={showCreate}
            className="admin-clickable"
            onClick={() => {
              setActionError('');
              setShowCreate((current) => !current);
            }}
          >
            <Plus aria-hidden="true" size={16} /> Thêm tài khoản
          </Button>
        }
        description="Tạo tài khoản, khóa phiên và đặt lại mật khẩu trực tiếp trên backend"
        title="Tài khoản & phân quyền"
      />

      <section className="admin-security-note">
        <ShieldCheck aria-hidden="true" size={22} />
        <div>
          <strong>Không hiển thị mật khẩu hoặc token</strong>
          <span>Mọi thay đổi trạng thái và mật khẩu đều thu hồi phiên, có version và audit.</span>
        </div>
      </section>

      {showCreate ? (
        <CreateAccountForm
          busy={creating}
          draft={createDraft}
          onCancel={closeCreate}
          onChange={setCreateDraft}
          onSubmit={submitCreate}
          stores={storesQuery.data ?? []}
          storesError={storesQuery.isError ? adminErrorMessage(storesQuery.error) : ''}
        />
      ) : null}

      {resetTarget ? (
        <PasswordResetPanel
          key={resetTarget.id}
          account={resetTarget}
          busy={resetting}
          error={actionError}
          onCancel={() => {
            if (!resetting) {
              setResetTarget(null);
              setActionError('');
            }
          }}
          onSubmit={submitPasswordReset}
        />
      ) : null}

      <div aria-live="polite" className="admin-announcer">
        {successMessage ? (
          <p className="admin-feedback admin-feedback--success">{successMessage}</p>
        ) : null}
        {actionError && !resetTarget ? (
          <p className="admin-feedback admin-feedback--error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      <section className="admin-panel">
        <form className="admin-filters" onSubmit={submitFilters}>
          <label className="admin-field admin-field--search">
            <span>Tìm tài khoản</span>
            <span className="admin-input-with-icon">
              <Search aria-hidden="true" size={16} />
              <input
                onChange={(event) =>
                  setFilterDraft((current) => ({ ...current, search: event.target.value }))
                }
                placeholder="Tên đăng nhập hoặc tên hiển thị"
                value={filterDraft.search}
              />
            </span>
          </label>
          <label className="admin-field">
            <span>Vai trò</span>
            <select
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  role: event.target.value as AccountFilters['role'],
                }))
              }
              value={filterDraft.role}
            >
              <option value="">Tất cả</option>
              <option value="ADMIN">ADMIN</option>
              <option value="HTKD">HTKD</option>
              <option value="STORE">STORE</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Trạng thái</span>
            <select
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  status: event.target.value as AccountFilters['status'],
                }))
              }
              value={filterDraft.status}
            >
              <option value="">Tất cả</option>
              <option value="ACTIVE">Hoạt động</option>
              <option value="LOCKED">Đã khóa</option>
              <option value="DISABLED">Vô hiệu hóa</option>
            </select>
          </label>
          <Button busy={accountsQuery.isFetching} className="admin-clickable" type="submit">
            Lọc
          </Button>
          <Button
            className="admin-clickable"
            onClick={() => {
              setFilterDraft(emptyFilters);
              setFilters(emptyFilters);
              setPage(1);
            }}
            tone="secondary"
          >
            Xóa lọc
          </Button>
        </form>

        {accountsQuery.isPending ? <AdminLoading label="Đang tải danh sách tài khoản…" /> : null}
        {accountsQuery.isError ? (
          <AdminLoadError
            error={accountsQuery.error}
            onRetry={() => void accountsQuery.refetch()}
          />
        ) : null}
        {accountsQuery.isSuccess && accounts.length === 0 ? (
          <EmptyState
            detail="Thử thay đổi bộ lọc hoặc tạo tài khoản mới."
            title="Không có tài khoản phù hợp"
          />
        ) : null}
        {accounts.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <caption className="admin-sr-only">Danh sách tài khoản hệ thống</caption>
              <thead>
                <tr>
                  <th scope="col">Tài khoản</th>
                  <th scope="col">Vai trò</th>
                  <th scope="col">Phạm vi</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td data-label="Tài khoản">
                      <strong>{account.displayName}</strong>
                      <small>{account.username}</small>
                    </td>
                    <td data-label="Vai trò">
                      <Badge tone="info">{roleLabels[account.role]}</Badge>
                    </td>
                    <td data-label="Phạm vi">
                      {account.role === 'STORE'
                        ? storeLabel(account.storeId, storesById)
                        : account.role === 'ADMIN'
                          ? 'Toàn hệ thống'
                          : 'Theo phân công HTKD'}
                    </td>
                    <td data-label="Trạng thái">
                      <Badge tone={statusTone[account.status]}>
                        {statusLabels[account.status]}
                      </Badge>
                      <small>Phiên bản {account.sessionVersion}</small>
                    </td>
                    <td data-label="Thao tác">
                      <div className="admin-row-actions">
                        <AccountStatusControl
                          key={`${account.id}:${account.sessionVersion}:${account.status}`}
                          account={account}
                          busy={statusBusyId === account.id}
                          disabled={statusBusyId !== null || resetting || creating}
                          onSave={saveStatus}
                        />
                        <button
                          className="admin-action admin-action--secondary"
                          disabled={statusBusyId !== null || resetting || creating}
                          onClick={() => {
                            setActionError('');
                            setResetTarget(account);
                          }}
                          type="button"
                        >
                          <KeyRound aria-hidden="true" size={15} /> Đặt lại mật khẩu
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {pagination && pagination.totalPages > 1 ? (
          <nav aria-label="Phân trang tài khoản" className="admin-pagination">
            <button
              className="admin-action"
              disabled={page <= 1 || accountsQuery.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Trang trước
            </button>
            <span>
              Trang {pagination.page}/{pagination.totalPages} · {pagination.totalItems} tài khoản
            </span>
            <button
              className="admin-action"
              disabled={page >= pagination.totalPages || accountsQuery.isFetching}
              onClick={() => setPage((current) => current + 1)}
              type="button"
            >
              Trang sau
            </button>
          </nav>
        ) : null}
      </section>
    </>
  );
}

function CreateAccountForm({
  busy,
  draft,
  onCancel,
  onChange,
  onSubmit,
  stores,
  storesError,
}: {
  readonly busy: boolean;
  readonly draft: CreateAccountDraft;
  readonly onCancel: () => void;
  readonly onChange: (draft: CreateAccountDraft) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly stores: readonly Store[];
  readonly storesError: string;
}) {
  const update = <Key extends keyof CreateAccountDraft>(key: Key, value: CreateAccountDraft[Key]) =>
    onChange({ ...draft, [key]: value });

  return (
    <section className="admin-panel admin-editor" id="admin-create-account">
      <div className="admin-section-heading">
        <div>
          <h2>Tạo tài khoản</h2>
          <p>Mật khẩu chỉ được gửi một lần qua kết nối API và không được hiển thị lại.</p>
        </div>
        <button
          aria-label="Đóng biểu mẫu tạo tài khoản"
          className="admin-icon-button"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <form className="admin-form-grid" onSubmit={onSubmit}>
        <label className="admin-field">
          <span>Tên đăng nhập</span>
          <input
            autoComplete="off"
            disabled={busy}
            maxLength={80}
            minLength={3}
            onChange={(event) => update('username', event.target.value)}
            required
            value={draft.username}
          />
        </label>
        <label className="admin-field">
          <span>Tên hiển thị</span>
          <input
            disabled={busy}
            maxLength={120}
            onChange={(event) => update('displayName', event.target.value)}
            required
            value={draft.displayName}
          />
        </label>
        <label className="admin-field">
          <span>Vai trò</span>
          <select
            disabled={busy}
            onChange={(event) => {
              const role = event.target.value as AccountRole;
              onChange({ ...draft, role, storeId: role === 'STORE' ? draft.storeId : '' });
            }}
            value={draft.role}
          >
            <option value="ADMIN">ADMIN</option>
            <option value="HTKD">HTKD</option>
            <option value="STORE">STORE</option>
          </select>
        </label>
        {draft.role === 'STORE' ? (
          <label className="admin-field">
            <span>Cửa hàng</span>
            <select
              disabled={busy || Boolean(storesError)}
              onChange={(event) => update('storeId', event.target.value)}
              required
              value={draft.storeId}
            >
              <option value="">Chọn cửa hàng</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} · {store.name}
                </option>
              ))}
            </select>
            {storesError ? <small className="admin-field-error">{storesError}</small> : null}
          </label>
        ) : null}
        <label className="admin-field">
          <span>Mật khẩu ban đầu</span>
          <input
            autoComplete="new-password"
            disabled={busy}
            maxLength={256}
            minLength={12}
            onChange={(event) => update('password', event.target.value)}
            required
            type="password"
            value={draft.password}
          />
        </label>
        <label className="admin-field">
          <span>Nhập lại mật khẩu</span>
          <input
            autoComplete="new-password"
            disabled={busy}
            maxLength={256}
            minLength={12}
            onChange={(event) => update('confirmPassword', event.target.value)}
            required
            type="password"
            value={draft.confirmPassword}
          />
        </label>
        <div className="admin-form-actions">
          <Button busy={busy} className="admin-clickable" type="submit">
            Tạo tài khoản
          </Button>
          <Button className="admin-clickable" disabled={busy} onClick={onCancel} tone="secondary">
            Hủy
          </Button>
        </div>
      </form>
    </section>
  );
}

function AccountStatusControl({
  account,
  busy,
  disabled,
  onSave,
}: {
  readonly account: Account;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSave: (account: Account, status: AccountStatus) => Promise<void>;
}) {
  const [selected, setSelected] = useState<AccountStatus>(account.status);
  return (
    <span className="admin-status-control">
      <label className="admin-sr-only" htmlFor={`status-${account.id}`}>
        Trạng thái {account.username}
      </label>
      <select
        disabled={disabled}
        id={`status-${account.id}`}
        onChange={(event) => setSelected(event.target.value as AccountStatus)}
        value={selected}
      >
        <option value="ACTIVE">Hoạt động</option>
        <option value="LOCKED">Khóa</option>
        <option value="DISABLED">Vô hiệu hóa</option>
      </select>
      <button
        aria-busy={busy}
        className="admin-action"
        disabled={disabled || busy || selected === account.status}
        onClick={() => void onSave(account, selected)}
        type="button"
      >
        {busy ? (
          <span aria-hidden="true" className="admin-mini-spinner" />
        ) : (
          <LockKeyhole aria-hidden="true" size={15} />
        )}
        Lưu trạng thái
      </button>
    </span>
  );
}

function PasswordResetPanel({
  account,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly account: Account;
  readonly busy: boolean;
  readonly error: string;
  readonly onCancel: () => void;
  readonly onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextError = validatePasswordReset(password, confirmation);
    setValidationError(nextError ?? '');
    if (!nextError) void onSubmit(password);
  };

  return (
    <section aria-labelledby="reset-password-title" className="admin-panel admin-editor">
      <div className="admin-section-heading">
        <div>
          <h2 id="reset-password-title">Đặt lại mật khẩu</h2>
          <p>
            {account.displayName} · {account.username}. Tất cả phiên hiện tại sẽ bị thu hồi.
          </p>
        </div>
        <button
          aria-label="Đóng biểu mẫu đặt lại mật khẩu"
          className="admin-icon-button"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <form className="admin-form-grid" onSubmit={submit}>
        <label className="admin-field">
          <span>Mật khẩu mới</span>
          <input
            autoComplete="new-password"
            disabled={busy}
            maxLength={256}
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        <label className="admin-field">
          <span>Nhập lại mật khẩu mới</span>
          <input
            autoComplete="new-password"
            disabled={busy}
            maxLength={256}
            minLength={12}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
        </label>
        {validationError || error ? (
          <p className="admin-feedback admin-feedback--error" role="alert">
            {validationError || error}
          </p>
        ) : null}
        <div className="admin-form-actions">
          <Button busy={busy} className="admin-clickable" type="submit">
            Thu hồi phiên & đặt lại
          </Button>
          <Button className="admin-clickable" disabled={busy} onClick={onCancel} tone="secondary">
            Hủy
          </Button>
        </div>
      </form>
    </section>
  );
}

function AdminLoading({ label }: { readonly label: string }) {
  return (
    <div aria-live="polite" className="admin-state" role="status">
      <span aria-hidden="true" className="admin-spinner" />
      <strong>{label}</strong>
    </div>
  );
}

function AdminLoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  return (
    <div className="admin-state admin-state--error" role="alert">
      <strong>Không thể tải danh sách tài khoản</strong>
      <p>{adminErrorMessage(error)}</p>
      <Button className="admin-clickable" onClick={onRetry} tone="secondary">
        <RefreshCw aria-hidden="true" size={15} /> Thử lại
      </Button>
    </div>
  );
}

function storeLabel(storeId: string | null, stores: ReadonlyMap<string, Store>): string {
  if (!storeId) return 'Chưa gán cửa hàng';
  const store = stores.get(storeId);
  return store ? `${store.code} · ${store.name}` : storeId;
}

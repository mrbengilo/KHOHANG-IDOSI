import {
  CreateAccountResponseSchema,
  ErrorEnvelopeSchema,
  GetSessionResponseSchema,
  ListAccountsResponseSchema,
  ListAuditLogsResponseSchema,
  ListStoresResponseSchema,
  ResetPasswordResponseSchema,
  UpdateAccountResponseSchema,
  type Account,
  type AdminAuditLog,
  type CreateAccountRequest,
  type ListAccountsQuery,
  type ListAuditLogsQuery,
  type PaginationMeta,
  type ResetPasswordRequest,
  type Session,
  type Store,
  type UpdateAccountRequest,
} from '@idosi/contracts';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const adminApiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/u, '');

export class AdminApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId: string | undefined;

  public constructor(message: string, status: number, code = 'HTTP_ERROR', requestId?: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface AdminPage<T> {
  readonly data: readonly T[];
  readonly pagination: PaginationMeta;
}

async function requestAdminApi(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${adminApiBaseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'include',
      headers,
    });
  } catch {
    throw new AdminApiError(
      'Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.',
      0,
      'NETWORK_ERROR',
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      throw new AdminApiError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    }
    throw new AdminApiError(`Yêu cầu thất bại (${response.status}).`, response.status);
  }
  return payload;
}

function queryString(values: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export async function getAdminSession(): Promise<Session> {
  const payload = await requestAdminApi('/auth/session');
  return GetSessionResponseSchema.parse(payload).data;
}

export async function listAdminAccounts(query: ListAccountsQuery): Promise<AdminPage<Account>> {
  const payload = await requestAdminApi(`/admin/accounts?${queryString(query)}`);
  return ListAccountsResponseSchema.parse(payload);
}

export async function createAdminAccount(input: CreateAccountRequest): Promise<Account> {
  const payload = await requestAdminApi('/admin/accounts', {
    body: JSON.stringify(input),
    method: 'POST',
  });
  return CreateAccountResponseSchema.parse(payload).data;
}

export async function updateAdminAccount(
  accountId: string,
  input: UpdateAccountRequest,
): Promise<Account> {
  const payload = await requestAdminApi(`/admin/accounts/${encodeURIComponent(accountId)}`, {
    body: JSON.stringify(input),
    method: 'PATCH',
  });
  return UpdateAccountResponseSchema.parse(payload).data;
}

export async function resetAdminAccountPassword(
  accountId: string,
  input: ResetPasswordRequest,
): Promise<{ accountId: string; sessionsRevoked: number; sessionVersion: number }> {
  const payload = await requestAdminApi(
    `/admin/accounts/${encodeURIComponent(accountId)}/reset-password`,
    { body: JSON.stringify(input), method: 'POST' },
  );
  return ResetPasswordResponseSchema.parse(payload).data;
}

export async function listAdminAuditLogs(
  query: ListAuditLogsQuery,
): Promise<AdminPage<AdminAuditLog>> {
  const payload = await requestAdminApi(`/admin/audit-logs?${queryString(query)}`);
  return ListAuditLogsResponseSchema.parse(payload);
}

export async function listActiveStoresForAccounts(): Promise<readonly Store[]> {
  const payload = await requestAdminApi('/stores?page=1&pageSize=100&status=ACTIVE');
  return ListStoresResponseSchema.parse(payload).data;
}

export function adminErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    const reference = error.requestId ? ` Mã yêu cầu: ${error.requestId}.` : '';
    if (error.code === 'VERSION_CONFLICT') {
      return `Dữ liệu đã thay đổi ở phiên khác. Hãy tải lại rồi thao tác lại.${reference}`;
    }
    return `${error.message}${reference}`;
  }
  return 'Có lỗi ngoài dự kiến. Vui lòng thử lại.';
}

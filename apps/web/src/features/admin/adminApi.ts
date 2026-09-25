import {
  CreateAccountResponseSchema,
  CreateStoreGroupRequestSchema,
  CreateStoreRequestSchema,
  ErrorEnvelopeSchema,
  GetSessionResponseSchema,
  HtkdAssignmentsResponseSchema,
  IdosiProductLinkResponseSchema,
  IdosiProductMatchingResponseSchema,
  IdosiStoreCodeResponseSchema,
  ListIdosiStoreCodesResponseSchema,
  ListAccountsResponseSchema,
  ListAuditLogsResponseSchema,
  ListStoreGroupsResponseSchema,
  ListStoresResponseSchema,
  OperationalSettingsOverviewResponseSchema,
  ResetPasswordResponseSchema,
  StoreGroupResponseSchema,
  StoreResponseSchema,
  UpdateAccountResponseSchema,
  UpdateStoreGroupRequestSchema,
  UpdateStoreRequestSchema,
  SetIdosiProductLinkRequestSchema,
  SetIdosiStoreCodeRequestSchema,
  WorkerStatusResponseSchema,
  type Account,
  type AdminAuditLog,
  type CreateAccountRequest,
  type CreateStoreGroupRequest,
  type CreateStoreRequest,
  type HtkdAssignmentsResponse,
  type IdosiProductLink,
  type IdosiProductMatching,
  type IdosiStoreCode,
  type ListAccountsQuery,
  type ListAuditLogsQuery,
  type ListStoreGroupsQuery,
  type ListStoresQuery,
  type PaginationMeta,
  type OperationalSettingsOverview,
  type ResetPasswordRequest,
  type ReplaceHtkdAssignmentsRequest,
  type Session,
  type SetIdosiProductLinkRequest,
  type SetIdosiStoreCodeRequest,
  type Store,
  type StoreGroup,
  type UpdateAccountRequest,
  type UpdateOperationalSettingsRequest,
  type UpdateStoreGroupRequest,
  type UpdateStoreRequest,
  type WorkerStatus,
} from '@idosi/contracts';
import { reportUnauthorizedResponse } from '../../lib/session-expiry';
import { addTabSessionHeader } from '../../lib/tab-session';

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
  addTabSessionHeader(headers);

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

  reportUnauthorizedResponse(response.status, path);
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

export async function getAdminHtkdAssignments(
  htkdAccountId: string,
): Promise<HtkdAssignmentsResponse['data']> {
  const payload = await requestAdminApi(
    `/admin/accounts/${encodeURIComponent(htkdAccountId)}/assignments`,
  );
  return HtkdAssignmentsResponseSchema.parse(payload).data;
}

export async function replaceAdminHtkdAssignments(
  htkdAccountId: string,
  input: ReplaceHtkdAssignmentsRequest,
): Promise<HtkdAssignmentsResponse['data']> {
  const payload = await requestAdminApi(
    `/admin/accounts/${encodeURIComponent(htkdAccountId)}/assignments`,
    { body: JSON.stringify(input), method: 'PUT' },
  );
  return HtkdAssignmentsResponseSchema.parse(payload).data;
}

export async function listAdminAuditLogs(
  query: ListAuditLogsQuery,
): Promise<AdminPage<AdminAuditLog>> {
  const payload = await requestAdminApi(`/admin/audit-logs?${queryString(query)}`);
  return ListAuditLogsResponseSchema.parse(payload);
}

export async function getAdminOperationalSettings(
  historyLimit = 10,
): Promise<OperationalSettingsOverview> {
  const payload = await requestAdminApi(
    `/admin/operational-settings?${queryString({ historyLimit })}`,
  );
  return OperationalSettingsOverviewResponseSchema.parse(payload).data;
}

/** IDOSI id of each active retail store, with where it comes from. */
export async function listIdosiStoreCodes(): Promise<IdosiStoreCode[]> {
  return ListIdosiStoreCodesResponseSchema.parse(await requestAdminApi('/admin/idosi-store-codes'))
    .data;
}

export async function setIdosiStoreCode(
  storeId: string,
  input: SetIdosiStoreCodeRequest,
): Promise<IdosiStoreCode> {
  const payload = await requestAdminApi(`/admin/idosi-store-codes/${encodeURIComponent(storeId)}`, {
    body: JSON.stringify(SetIdosiStoreCodeRequestSchema.parse(input)),
    method: 'PUT',
  });
  return IdosiStoreCodeResponseSchema.parse(payload).data;
}

/** IDOSI product links plus the IDOSI products of the month whose sales reach no stock yet. */
export async function getIdosiProductMatching(period: string): Promise<IdosiProductMatching> {
  const payload = await requestAdminApi(`/admin/idosi-product-links?${queryString({ period })}`);
  return IdosiProductMatchingResponseSchema.parse(payload).data;
}

export async function setIdosiProductLink(
  idosiProductId: string,
  input: SetIdosiProductLinkRequest,
): Promise<IdosiProductLink> {
  const payload = await requestAdminApi(
    `/admin/idosi-product-links/${encodeURIComponent(idosiProductId)}`,
    { body: JSON.stringify(SetIdosiProductLinkRequestSchema.parse(input)), method: 'PUT' },
  );
  return IdosiProductLinkResponseSchema.parse(payload).data;
}

/** Last allocation worker heartbeat: why a scheduled 08:00/09:00 job did not finish. */
export async function getAllocationWorkerStatus(): Promise<WorkerStatus> {
  const payload = await requestAdminApi('/admin/worker-status');
  return WorkerStatusResponseSchema.parse(payload).data;
}

export async function updateAdminOperationalSettings(
  input: UpdateOperationalSettingsRequest,
): Promise<OperationalSettingsOverview> {
  const payload = await requestAdminApi('/admin/operational-settings', {
    body: JSON.stringify(input),
    method: 'PUT',
  });
  return OperationalSettingsOverviewResponseSchema.parse(payload).data;
}

export async function listActiveStoresForAccounts(): Promise<readonly Store[]> {
  const query = { pageSize: 100, kind: 'RETAIL' as const, status: 'ACTIVE' as const };
  const firstPage = await listAdminStores({ ...query, page: 1 });
  const remainingPages = await Promise.all(
    Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, index) =>
      listAdminStores({ ...query, page: index + 2 }),
    ),
  );
  return [firstPage, ...remainingPages].flatMap((page) => page.data);
}

export async function listAdminStores(query: ListStoresQuery): Promise<AdminPage<Store>> {
  const payload = await requestAdminApi(`/stores?${queryString(query)}`);
  return ListStoresResponseSchema.parse(payload);
}

export async function listAdminStoreGroups(
  query: ListStoreGroupsQuery,
): Promise<AdminPage<StoreGroup>> {
  const payload = await requestAdminApi(`/store-groups?${queryString(query)}`);
  return ListStoreGroupsResponseSchema.parse(payload);
}

export async function listAdminStoreGroupDirectory(): Promise<readonly StoreGroup[]> {
  const firstPage = await listAdminStoreGroups({ page: 1, pageSize: 100 });
  if (firstPage.pagination.totalPages <= 1) return firstPage.data;

  const remainingPages = await Promise.all(
    Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, index) =>
      listAdminStoreGroups({ page: index + 2, pageSize: 100 }),
    ),
  );
  return [firstPage, ...remainingPages].flatMap((page) => page.data);
}

export async function createAdminStoreGroup(
  input: CreateStoreGroupRequest,
  idempotencyKey: string,
): Promise<StoreGroup> {
  const payload = await requestAdminApi('/store-groups', {
    body: JSON.stringify(CreateStoreGroupRequestSchema.parse(input)),
    headers: { 'Idempotency-Key': idempotencyKey },
    method: 'POST',
  });
  return StoreGroupResponseSchema.parse(payload).data;
}

export async function updateAdminStoreGroup(
  groupId: string,
  input: UpdateStoreGroupRequest,
  idempotencyKey: string,
): Promise<StoreGroup> {
  const payload = await requestAdminApi(`/store-groups/${encodeURIComponent(groupId)}`, {
    body: JSON.stringify(UpdateStoreGroupRequestSchema.parse(input)),
    headers: { 'Idempotency-Key': idempotencyKey },
    method: 'PATCH',
  });
  return StoreGroupResponseSchema.parse(payload).data;
}

export async function createAdminStore(
  input: CreateStoreRequest,
  idempotencyKey: string,
): Promise<Store> {
  const payload = await requestAdminApi('/stores', {
    body: JSON.stringify(CreateStoreRequestSchema.parse(input)),
    headers: { 'Idempotency-Key': idempotencyKey },
    method: 'POST',
  });
  return StoreResponseSchema.parse(payload).data;
}

export async function updateAdminStore(
  storeId: string,
  input: UpdateStoreRequest,
  idempotencyKey: string,
): Promise<Store> {
  const payload = await requestAdminApi(`/stores/${encodeURIComponent(storeId)}`, {
    body: JSON.stringify(UpdateStoreRequestSchema.parse(input)),
    headers: { 'Idempotency-Key': idempotencyKey },
    method: 'PATCH',
  });
  return StoreResponseSchema.parse(payload).data;
}

/** Phân quyền HTKD áp dụng cho mọi cửa hàng đang hoạt động, gồm cả cửa hàng sỉ. */
export async function listActiveStoreChoicesForAssignments(query: {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
}): Promise<AdminPage<Store>> {
  const payload = await requestAdminApi(`/stores?${queryString({ ...query, status: 'ACTIVE' })}`);
  return ListStoresResponseSchema.parse(payload);
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

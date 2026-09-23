import {
  ErrorEnvelopeSchema,
  GetIdosiStatisticsQuerySchema,
  IdosiStatisticsStateResponseSchema,
  ListIdosiStatisticsResponseSchema,
  SyncIdosiStatisticsRequestSchema,
  type IdosiStatisticsScope,
  type IdosiStatisticsState,
} from '@idosi/contracts';
import { reportUnauthorizedResponse } from '../../lib/session-expiry';
import { addTabSessionHeader } from '../../lib/tab-session';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/u, '');

export class IdosiStatisticsApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId: string | undefined;

  public constructor(message: string, status: number, code = 'HTTP_ERROR', requestId?: string) {
    super(message);
    this.name = 'IdosiStatisticsApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
  addTabSessionHeader(headers);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      credentials: 'include',
      headers,
    });
  } catch {
    throw new IdosiStatisticsApiError(
      'Không thể kết nối máy chủ để tải thống kê IDOSI.',
      0,
      'NETWORK_ERROR',
    );
  }

  reportUnauthorizedResponse(response.status, path);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      throw new IdosiStatisticsApiError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    }
    throw new IdosiStatisticsApiError(
      `Yêu cầu thống kê IDOSI thất bại (${response.status}).`,
      response.status,
    );
  }
  return payload;
}

function scopeQuery(scope: IdosiStatisticsScope): string {
  const query = new URLSearchParams({ storeId: scope.storeId, period: scope.period });
  if (scope.date !== null) query.set('date', scope.date);
  if (scope.shiftId !== null) query.set('shiftId', scope.shiftId);
  if (scope.paymentMethod !== null) query.set('paymentMethod', scope.paymentMethod);
  return query.toString();
}

export async function getIdosiStatistics(
  input: IdosiStatisticsScope,
): Promise<IdosiStatisticsState> {
  const scope = GetIdosiStatisticsQuerySchema.parse(input);
  const payload = await request(`/integrations/idosi/order-statistics?${scopeQuery(scope)}`);
  return IdosiStatisticsStateResponseSchema.parse(payload).data;
}

export async function listIdosiStatistics(
  period: string,
  storeId?: string,
): Promise<IdosiStatisticsState[]> {
  const load = async (page: number) => {
    const query = new URLSearchParams({ period, page: String(page), pageSize: '100' });
    if (storeId) query.set('storeId', storeId);
    return ListIdosiStatisticsResponseSchema.parse(
      await request(`/integrations/idosi/statistics-summary?${query}`),
    );
  };
  const first = await load(1);
  const states = [...first.data];
  for (let page = 2; page <= first.pagination.totalPages; page += 1)
    states.push(...(await load(page)).data);
  return states;
}

export async function syncIdosiStatistics(
  input: IdosiStatisticsScope,
): Promise<IdosiStatisticsState> {
  const scope = SyncIdosiStatisticsRequestSchema.parse(input);
  const payload = await request('/integrations/idosi/order-statistics/sync', {
    body: JSON.stringify(scope),
    method: 'POST',
  });
  return IdosiStatisticsStateResponseSchema.parse(payload).data;
}

export function idosiStatisticsErrorMessage(error: unknown): string {
  if (error instanceof IdosiStatisticsApiError) {
    const reference = error.requestId ? ` Mã yêu cầu: ${error.requestId}.` : '';
    return `${error.message}${reference}`;
  }
  return 'Máy chủ trả về dữ liệu thống kê IDOSI không hợp lệ.';
}

/** Resolve the authorized month/store scope, then refresh each source snapshot once. */
export async function syncIdosiSalesSummary(period: string, storeId?: string) {
  const states = await listIdosiStatistics(period, storeId);
  const failures: string[] = [];
  let succeeded = 0;
  for (const state of states) {
    try {
      await syncIdosiStatistics(state.scope);
      succeeded += 1;
    } catch (error) {
      if (error instanceof IdosiStatisticsApiError && [401, 403].includes(error.status))
        throw error;
      failures.push(
        `${state.snapshot?.payload.store.name ?? state.scope.storeId}: ${idosiStatisticsErrorMessage(error)}`,
      );
    }
  }
  return { succeeded, total: states.length, failures };
}

import {
  ErrorEnvelopeSchema,
  GetSessionResponseSchema,
  ListOrderSessionsResponseSchema,
  ListPriorityOffersResponseSchema,
  ListReceiptsResponseSchema,
  ListStoreOrderRequestsResponseSchema,
  ListStoresResponseSchema,
  ListWaitTicketsResponseSchema,
  MonthlyOperationalReportResponseSchema,
  type MonthlyOperationalReport,
  type OrderSession,
  type PriorityOffer,
  type Receipt,
  type Session,
  type Store,
  type StoreOrderRequest,
  type WaitTicket,
} from '@idosi/contracts';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
const apiBaseUrl = (configuredBaseUrl || '/api/v1').replace(/\/$/, '');

export class DashboardApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(message: string, status: number, code = 'HTTP_ERROR', requestId?: string) {
    super(message);
    this.name = 'DashboardApiError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

async function request(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new DashboardApiError(
      'Không thể kết nối máy chủ. Dashboard không hiển thị số liệu dự phòng.',
      0,
      'NETWORK_ERROR',
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      throw new DashboardApiError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.error.requestId,
      );
    }
    throw new DashboardApiError(
      `Yêu cầu dashboard thất bại (${response.status}).`,
      response.status,
    );
  }
  return payload;
}

export interface DashboardBootstrap {
  readonly session: Session;
  readonly stores: Store[];
}

export type DashboardScope =
  { readonly kind: 'ALL' } | { readonly kind: 'STORE'; readonly storeId: string };

export interface DashboardSnapshot {
  readonly orderRequests: StoreOrderRequest[];
  readonly orderSessions: OrderSession[];
  readonly priorityOffers: PriorityOffer[];
  readonly receipts: Receipt[];
  readonly report: MonthlyOperationalReport;
  readonly waitTickets: WaitTicket[];
}

export interface DashboardSnapshotInput {
  readonly month: number;
  readonly scope: DashboardScope;
  readonly year: number;
}

function paginatedPath(path: string, scope: DashboardScope): string {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  if (scope.kind === 'STORE') query.set('storeId', scope.storeId);
  return `${path}?${query.toString()}`;
}

export async function loadDashboardBootstrap(): Promise<DashboardBootstrap> {
  const [sessionPayload, storesPayload] = await Promise.all([
    request('/auth/session'),
    request('/stores?page=1&pageSize=100'),
  ]);
  return {
    session: GetSessionResponseSchema.parse(sessionPayload).data,
    stores: ListStoresResponseSchema.parse(storesPayload).data,
  };
}

export async function loadDashboardSnapshot(
  input: DashboardSnapshotInput,
): Promise<DashboardSnapshot> {
  const reportQuery = new URLSearchParams({
    month: String(input.month),
    scopeKind: input.scope.kind,
    year: String(input.year),
  });
  if (input.scope.kind === 'STORE') reportQuery.set('scopeId', input.scope.storeId);

  const [
    reportPayload,
    receiptsPayload,
    waitTicketsPayload,
    priorityOffersPayload,
    orderSessionsPayload,
    orderRequestsPayload,
  ] = await Promise.all([
    request(`/reports/monthly?${reportQuery.toString()}`),
    request(paginatedPath('/store-receipts', input.scope)),
    request(paginatedPath('/wait-tickets', input.scope)),
    request(paginatedPath('/priority-offers', input.scope)),
    request('/order-sessions?page=1&pageSize=100'),
    request(paginatedPath('/order-requests', input.scope)),
  ]);

  return {
    orderRequests: ListStoreOrderRequestsResponseSchema.parse(orderRequestsPayload).data,
    orderSessions: ListOrderSessionsResponseSchema.parse(orderSessionsPayload).data,
    priorityOffers: ListPriorityOffersResponseSchema.parse(priorityOffersPayload).data,
    receipts: ListReceiptsResponseSchema.parse(receiptsPayload).data,
    report: MonthlyOperationalReportResponseSchema.parse(reportPayload).data,
    waitTickets: ListWaitTicketsResponseSchema.parse(waitTicketsPayload).data,
  };
}

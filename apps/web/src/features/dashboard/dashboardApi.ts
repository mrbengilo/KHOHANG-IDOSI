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
import { reportUnauthorizedResponse } from '../../lib/session-expiry';

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

  reportUnauthorizedResponse(response.status, path);
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

interface ParsedPage<T> {
  readonly data: T[];
  readonly pagination: { readonly totalPages: number };
}

function paginatedQuery(scope: DashboardScope | null, page: number): string {
  const query = new URLSearchParams({ page: '1', pageSize: '100' });
  query.set('page', String(page));
  if (scope?.kind === 'STORE') query.set('storeId', scope.storeId);
  return query.toString();
}

async function loadAllPages<T>(
  path: string,
  scope: DashboardScope | null,
  parse: (payload: unknown) => ParsedPage<T>,
): Promise<T[]> {
  const first = parse(await request(`${path}?${paginatedQuery(scope, 1)}`));
  if (first.pagination.totalPages <= 1) return first.data;
  const remaining = await Promise.all(
    Array.from({ length: first.pagination.totalPages - 1 }, async (_, index) =>
      parse(await request(`${path}?${paginatedQuery(scope, index + 2)}`)),
    ),
  );
  return [first, ...remaining].flatMap((page) => page.data);
}

export async function loadDashboardBootstrap(): Promise<DashboardBootstrap> {
  const [sessionPayload, stores] = await Promise.all([
    request('/auth/session'),
    loadAllPages('/stores', null, (payload) => ListStoresResponseSchema.parse(payload)),
  ]);
  return {
    session: GetSessionResponseSchema.parse(sessionPayload).data,
    stores: stores.filter((store) => store.status === 'ACTIVE'),
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

  const [reportPayload, receipts, waitTickets, priorityOffers, orderSessions, orderRequests] =
    await Promise.all([
      request(`/reports/monthly?${reportQuery.toString()}`),
      loadAllPages('/store-receipts', input.scope, (payload) =>
        ListReceiptsResponseSchema.parse(payload),
      ),
      loadAllPages('/wait-tickets', input.scope, (payload) =>
        ListWaitTicketsResponseSchema.parse(payload),
      ),
      loadAllPages('/priority-offers', input.scope, (payload) =>
        ListPriorityOffersResponseSchema.parse(payload),
      ),
      loadAllPages('/order-sessions', null, (payload) =>
        ListOrderSessionsResponseSchema.parse(payload),
      ),
      loadAllPages('/order-requests', input.scope, (payload) =>
        ListStoreOrderRequestsResponseSchema.parse(payload),
      ),
    ]);

  return {
    orderRequests,
    orderSessions,
    priorityOffers,
    receipts,
    report: MonthlyOperationalReportResponseSchema.parse(reportPayload).data,
    waitTickets,
  };
}

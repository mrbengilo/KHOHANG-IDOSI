import {
  AllocationDecisionResponseSchema,
  ListAllocationDecisionsResponseSchema,
  RespondAllocationDecisionRequestSchema,
  type AllocationDecision,
  type AllocationDecisionDetail,
  type AllocationDecisionStatus,
  type ListAllocationDecisionsResponse,
  type RespondAllocationDecisionRequest,
} from '@idosi/contracts';

import { ApiClientError, request } from '../../lib/api';

export interface AllocationDecisionFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: AllocationDecisionStatus;
  readonly storeId?: string;
  readonly sessionId?: string;
  readonly outboundRequestId?: string;
}

/** Every key starts with the account so a different login never reads another scope's cache. */
export const allocationDecisionKeys = {
  all: ['allocation-decisions'] as const,
  list: (accountKey: string, filters: AllocationDecisionFilters) =>
    ['allocation-decisions', accountKey, 'list', filters] as const,
  detail: (accountKey: string, decisionId: string) =>
    ['allocation-decisions', accountKey, 'detail', decisionId] as const,
};

export async function listAllocationDecisions(
  filters: AllocationDecisionFilters = {},
): Promise<ListAllocationDecisionsResponse> {
  const query = new URLSearchParams({
    page: String(filters.page ?? 1),
    pageSize: String(filters.pageSize ?? 20),
    // Ask for allowedActions and the RE order (opt-in: older bundles keep the older shape).
    includeReshare: 'true',
  });
  if (filters.status) query.set('status', filters.status);
  if (filters.storeId) query.set('storeId', filters.storeId);
  if (filters.sessionId) query.set('sessionId', filters.sessionId);
  if (filters.outboundRequestId) query.set('outboundRequestId', filters.outboundRequestId);
  return ListAllocationDecisionsResponseSchema.parse(
    await request(`/allocation-decisions?${query.toString()}`),
  );
}

export async function getAllocationDecision(decisionId: string): Promise<AllocationDecisionDetail> {
  return AllocationDecisionResponseSchema.parse(
    await request(`/allocation-decisions/${encodeURIComponent(decisionId)}?includeReshare=true`),
  ).data;
}

export async function respondAllocationDecision(
  decisionId: string,
  input: RespondAllocationDecisionRequest,
  idempotencyKey: string,
): Promise<AllocationDecisionDetail> {
  const body = RespondAllocationDecisionRequestSchema.parse(input);
  return AllocationDecisionResponseSchema.parse(
    await request(
      `/allocation-decisions/${encodeURIComponent(decisionId)}/respond?includeReshare=true`,
      {
        body: JSON.stringify(body),
        headers: { 'idempotency-key': idempotencyKey },
        method: 'POST',
      },
    ),
  ).data;
}

/**
 * Whether a failed answer may already have been recorded. Only a lost connection or a timeout
 * leaves the outcome unknown: the retry must reuse the same key and body. A server refusal
 * (validation, permission, conflict) is a definite answer and never retried with that key.
 */
export function isUncertainOutcome(error: unknown): boolean {
  if (error instanceof ApiClientError) return error.status === 0 || error.status >= 500;
  if (error instanceof DOMException)
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  return error instanceof TypeError;
}

export function respondErrorMessage(error: unknown): string {
  if (isUncertainOutcome(error)) {
    return 'Chưa rõ máy chủ đã ghi nhận phản hồi hay chưa. Bấm lại đúng nút vừa chọn để gửi lại an toàn; hệ thống không ghi nhận hai lần.';
  }
  if (error instanceof ApiClientError) {
    if (error.status === 409 || error.status === 404 || error.status === 403) return error.message;
    if (error.status === 400) return 'Nội dung phản hồi không hợp lệ. Vui lòng kiểm tra lại.';
    return error.message;
  }
  return 'Không thể ghi nhận phản hồi. Vui lòng thử lại.';
}

export const decisionStatusLabel: Record<AllocationDecisionStatus, string> = {
  PENDING: 'Chờ xác nhận',
  ACCEPTED: 'Đã chấp nhận',
  REJECTED: 'đã từ chối nhận',
  NOT_REQUIRED: 'Không cần xác nhận',
  LEGACY: 'Theo quy trình cũ',
};

export const decisionStatusTone: Record<
  AllocationDecisionStatus,
  'warning' | 'success' | 'danger' | 'neutral'
> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  NOT_REQUIRED: 'neutral',
  LEGACY: 'neutral',
};

/** Human code of a result: session code plus a short store-scoped suffix of the decision. */
export function decisionCode(decision: Pick<AllocationDecision, 'id' | 'sessionCode'>): string {
  return `KQ-${decision.sessionCode}-${decision.id.slice(0, 8).toUpperCase()}`;
}

/** Actions the current account may take; an assigned HTKD may only accept. */
export function decisionActions(
  decision: Pick<AllocationDecision, 'canRespond' | 'allowedActions'>,
): readonly ('ACCEPT' | 'REJECT')[] {
  if (decision.allowedActions) return decision.allowedActions;
  return decision.canRespond ? ['ACCEPT', 'REJECT'] : [];
}

/** Deep link to the RE order in the history ("Đơn đặt Reshare"). */
export function reshareOrderLink(code: string): string {
  return `/supplier-reconciliation?tab=orders&code=${encodeURIComponent(code)}`;
}

/** Delivery progress, kept apart from the store's answer: accepted is not received. */
export function shipmentProgressLabel(decision: AllocationDecision): string {
  if (decision.status === 'REJECTED') return 'Không giao: cửa hàng đã từ chối nhận';
  if (decision.status === 'PENDING') return 'Chờ cửa hàng xác nhận trước khi giao';
  const shipment = decision.shipment;
  if (!shipment) {
    if (decision.grantedQuantity === 0) return 'Không có hàng cấp mới';
    return decision.reshareOrder
      ? 'Đã xuất kho theo đơn RE, chờ ghép chuyến giao với đơn thường kế tiếp'
      : 'Đang giữ tại kho, giao chung với đơn thường kế tiếp';
  }
  if (shipment.receiptStatus === 'FINALIZED') return 'HTKD đã duyệt thực nhận';
  if (shipment.receiptStatus === 'PENDING_HTKD') return 'Đã khai nhận, chờ HTKD duyệt';
  if (shipment.receiptStatus === 'DRAFT' || shipment.receiptStatus === 'RETURNED') {
    return 'Đang khai nhận tại cửa hàng';
  }
  if (shipment.status === 'DISPATCHED') return 'Đã giao đi, chờ cửa hàng khai nhận';
  if (shipment.status === 'RESERVED') return 'Đang giữ hàng, chờ xuất kho';
  if (shipment.status === 'CANCELLED') return 'Chuyến giao đã hủy';
  return 'Đã hoàn tất nhận hàng';
}

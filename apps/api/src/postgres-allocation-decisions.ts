import type {
  AllocationDecision,
  AllocationDecisionDetail,
  AuthenticatedPrincipal,
  ListAllocationDecisionsQuery,
  ListReshareOrdersQuery,
  ListReshareOrdersResponse,
  RespondAllocationDecisionRequest,
} from '@idosi/contracts';
import {
  AllocationDecisionConflictError,
  AllocationDecisionForbiddenError,
  AllocationDecisionIntegrityError,
  AllocationDecisionNotFoundError,
  AllocationDecisionValidationError,
  allocationResultDecisions,
  databaseDecisionStatus,
  domainDecisionStatus,
  getAllocationDecision,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  listAllocationDecisions,
  listReshareOrderHistory,
  loadReshareOrderSummaries,
  ReshareOrderIntegrityError,
  ReshareOrderStockError,
  respondAllocationDecision,
  stores,
  type ReshareHistoryRow,
  type ReshareOrderSummary,
  type AllocationDecisionDetailRecord,
  type AllocationDecisionRecord,
  type Database,
} from '@idosi/database';
import { eq, inArray } from 'drizzle-orm';

import { ApiError, conflict, forbidden, notFound } from './errors.js';
import type {
  AllocationDecisionView,
  IdempotentResource,
  Page,
  RequestContext,
} from './repository.js';
import { allocationDecisionActionsFor, canAccessStore, pagination } from './repository.js';

const NOT_FOUND_MESSAGE = 'Không tìm thấy phiếu kết quả phân bổ';

type StoreFacts = {
  readonly id: string;
  readonly kind: 'RETAIL' | 'WHOLESALE';
  readonly active: boolean;
};

/** Server-authorized store scope; undefined means every store (Admin only). */
function decisionStoreScope(
  actor: AuthenticatedPrincipal,
  storeId: string | undefined,
): readonly string[] | undefined {
  if (storeId !== undefined) {
    if (!canAccessStore(actor, storeId)) throw forbidden();
    return [storeId];
  }
  if (actor.role === 'ADMIN') return undefined;
  if (actor.role === 'STORE') return actor.storeId === null ? [] : [actor.storeId];
  return actor.assignedStoreIds;
}

async function loadStoreFacts(
  database: Database,
  storeIds: readonly string[],
): Promise<Map<string, StoreFacts>> {
  const unique = [...new Set(storeIds)];
  if (unique.length === 0) return new Map();
  const rows = await database
    .select({
      id: stores.id,
      kind: stores.kind,
      isActive: stores.isActive,
      deletedAt: stores.deletedAt,
    })
    .from(stores)
    .where(inArray(stores.id, unique));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: row.kind === 'wholesale' ? 'WHOLESALE' : 'RETAIL',
        active: row.isActive && row.deletedAt === null,
      },
    ]),
  );
}

type AnswerActions = readonly ('ACCEPT' | 'REJECT')[];

export function allocationDecisionDto(
  record: AllocationDecisionRecord,
  actions: AnswerActions,
  reshare?: { readonly order: ReshareOrderSummary | null },
): AllocationDecision {
  const allowedActions = record.status === 'pending' ? [...actions] : [];
  const includeReshare = reshare !== undefined;
  return {
    id: record.id,
    allocationRunId: record.allocationRunId,
    runVersion: record.runNumber,
    sessionId: record.orderSessionId,
    sessionCode: record.sessionCode,
    businessDate: record.businessDate,
    storeId: record.storeId,
    status: domainDecisionStatus(record.status),
    version: record.version,
    grantedQuantity: record.grantedQuantity,
    origin: record.origin === 'legacy_backfill' ? 'LEGACY_BACKFILL' : 'ALLOCATION_RUN',
    canRespond: allowedActions.length > 0,
    ...(includeReshare
      ? {
          allowedActions,
          reshareOrder: reshare.order
            ? {
                id: reshare.order.id,
                code: reshare.order.code,
                status: reshare.order.status === 'cancelled' ? 'CANCELLED' : 'ORDERED',
                orderedAt: reshare.order.orderedAt.toISOString(),
                totalQuantity: reshare.order.totalQuantity,
              }
            : null,
        }
      : {}),
    respondedAt: record.respondedAt?.toISOString() ?? null,
    respondedByAccountId: record.respondedByUserId,
    respondedByName: record.respondedByName,
    reason: record.responseReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lines: record.lines.map((line) => ({ ...line })),
    carried: record.carried.map((row) => ({
      reservationId: row.reservationId,
      allocationLineId: row.allocationLineId,
      allocationRunId: row.allocationRunId,
      sessionId: row.orderSessionId,
      productId: row.productId,
      quantity: row.quantity,
      // Older bundles do not know ISSUED: for them an issued hold reads as still held.
      reservationStatus: (row.reservationStatus === 'issued' && !includeReshare
        ? 'ACTIVE'
        : row.reservationStatus.toUpperCase()) as AllocationDecision['carried'][number]['reservationStatus'],
      waitTicketId: row.waitTicketId,
      sourceDecisionStatus:
        row.sourceDecisionStatus === null ? null : domainDecisionStatus(row.sourceDecisionStatus),
    })),
    heldQuantity: record.heldQuantity,
    releasedQuantity: record.releasedQuantity,
    shipment: record.shipment
      ? {
          outboundRequestId: record.shipment.outboundRequestId,
          requestNumber: record.shipment.requestNumber,
          status: record.shipment.status.toUpperCase() as NonNullable<
            AllocationDecision['shipment']
          >['status'],
          dispatchedAt: record.shipment.dispatchedAt?.toISOString() ?? null,
          receiptId: record.shipment.receiptId,
          receiptNumber: record.shipment.receiptNumber,
          receiptStatus:
            record.shipment.receiptStatus === null
              ? null
              : (record.shipment.receiptStatus.toUpperCase() as NonNullable<
                  NonNullable<AllocationDecision['shipment']>['receiptStatus']
                >),
        }
      : null,
  };
}

function detailDto(
  record: AllocationDecisionDetailRecord,
  actions: AnswerActions,
  reshare?: { readonly order: ReshareOrderSummary | null },
): AllocationDecisionDetail {
  return {
    ...allocationDecisionDto(record, actions, reshare),
    sources: record.sources.map((source) => ({
      allocationLineId: source.allocationLineId,
      productId: source.productId,
      priority: source.priorityLevel,
      requestedQuantity: source.requestedQuantity,
      allocatedQuantity: source.allocatedQuantity,
      waitlistedQuantity: source.waitlistedQuantity,
      orderRequestId: source.orderRequestId,
      orderRequestCode: source.orderRequestCode,
      waitTicketId: source.waitTicketId,
      priorityOfferId: source.priorityOfferId,
    })),
  };
}

/** Attach the server-computed answer right to records of one page, one store query. */
export async function decisionDtosFor(
  database: Database,
  actor: AuthenticatedPrincipal,
  records: readonly AllocationDecisionRecord[],
  view: AllocationDecisionView = {},
): Promise<AllocationDecision[]> {
  const facts = await loadStoreFacts(
    database,
    records.map((record) => record.storeId),
  );
  const orders = view.includeReshare
    ? await loadReshareOrderSummaries(
        database,
        records.map((record) => record.id),
      )
    : null;
  return records.map((record) => {
    const store = facts.get(record.storeId);
    return allocationDecisionDto(
      record,
      store ? allocationDecisionActionsFor(actor, store) : [],
      orders ? { order: orders.get(record.id) ?? null } : undefined,
    );
  });
}

export async function listPostgresAllocationDecisions(
  database: Database,
  actor: AuthenticatedPrincipal,
  query: ListAllocationDecisionsQuery,
): Promise<Page<AllocationDecision>> {
  const storeIds = decisionStoreScope(actor, query.storeId);
  const result = await listAllocationDecisions(database, {
    page: query.page,
    pageSize: query.pageSize,
    ...(storeIds === undefined ? {} : { storeIds }),
    ...(query.status === undefined ? {} : { status: databaseDecisionStatus(query.status) }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.outboundRequestId === undefined
      ? {}
      : { outboundRequestId: query.outboundRequestId }),
  });
  return {
    data: await decisionDtosFor(database, actor, result.data, {
      includeReshare: query.includeReshare === true,
    }),
    pagination: result.pagination,
  };
}

export async function getPostgresAllocationDecision(
  database: Database,
  actor: AuthenticatedPrincipal,
  decisionId: string,
  view: AllocationDecisionView = {},
): Promise<AllocationDecisionDetail> {
  let record: AllocationDecisionDetailRecord;
  try {
    record = await getAllocationDecision(database, decisionId);
  } catch (error: unknown) {
    if (error instanceof AllocationDecisionNotFoundError) throw notFound(NOT_FOUND_MESSAGE);
    throw error;
  }
  // Outside the caller's scope reads exactly like an unknown id.
  if (!canAccessStore(actor, record.storeId)) throw notFound(NOT_FOUND_MESSAGE);
  const facts = await loadStoreFacts(database, [record.storeId]);
  const store = facts.get(record.storeId);
  const order = view.includeReshare
    ? ((await loadReshareOrderSummaries(database, [record.id])).get(record.id) ?? null)
    : undefined;
  return detailDto(
    record,
    store ? allocationDecisionActionsFor(actor, store) : [],
    order === undefined ? undefined : { order },
  );
}

export async function respondPostgresAllocationDecision(
  database: Database,
  actor: AuthenticatedPrincipal,
  decisionId: string,
  input: RespondAllocationDecisionRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
  authorizeRetailStore: () => Promise<void>,
  view: AllocationDecisionView = {},
): Promise<IdempotentResource<AllocationDecisionDetail>> {
  // An assigned HTKD may accept for the store, never reject; Admin only reads.
  if (actor.role !== 'STORE' && actor.role !== 'WHOLESALE' && actor.role !== 'HTKD') {
    throw forbidden();
  }
  if (actor.role === 'HTKD' && input.action !== 'ACCEPT') {
    throw forbidden('HTKD chỉ được chấp nhận kết quả phân bổ thay cửa hàng, không được từ chối.');
  }
  if (actor.role === 'STORE') await authorizeRetailStore();
  const [located] = await database
    .select({ storeId: allocationResultDecisions.storeId })
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, decisionId))
    .limit(1);
  if (!located || !canAccessStore(actor, located.storeId)) throw notFound(NOT_FOUND_MESSAGE);
  const facts = await loadStoreFacts(database, [located.storeId]);
  const store = facts.get(located.storeId);
  if (!store || !allocationDecisionActionsFor(actor, store).includes(input.action)) {
    throw forbidden();
  }
  try {
    const result = await respondAllocationDecision(database, {
      decisionId,
      action: input.action,
      expectedVersion: input.expectedVersion,
      reason: input.reason ?? null,
      actorUserId: actor.accountId,
      requestId: context.requestId,
      idempotencyKey,
      requestHash,
    });
    return {
      data: await getPostgresAllocationDecision(database, actor, decisionId, view),
      replayed: result.replayed,
    };
  } catch (error: unknown) {
    throw allocationDecisionApiError(error);
  }
}

function allocationDecisionApiError(error: unknown): unknown {
  if (error instanceof AllocationDecisionNotFoundError) return notFound(NOT_FOUND_MESSAGE);
  if (error instanceof AllocationDecisionForbiddenError) return forbidden();
  if (error instanceof AllocationDecisionValidationError) {
    return new ApiError('VALIDATION_ERROR', error.message, 400);
  }
  if (error instanceof AllocationDecisionConflictError) {
    const message =
      error.reason === 'STALE_VERSION'
        ? 'Phiếu kết quả đã thay đổi. Vui lòng tải lại để xem trạng thái mới nhất.'
        : error.reason === 'ALREADY_ANSWERED'
          ? error.currentStatus === 'ACCEPTED'
            ? 'Phiếu kết quả này đã được chấp nhận trước đó.'
            : 'Phiếu kết quả này đã được từ chối nhận trước đó.'
          : 'Phiếu kết quả này không cần cửa hàng xác nhận.';
    return new ApiError(
      error.reason === 'STALE_VERSION' ? 'VERSION_CONFLICT' : 'INVALID_STATE_TRANSITION',
      message,
      409,
      {
        reason: error.reason,
        currentStatus: error.currentStatus,
        currentVersion: error.currentVersion,
      },
    );
  }
  if (error instanceof ReshareOrderStockError) {
    return new ApiError(
      'INSUFFICIENT_STOCK',
      'Kho tổng không đủ hàng đang giữ để xuất theo đơn Reshare của phiếu này; chưa có gì được ghi nhận. Vui lòng báo quản trị viên kiểm tra tồn kho.',
      409,
      { productId: error.productId, quantity: error.quantity },
    );
  }
  if (
    error instanceof AllocationDecisionIntegrityError ||
    error instanceof ReshareOrderIntegrityError
  ) {
    return conflict('Dữ liệu phân bổ của phiếu không nhất quán; vui lòng báo quản trị viên.');
  }
  if (error instanceof IdempotencyConflictError) {
    return new ApiError(
      'IDEMPOTENCY_CONFLICT',
      'Khóa idempotency đã được dùng cho nội dung khác',
      409,
    );
  }
  if (error instanceof IdempotencyInProgressError) {
    return conflict('Yêu cầu cùng khóa idempotency đang được xử lý');
  }
  return error;
}

const ROLE_DTO = { store: 'STORE', wholesale: 'WHOLESALE', htkd: 'HTKD', admin: 'ADMIN' } as const;

function reshareHistoryDto(row: ReshareHistoryRow): ListReshareOrdersResponse['data'][number] {
  return {
    decisionId: row.decisionId,
    decisionStatus: row.decisionStatus === 'pending' ? 'PENDING' : 'ACCEPTED',
    sessionId: row.sessionId,
    sessionCode: row.sessionCode,
    businessDate: row.businessDate,
    runVersion: row.runNumber,
    sessionOpenedAt: row.sessionOpenedAt?.toISOString() ?? null,
    allocationCompletedAt: row.allocationCompletedAt?.toISOString() ?? null,
    publishedAt: row.publishedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedByName: row.respondedByName,
    storeId: row.storeId,
    storeName: row.storeName,
    status:
      row.status === 'ordered'
        ? 'ORDERED'
        : row.status === 'cancelled'
          ? 'CANCELLED'
          : 'NOT_ORDERED',
    order: row.order
      ? {
          id: row.order.id,
          code: row.order.code,
          orderedAt: row.order.orderedAt.toISOString(),
          origin: row.order.origin === 'backfill' ? 'BACKFILL' : 'ACCEPTANCE',
          actorName: row.order.actorName,
          actorRole: ROLE_DTO[row.order.actorRole as keyof typeof ROLE_DTO] ?? 'ADMIN',
          cancelledAt: row.order.cancelledAt?.toISOString() ?? null,
          cancelReason: row.order.cancelReason,
        }
      : null,
    lines: row.lines.map((line) => ({ ...line })),
    totalQuantity: row.totalQuantity,
    delivery: row.delivery ? { ...row.delivery } : null,
  };
}

/** Admin sees every store; HTKD, store and wholesale desk only their stores (server scope). */
export async function listPostgresReshareOrders(
  database: Database,
  actor: AuthenticatedPrincipal,
  query: ListReshareOrdersQuery,
): Promise<ListReshareOrdersResponse> {
  const storeIds = decisionStoreScope(actor, query.storeId);
  const result = await listReshareOrderHistory(database, {
    page: query.page,
    pageSize: query.pageSize,
    ...(storeIds === undefined ? {} : { storeIds }),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.status
      ? {
          status:
            query.status === 'ORDERED'
              ? ('ordered' as const)
              : query.status === 'CANCELLED'
                ? ('cancelled' as const)
                : ('not_ordered' as const),
        }
      : {}),
    ...(query.from ? { from: new Date(query.from) } : {}),
    ...(query.to ? { to: new Date(query.to) } : {}),
    ...(query.code ? { code: query.code } : {}),
    ...(query.decisionId ? { decisionId: query.decisionId } : {}),
  });
  return {
    data: result.data.map(reshareHistoryDto),
    pagination: pagination(query.page, query.pageSize, result.pagination.totalItems),
    scoped: actor.role !== 'ADMIN',
  };
}

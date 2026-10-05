import type {
  AllocationDecision,
  AllocationDecisionDetail,
  AuthenticatedPrincipal,
  ListAllocationDecisionsQuery,
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
  respondAllocationDecision,
  stores,
  type AllocationDecisionDetailRecord,
  type AllocationDecisionRecord,
  type Database,
} from '@idosi/database';
import { eq, inArray } from 'drizzle-orm';

import { ApiError, conflict, forbidden, notFound } from './errors.js';
import type { IdempotentResource, Page, RequestContext } from './repository.js';
import { canAccessStore, mayAnswerAllocationDecision } from './repository.js';

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

export function allocationDecisionDto(
  record: AllocationDecisionRecord,
  canRespond: boolean,
): AllocationDecision {
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
    canRespond: canRespond && record.status === 'pending',
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
      reservationStatus:
        row.reservationStatus.toUpperCase() as AllocationDecision['carried'][number]['reservationStatus'],
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
  canRespond: boolean,
): AllocationDecisionDetail {
  return {
    ...allocationDecisionDto(record, canRespond),
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
): Promise<AllocationDecision[]> {
  const facts = await loadStoreFacts(
    database,
    records.map((record) => record.storeId),
  );
  return records.map((record) => {
    const store = facts.get(record.storeId);
    return allocationDecisionDto(record, store ? mayAnswerAllocationDecision(actor, store) : false);
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
  });
  return {
    data: await decisionDtosFor(database, actor, result.data),
    pagination: result.pagination,
  };
}

export async function getPostgresAllocationDecision(
  database: Database,
  actor: AuthenticatedPrincipal,
  decisionId: string,
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
  return detailDto(record, store ? mayAnswerAllocationDecision(actor, store) : false);
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
): Promise<IdempotentResource<AllocationDecisionDetail>> {
  if (actor.role !== 'STORE' && actor.role !== 'WHOLESALE') throw forbidden();
  if (actor.role === 'STORE') await authorizeRetailStore();
  const [located] = await database
    .select({ storeId: allocationResultDecisions.storeId })
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, decisionId))
    .limit(1);
  if (!located || !canAccessStore(actor, located.storeId)) throw notFound(NOT_FOUND_MESSAGE);
  const facts = await loadStoreFacts(database, [located.storeId]);
  const store = facts.get(located.storeId);
  if (!store || !mayAnswerAllocationDecision(actor, store)) throw forbidden();
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
      data: await getPostgresAllocationDecision(database, actor, decisionId),
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
  if (error instanceof AllocationDecisionIntegrityError) {
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

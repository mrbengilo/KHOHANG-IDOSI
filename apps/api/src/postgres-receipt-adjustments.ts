import type {
  AuthenticatedPrincipal,
  CreateReceiptAdjustmentRequest,
  CreateReceiptReturnRequest,
  ListReceiptAdjustmentsQuery,
  ListReceiptReturnsQuery,
  ReceiptAdjustment,
  ReceiptAdjustmentActionRequest,
  ReceiptAdjustmentContext,
  ReceiptAdjustmentListItem,
  ReceiptAdjustmentSummary,
  ReceiptMoney,
  ReceiptReturn,
  ReceiptReturnActionRequest,
  StoreInventoryBag,
} from '@idosi/contracts';
import {
  allowedReceiptAdjustmentActions,
  createReceiptAdjustment,
  createReceiptReturn,
  getReceiptAdjustment,
  getReceiptAdjustmentContext,
  getReceiptReturn,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  listReceiptAdjustments,
  listReceiptReturns,
  ReceiptAdjustmentAuthorizationError,
  ReceiptAdjustmentBlockedError,
  receiptAdjustmentMoneySummary,
  StoreOperationConflictError,
  StoreOperationValidationError,
  transitionReceiptAdjustment,
  transitionReceiptReturn,
  type Database,
  type ReceiptAdjustmentDatabaseStatus,
  type ReceiptAdjustmentMoneySummary,
  type ReceiptAdjustmentRecord,
  type ReceiptAdjustmentSummaryRecord,
  type ReceiptAdjustmentTransitionInput,
  type ReceiptReturnDatabaseStatus,
  type ReceiptReturnRecord,
  type ReceiptReturnTransitionInput,
} from '@idosi/database';

import { ApiError, conflict, forbidden, notFound } from './errors.js';
import type { IdempotentResource, Page, RequestContext } from './repository.js';
import { canAccessStore, pagination } from './repository.js';

type Role = 'ADMIN' | 'HTKD' | 'STORE';

/**
 * Receipt discrepancy adjustments are an Admin/HTKD/store workflow. The wholesale desk keeps
 * its receiving scope and gets no new rights here.
 */
function adjustmentRole(actor: AuthenticatedPrincipal): Role {
  if (actor.role === 'ADMIN' || actor.role === 'HTKD' || actor.role === 'STORE') return actor.role;
  throw forbidden();
}

function assertStoreScope(actor: AuthenticatedPrincipal, storeId: string): void {
  adjustmentRole(actor);
  if (!canAccessStore(actor, storeId)) throw forbidden();
}

function scopedStoreIds(actor: AuthenticatedPrincipal, storeId?: string): string[] | undefined {
  const role = adjustmentRole(actor);
  if (storeId !== undefined) {
    if (!canAccessStore(actor, storeId)) throw forbidden();
    return [storeId];
  }
  if (role === 'ADMIN') return undefined;
  if (role === 'STORE') return actor.storeId === null ? [] : [actor.storeId];
  return [...actor.assignedStoreIds];
}

export async function getAdjustmentContext(
  db: Database,
  actor: AuthenticatedPrincipal,
  receiptId: string,
): Promise<ReceiptAdjustmentContext> {
  const context = await getReceiptAdjustmentContext(db, receiptId);
  if (!context) throw notFound('Không tìm thấy phiếu nhận hàng');
  assertStoreScope(actor, context.storeId);
  const adjustments = await listReceiptAdjustments(db, {
    receiptId,
    page: 1,
    pageSize: 100,
  });
  return {
    receiptId: context.receiptId,
    receiptNumber: context.receiptNumber,
    storeId: context.storeId,
    finalizedAt: context.finalizedAt?.toISOString() ?? null,
    summary: summaryDto({
      appliedCount: context.appliedCount,
      openCount: adjustments.data.filter((row) =>
        ['pending_htkd', 'needs_info', 'pending_admin'].includes(row.status),
      ).length,
      original: context.money.original,
      effective: context.money.effective,
    }),
    bags: context.bags.map((bag) => ({
      receiptBagId: bag.receiptBagId,
      bagNumber: bag.bagNumber,
      inventoryBagId: bag.inventoryBagId,
      bagDisplayCode: bag.bagDisplayCode,
      bagStatus: bag.bagStatus === null ? null : bagStatus(bag.bagStatus),
      currentWeightKg: bag.currentWeightKg,
      approvedProductId: bag.approvedProductId,
      effectiveProductId: bag.effectiveProductId,
      effectiveWeightKg: bag.effectiveWeightKg,
      effectivePricePerKgVnd: safe(bag.effectivePricePerKgVnd),
      effectiveCostVnd: safe(bag.effectiveCostVnd),
      shortageGranted: bag.shortageGranted,
      openAdjustmentId: bag.openAdjustmentId,
      openReturnId: bag.openReturnId,
      dependencies: [...bag.dependencies],
    })),
    adjustments: adjustments.data.map(listItemDto),
  };
}

/** Receipt DTO add-on: the finalized values stay; effective = original + applied deltas. */
export async function receiptAdjustmentSummary(
  db: Database,
  receipt: Parameters<typeof receiptAdjustmentMoneySummary>[1],
): Promise<ReceiptAdjustmentSummary> {
  return summaryDto(await receiptAdjustmentMoneySummary(db, receipt));
}

export async function listAdjustments(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: ListReceiptAdjustmentsQuery,
): Promise<Page<ReceiptAdjustmentListItem>> {
  const storeIds = scopedStoreIds(actor, query.storeId);
  const result = await listReceiptAdjustments(db, {
    ...(storeIds === undefined ? {} : { storeIds }),
    ...(query.receiptId === undefined ? {} : { receiptId: query.receiptId }),
    ...(query.status === undefined ? {} : { status: databaseStatus(query.status) }),
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map(listItemDto),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
  };
}

export async function getAdjustment(
  db: Database,
  actor: AuthenticatedPrincipal,
  adjustmentId: string,
): Promise<ReceiptAdjustment> {
  const record = await getReceiptAdjustment(db, adjustmentId);
  if (!record) throw notFound('Không tìm thấy hồ sơ sai lệch');
  assertStoreScope(actor, record.storeId);
  return adjustmentDto(record, adjustmentRole(actor));
}

export async function createAdjustment(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: CreateReceiptAdjustmentRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<ReceiptAdjustment>> {
  if (actor.role !== 'STORE') throw forbidden('Chỉ tài khoản cửa hàng được báo sai lệch');
  const result = await withAdjustmentErrors(() =>
    createReceiptAdjustment(db, {
      receiptId: input.receiptId,
      actorUserId: actor.accountId,
      reason: input.reason,
      evidenceNote: input.evidenceNote,
      discoveredAt: new Date(input.discoveredAt),
      lines: input.lines.map((line) => ({
        receiptBagId: line.receiptBagId,
        actualProductId: line.actualProductId,
        disposition: line.disposition === 'KEEP' ? 'keep' : 'return',
      })),
      requestId: context.requestId,
      idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
      requestHash,
    }),
  );
  const id = result.replayed ? result.resourceId : result.value.adjustmentId;
  if (!id) throw new Error('Receipt adjustment has no resource id.');
  return { data: await getAdjustment(db, actor, id), replayed: result.replayed };
}

const ACTION_ROLES: Record<ReceiptAdjustmentActionRequest['action'], readonly Role[]> = {
  RESUBMIT: ['STORE'],
  CANCEL: ['STORE'],
  VERIFY: ['HTKD', 'ADMIN'],
  REQUEST_INFO: ['HTKD', 'ADMIN'],
  RETURN_TO_VERIFIER: ['ADMIN'],
  REJECT: ['HTKD', 'ADMIN'],
  APPLY: ['ADMIN'],
};

export async function actOnAdjustment(
  db: Database,
  actor: AuthenticatedPrincipal,
  adjustmentId: string,
  input: ReceiptAdjustmentActionRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<ReceiptAdjustment>> {
  if (!ACTION_ROLES[input.action].includes(adjustmentRole(actor))) throw forbidden();
  const current = await getReceiptAdjustment(db, adjustmentId);
  if (!current) throw notFound('Không tìm thấy hồ sơ sai lệch');
  assertStoreScope(actor, current.storeId);
  const base = {
    adjustmentId,
    expectedVersion: input.expectedVersion,
    actorUserId: actor.accountId,
    requestId: context.requestId,
    idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
    requestHash,
  };
  let command: ReceiptAdjustmentTransitionInput;
  switch (input.action) {
    case 'RESUBMIT':
      command = {
        ...base,
        action: 'RESUBMIT',
        reason: input.reason,
        evidenceNote: input.evidenceNote,
        discoveredAt: new Date(input.discoveredAt),
        lines: input.lines.map((line) => ({
          receiptBagId: line.receiptBagId,
          actualProductId: line.actualProductId,
          disposition: line.disposition === 'KEEP' ? 'keep' : 'return',
        })),
      };
      break;
    case 'VERIFY':
      command = {
        ...base,
        action: 'VERIFY',
        cause:
          input.cause === 'WAREHOUSE_MISPICK' ? 'warehouse_mispick' : 'source_misclassification',
        note: input.note,
        lines: input.lines.map((line) => ({
          receiptBagId: line.receiptBagId,
          actualProductId: line.actualProductId,
          weightKg: line.weightKg,
          pricePerKgVnd: BigInt(line.pricePerKgVnd),
          weightChangeNote: line.weightChangeNote,
        })),
        freightDeltaVnd: BigInt(input.freightDeltaVnd),
        handlingDeltaVnd: BigInt(input.handlingDeltaVnd),
        vatDeltaVnd: BigInt(input.vatDeltaVnd),
      };
      break;
    case 'APPLY':
      command = { ...base, action: 'APPLY', note: input.note };
      break;
    default:
      command = { ...base, action: input.action, note: input.note };
  }
  const result = await withAdjustmentErrors(() => transitionReceiptAdjustment(db, command));
  return { data: await getAdjustment(db, actor, adjustmentId), replayed: result.replayed };
}

export async function createReturn(
  db: Database,
  actor: AuthenticatedPrincipal,
  adjustmentId: string,
  lineId: string,
  input: CreateReceiptReturnRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<ReceiptReturn>> {
  if (actor.role !== 'STORE') throw forbidden('Chỉ tài khoản cửa hàng được tạo phiếu trả');
  const current = await getReceiptAdjustment(db, adjustmentId);
  if (!current) throw notFound('Không tìm thấy hồ sơ sai lệch');
  assertStoreScope(actor, current.storeId);
  const result = await withAdjustmentErrors(() =>
    createReceiptReturn(db, {
      adjustmentId,
      adjustmentLineId: lineId,
      actorUserId: actor.accountId,
      reason: input.reason,
      requestId: context.requestId,
      idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
      requestHash,
    }),
  );
  const id = result.replayed ? result.resourceId : result.value.returnId;
  if (!id) throw new Error('Receipt return has no resource id.');
  return { data: await getReturn(db, actor, id), replayed: result.replayed };
}

export async function listReturns(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: ListReceiptReturnsQuery,
): Promise<Page<ReceiptReturn>> {
  const storeIds = scopedStoreIds(actor, query.storeId);
  const result = await listReceiptReturns(db, {
    ...(storeIds === undefined ? {} : { storeIds }),
    ...(query.status === undefined ? {} : { status: databaseReturnStatus(query.status) }),
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map(returnDto),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
  };
}

async function getReturn(
  db: Database,
  actor: AuthenticatedPrincipal,
  returnId: string,
): Promise<ReceiptReturn> {
  const record = await getReceiptReturn(db, returnId);
  if (!record) throw notFound('Không tìm thấy phiếu trả');
  assertStoreScope(actor, record.storeId);
  return returnDto(record);
}

const RETURN_ACTION_ROLES: Record<ReceiptReturnActionRequest['action'], readonly Role[]> = {
  HANDOVER: ['STORE'],
  CANCEL: ['STORE', 'HTKD', 'ADMIN'],
  RECEIVE: ['ADMIN'],
  RESOLVE: ['ADMIN'],
};

export async function actOnReturn(
  db: Database,
  actor: AuthenticatedPrincipal,
  returnId: string,
  input: ReceiptReturnActionRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<ReceiptReturn>> {
  if (!RETURN_ACTION_ROLES[input.action].includes(adjustmentRole(actor))) throw forbidden();
  await getReturn(db, actor, returnId);
  const base = {
    returnId,
    expectedVersion: input.expectedVersion,
    actorUserId: actor.accountId,
    requestId: context.requestId,
    idempotencyKey: `${actor.accountId}:${idempotencyKey}`,
    requestHash,
  };
  const command: ReceiptReturnTransitionInput =
    input.action === 'HANDOVER'
      ? { ...base, action: 'HANDOVER' }
      : input.action === 'RECEIVE'
        ? { ...base, action: 'RECEIVE', outcome: input.outcome, note: input.note }
        : input.action === 'RESOLVE'
          ? { ...base, action: 'RESOLVE', outcome: input.outcome, note: input.note }
          : { ...base, action: 'CANCEL', note: input.note };
  const result = await withAdjustmentErrors(() => transitionReceiptReturn(db, command));
  return { data: await getReturn(db, actor, returnId), replayed: result.replayed };
}

async function withAdjustmentErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ReceiptAdjustmentAuthorizationError) throw forbidden(error.message);
    if (error instanceof ReceiptAdjustmentBlockedError) {
      throw new ApiError('INVALID_STATE_TRANSITION', error.message, 409, {
        blockers: Object.fromEntries(
          Object.entries(error.blockers).map(([bagId, codes]) => [bagId, [...codes]]),
        ),
      });
    }
    if (error instanceof StoreOperationValidationError) {
      throw new ApiError('VALIDATION_ERROR', error.message, 400);
    }
    if (error instanceof StoreOperationConflictError) {
      throw new ApiError('VERSION_CONFLICT', error.message, 409);
    }
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'Khóa idempotency đã được dùng cho nội dung khác',
        409,
      );
    }
    if (error instanceof IdempotencyInProgressError) {
      throw conflict('Yêu cầu cùng khóa idempotency đang được xử lý');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------

const STATUS_DTO: Record<ReceiptAdjustmentDatabaseStatus, ReceiptAdjustment['status']> = {
  pending_htkd: 'PENDING_HTKD',
  needs_info: 'NEEDS_INFO',
  pending_admin: 'PENDING_ADMIN',
  applied: 'APPLIED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
};

function databaseStatus(status: ReceiptAdjustment['status']): ReceiptAdjustmentDatabaseStatus {
  return Object.entries(STATUS_DTO).find(
    ([, value]) => value === status,
  )![0] as ReceiptAdjustmentDatabaseStatus;
}

const RETURN_STATUS_DTO: Record<ReceiptReturnDatabaseStatus, ReceiptReturn['status']> = {
  pending_handover: 'PENDING_HANDOVER',
  in_transit: 'IN_TRANSIT',
  received: 'RECEIVED',
  disputed: 'DISPUTED',
  lost: 'LOST',
  cancelled: 'CANCELLED',
};

function databaseReturnStatus(status: ReceiptReturn['status']): ReceiptReturnDatabaseStatus {
  return Object.entries(RETURN_STATUS_DTO).find(
    ([, value]) => value === status,
  )![0] as ReceiptReturnDatabaseStatus;
}

function bagStatus(status: string): StoreInventoryBag['status'] {
  const map: Record<string, StoreInventoryBag['status']> = {
    in_transit: 'IN_TRANSIT',
    available: 'AVAILABLE',
    opened: 'OPEN',
    depleted: 'EMPTY',
    quarantined: 'QUARANTINED',
    returned: 'RETURNED',
    lost: 'LOST',
  };
  const mapped = map[status];
  if (!mapped) throw new Error(`Unknown bag status ${status}`);
  return mapped;
}

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Money value exceeds the safe integer range.');
  }
  return Number(value);
}

function moneyDto(money: ReceiptAdjustmentMoneySummary['original']): ReceiptMoney {
  return {
    goodsVnd: safe(money.goodsVnd),
    freightVnd: safe(money.freightVnd),
    handlingVnd: safe(money.handlingVnd),
    costVnd: safe(money.costVnd),
    vatVnd: money.vatVnd === null ? null : safe(money.vatVnd),
    totalVnd: money.totalVnd === null ? null : safe(money.totalVnd),
  };
}

function summaryDto(summary: ReceiptAdjustmentMoneySummary): ReceiptAdjustmentSummary {
  return {
    appliedCount: summary.appliedCount,
    openCount: summary.openCount,
    original: moneyDto(summary.original),
    effective: moneyDto(summary.effective),
  };
}

function listItemDto(row: ReceiptAdjustmentSummaryRecord): ReceiptAdjustmentListItem {
  return {
    id: row.id,
    code: row.code,
    receiptId: row.receiptId,
    receiptNumber: row.receiptNumber,
    storeId: row.storeId,
    status: STATUS_DTO[row.status],
    version: row.version,
    reason: row.reason,
    lineCount: row.lineCount,
    shortageQuantity: row.shortageQuantity,
    goodsDeltaVnd: safe(row.goodsDeltaVnd),
    reportedAt: row.reportedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function adjustmentDto(record: ReceiptAdjustmentRecord, role: Role): ReceiptAdjustment {
  const status = STATUS_DTO[record.status];
  return {
    id: record.id,
    code: record.code,
    receiptId: record.receiptId,
    receiptNumber: record.receiptNumber,
    receiptFinalizedAt: record.receiptFinalizedAt?.toISOString() ?? null,
    storeId: record.storeId,
    status,
    version: record.version,
    reason: record.reason,
    evidenceNote: record.evidenceNote,
    discoveredAt: record.discoveredAt.toISOString(),
    cause:
      record.cause === null
        ? null
        : record.cause === 'warehouse_mispick'
          ? 'WAREHOUSE_MISPICK'
          : 'SOURCE_MISCLASSIFICATION',
    appliedSequence: record.appliedSequence,
    delta: {
      goodsVnd: safe(record.goodsDeltaVnd),
      freightVnd: safe(record.freightDeltaVnd),
      handlingVnd: safe(record.handlingDeltaVnd),
      vatVnd: safe(record.vatDeltaVnd),
    },
    money: {
      original: moneyDto(record.money.original),
      before: moneyDto(record.money.before),
      after: record.money.after === null ? null : moneyDto(record.money.after),
    },
    reportedByAccountId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    verifiedByAccountId: record.verifiedByUserId,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    verificationNote: record.verificationNote,
    infoRequestNote: record.infoRequestNote,
    decidedByAccountId: record.decidedByUserId,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionNote: record.decisionNote,
    appliedAt: record.appliedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    allowedActions: allowedReceiptAdjustmentActions(status, role),
    lines: record.lines.map((line) => ({
      id: line.id,
      receiptBagId: line.receiptBagId,
      receiptBagNumber: line.receiptBagNumber,
      inventoryBagId: line.inventoryBagId,
      bagDisplayCode: line.bagDisplayCode,
      bagStatus: bagStatus(line.bagStatus),
      bagCurrentWeightKg: line.bagCurrentWeightKg,
      approvedProductId: line.approvedProductId,
      recordedProductId: line.recordedProductId,
      actualProductId: line.actualProductId,
      disposition: line.disposition === 'keep' ? 'KEEP' : 'RETURN',
      recordedWeightKg: line.recordedWeightKg,
      recordedPricePerKgVnd: safe(line.recordedPricePerKgVnd),
      recordedCostVnd: safe(line.recordedCostVnd),
      verifiedWeightKg: line.verifiedWeightKg,
      verifiedPricePerKgVnd:
        line.verifiedPricePerKgVnd === null ? null : safe(line.verifiedPricePerKgVnd),
      verifiedCostVnd: line.verifiedCostVnd === null ? null : safe(line.verifiedCostVnd),
      weightChangeNote: line.weightChangeNote,
      shortageQuantity: line.shortageQuantity,
      holdState:
        line.holdState === 'none'
          ? 'NONE'
          : line.holdState === 'held'
            ? 'HELD'
            : line.holdState === 'released'
              ? 'RELEASED'
              : 'RETURNING',
      blockers: [...line.blockers],
      entitlement: line.entitlement
        ? {
            waitTicketId: line.entitlement.waitTicketId,
            waitTicketCode: line.entitlement.waitTicketCode,
            waitMode: line.entitlement.waitMode === 'created' ? 'CREATED' : 'MERGED',
            productId: line.entitlement.productId,
            quantity: line.entitlement.quantity,
            waitStatus: line.entitlement.waitStatus.toUpperCase() as
              'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED',
            waitRemainingQuantity: line.entitlement.waitRemainingQuantity,
            waitFulfilledQuantity: line.entitlement.waitFulfilledQuantity,
            hasOpenOffer: line.entitlement.hasOpenOffer,
            heldQuantity: line.entitlement.heldQuantity,
            shippingQuantity: line.entitlement.shippingQuantity,
            receivedQuantity: line.entitlement.receivedQuantity,
            grantedAt: line.entitlement.createdAt.toISOString(),
          }
        : null,
      returns: line.returns.map(returnDto),
    })),
  };
}

function returnDto(row: ReceiptReturnRecord): ReceiptReturn {
  return {
    id: row.id,
    code: row.code,
    adjustmentId: row.adjustmentId,
    adjustmentCode: row.adjustmentCode,
    adjustmentLineId: row.adjustmentLineId,
    receiptId: row.receiptId,
    storeId: row.storeId,
    inventoryBagId: row.inventoryBagId,
    bagDisplayCode: row.bagDisplayCode,
    productId: row.productId,
    quantity: row.quantity,
    weightKg: row.weightKg,
    costVnd: safe(row.costVnd),
    status: RETURN_STATUS_DTO[row.status],
    version: row.version,
    reason: row.reason,
    createdByAccountId: row.createdByUserId,
    handedOverByAccountId: row.handedOverByUserId,
    handedOverAt: row.handedOverAt?.toISOString() ?? null,
    receivedByAccountId: row.receivedByUserId,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    receivedQuantity: row.receivedQuantity,
    receiveNote: row.receiveNote,
    resolvedByAccountId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    cancelledByAccountId: row.cancelledByUserId,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

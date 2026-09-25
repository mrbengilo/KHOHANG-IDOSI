import type {
  AdjustmentAccount,
  AuthenticatedPrincipal,
  CreateReceiptAdjustmentRequest,
  CreateReceiptReturnRequest,
  ListReceiptAdjustmentsQuery,
  ListReceiptReturnsQuery,
  ReceiptAdjustment,
  ReceiptAdjustmentActionRequest,
  ReceiptAdjustmentContext,
  ReceiptAdjustmentHistoryEvent,
  ReceiptAdjustmentHistoryQuery,
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
  listReceiptAdjustmentHistory,
  listReceiptAdjustments,
  listReceiptReturns,
  ReceiptAdjustmentAuthorizationError,
  ReceiptAdjustmentBlockedError,
  receiptAdjustmentMoneySummary,
  StoreOperationConflictError,
  StoreOperationValidationError,
  storeReceiptAdjustments,
  stores,
  transitionReceiptAdjustment,
  transitionReceiptReturn,
  type AdjustmentAccountRef,
  type Database,
  type JsonObject,
  type ReceiptAdjustmentDatabaseStatus,
  type ReceiptAdjustmentHistoryRecord,
  type ReceiptAdjustmentMoneySummary,
  type ReceiptAdjustmentRecord,
  type ReceiptAdjustmentSummaryRecord,
  type ReceiptAdjustmentTransitionInput,
  type ReceiptReturnDatabaseStatus,
  type ReceiptReturnRecord,
  type ReceiptReturnTransitionInput,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { ApiError, conflict, forbidden, notFound } from './errors.js';
import type { IdempotentResource, Page, RequestContext } from './repository.js';
import { canAccessStore, pagination } from './repository.js';
import { asiaHoChiMinhDateRange } from './time.js';

type Role = 'ADMIN' | 'HTKD' | 'STORE';

/**
 * The side of the discrepancy workflow an account takes. The wholesale desk receives for the
 * wholesale stores, so on their documents it is the store side: it reports, answers, cancels
 * and hands returns over, and never verifies, applies or receives returns. Its reach is its
 * live wholesale-store scope (`assignedStoreIds`), and the database re-checks the store's kind
 * and the account inside every transaction. Audit rows keep the account's real role.
 */
function adjustmentRole(actor: AuthenticatedPrincipal): Role {
  if (actor.role === 'ADMIN' || actor.role === 'HTKD' || actor.role === 'STORE') return actor.role;
  if (actor.role === 'WHOLESALE') return 'STORE';
  throw forbidden();
}

async function assertStoreScope(
  db: Database,
  actor: AuthenticatedPrincipal,
  storeId: string,
): Promise<void> {
  adjustmentRole(actor);
  if (!canAccessStore(actor, storeId)) throw forbidden();
  if (actor.role !== 'WHOLESALE') return;
  // The desk's scope is derived from the stores table per request; re-reading the document's
  // store keeps a retail store out of reach even if a principal were ever built otherwise.
  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(
      and(
        eq(stores.id, storeId),
        eq(stores.kind, 'wholesale'),
        eq(stores.isActive, true),
        isNull(stores.deletedAt),
      ),
    )
    .limit(1);
  if (!store) throw forbidden();
}

function scopedStoreIds(actor: AuthenticatedPrincipal, storeId?: string): string[] | undefined {
  const role = adjustmentRole(actor);
  if (storeId !== undefined) {
    if (!canAccessStore(actor, storeId)) throw forbidden();
    return [storeId];
  }
  if (role === 'ADMIN') return undefined;
  // A store account has one store; the wholesale desk's store scope is a list like HTKD's.
  if (actor.role === 'STORE') return actor.storeId === null ? [] : [actor.storeId];
  return [...actor.assignedStoreIds];
}

export async function getAdjustmentContext(
  db: Database,
  actor: AuthenticatedPrincipal,
  receiptId: string,
): Promise<ReceiptAdjustmentContext> {
  const context = await getReceiptAdjustmentContext(db, receiptId);
  if (!context) throw notFound('Không tìm thấy phiếu nhận hàng');
  await assertStoreScope(db, actor, context.storeId);
  // The embedded list is the most recent page only; counts come from SQL over every document
  // of the receipt so a long history is never under-counted.
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
      openCount: context.openCount,
      totalCount: context.adjustmentCount,
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
      openedAt: bag.openedAt?.toISOString() ?? null,
      canReportDiscrepancy: bag.canReportDiscrepancy,
      reportBlockers: [...bag.reportBlockers],
    })),
    adjustments: adjustments.data.map(listItemDto),
    adjustmentCount: context.adjustmentCount,
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
  const period = listPeriod(query);
  const result = await listReceiptAdjustments(db, {
    ...(storeIds === undefined ? {} : { storeIds }),
    ...(query.receiptId === undefined ? {} : { receiptId: query.receiptId }),
    ...(query.status === undefined ? {} : { status: databaseStatus(query.status) }),
    ...(query.q === undefined ? {} : { search: query.q }),
    ...(period === undefined ? {} : { period }),
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map(listItemDto),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
  };
}

/** Inclusive Vietnam business dates as the half-open instant window the database filters on. */
function listPeriod(
  query: ListReceiptAdjustmentsQuery,
): { field: 'reported' | 'decided'; from?: Date; to?: Date } | undefined {
  if (query.from === undefined && query.to === undefined) return undefined;
  return {
    field: query.dateField === 'DECIDED' ? 'decided' : 'reported',
    ...(query.from === undefined
      ? {}
      : { from: asiaHoChiMinhDateRange(query.from, query.from).start }),
    ...(query.to === undefined
      ? {}
      : { to: asiaHoChiMinhDateRange(query.to, query.to).endExclusive }),
  };
}

/**
 * The immutable audit trail of one adjustment (and its returns). The document's store is
 * authorized first, so no role ever reads audit rows outside its own scope.
 */
export async function listAdjustmentHistory(
  db: Database,
  actor: AuthenticatedPrincipal,
  adjustmentId: string,
  query: ReceiptAdjustmentHistoryQuery,
): Promise<Page<ReceiptAdjustmentHistoryEvent>> {
  const [document] = await db
    .select({ storeId: storeReceiptAdjustments.storeId })
    .from(storeReceiptAdjustments)
    .where(eq(storeReceiptAdjustments.id, adjustmentId))
    .limit(1);
  if (!document) throw notFound('Không tìm thấy hồ sơ sai lệch');
  await assertStoreScope(db, actor, document.storeId);
  const result = await listReceiptAdjustmentHistory(db, {
    adjustmentId,
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map(historyEventDto),
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
  await assertStoreScope(db, actor, record.storeId);
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
  if (adjustmentRole(actor) !== 'STORE') {
    throw forbidden('Chỉ tài khoản cửa hàng được báo sai lệch');
  }
  // The receipt's store is re-read and authorized inside the create transaction.
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
  await assertStoreScope(db, actor, current.storeId);
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
  if (adjustmentRole(actor) !== 'STORE') {
    throw forbidden('Chỉ tài khoản cửa hàng được tạo phiếu trả');
  }
  const current = await getReceiptAdjustment(db, adjustmentId);
  if (!current) throw notFound('Không tìm thấy hồ sơ sai lệch');
  await assertStoreScope(db, actor, current.storeId);
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
  await assertStoreScope(db, actor, record.storeId);
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

function accountDto(account: AdjustmentAccountRef): AdjustmentAccount {
  return {
    accountId: account.userId,
    displayName: account.displayName,
    username: account.username,
  };
}

function causeDto(cause: string | null | undefined): ReceiptAdjustment['cause'] {
  if (cause === 'warehouse_mispick' || cause === 'WAREHOUSE_MISPICK') return 'WAREHOUSE_MISPICK';
  if (cause === 'source_misclassification' || cause === 'SOURCE_MISCLASSIFICATION') {
    return 'SOURCE_MISCLASSIFICATION';
  }
  return null;
}

function listItemDto(row: ReceiptAdjustmentSummaryRecord): ReceiptAdjustmentListItem {
  return {
    id: row.id,
    code: row.code,
    receiptId: row.receiptId,
    receiptNumber: row.receiptNumber,
    storeId: row.storeId,
    storeCode: row.storeCode,
    storeName: row.storeName,
    status: STATUS_DTO[row.status],
    version: row.version,
    reason: row.reason,
    cause: causeDto(row.cause),
    lineCount: row.lineCount,
    shortageQuantity: row.shortageQuantity,
    goodsDeltaVnd: safe(row.goodsDeltaVnd),
    reportedBy: accountDto(row.reportedBy),
    reportedAt: row.reportedAt.toISOString(),
    verifiedBy: row.verifiedBy === null ? null : accountDto(row.verifiedBy),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy === null ? null : accountDto(row.decidedBy),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// History: audit rows → a selected, stable DTO. Audit JSON differs by version and action, so
// every field is read defensively; anything the row did not record stays null.
// ---------------------------------------------------------------------------------------------

const HISTORY_TYPES: Record<string, ReceiptAdjustmentHistoryEvent['type']> = {
  RECEIPT_ADJUSTMENT_REPORTED: 'REPORTED',
  RECEIPT_ADJUSTMENT_RESUBMITTED: 'RESUBMITTED',
  RECEIPT_ADJUSTMENT_VERIFIED: 'VERIFIED',
  RECEIPT_ADJUSTMENT_INFO_REQUESTED: 'INFO_REQUESTED',
  RECEIPT_ADJUSTMENT_RETURNED_TO_VERIFIER: 'RETURNED_TO_VERIFIER',
  RECEIPT_ADJUSTMENT_REJECTED: 'REJECTED',
  RECEIPT_ADJUSTMENT_CANCELLED: 'CANCELLED',
  RECEIPT_ADJUSTMENT_APPLIED: 'APPLIED',
  STORE_RECEIPT_RETURN_CREATED: 'RETURN_CREATED',
  STORE_RECEIPT_RETURN_HANDED_OVER: 'RETURN_HANDED_OVER',
  STORE_RECEIPT_RETURN_RECEIVED: 'RETURN_RECEIVED',
  STORE_RECEIPT_RETURN_DISPUTED: 'RETURN_DISPUTED',
  STORE_RECEIPT_RETURN_RECEIVED_AFTER_RECONCILIATION: 'RETURN_RECEIVED_AFTER_RECONCILIATION',
  STORE_RECEIPT_RETURN_LOST: 'RETURN_LOST',
  STORE_RECEIPT_RETURN_CANCELLED: 'RETURN_CANCELLED',
};

const AUDIT_ROLE_DTO: Record<string, ReceiptAdjustmentHistoryEvent['actor']['role']> = {
  admin: 'ADMIN',
  htkd: 'HTKD',
  store: 'STORE',
  wholesale: 'WHOLESALE',
};

function jsonField(object: JsonObject | null, key: string): unknown {
  return object !== null && Object.hasOwn(object, key) ? object[key] : undefined;
}

function jsonText(object: JsonObject | null, key: string): string | null {
  const value = jsonField(object, key);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function jsonObject(object: JsonObject | null, key: string): JsonObject | null {
  const value = jsonField(object, key);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function jsonCount(object: JsonObject | null, key: string): number | null {
  const value = jsonField(object, key);
  return Array.isArray(value) ? value.length : null;
}

/** Money is stored as decimal strings (bigint) in audit JSON; anything else is not recorded. */
function jsonMoney(object: JsonObject | null, key: string): number | null {
  const value = jsonField(object, key);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^-?\d{1,16}$/.test(text)) return null;
  const amount = BigInt(text);
  return amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(amount);
}

function nonNegative(value: number | null): number | null {
  return value === null || value < 0 ? null : value;
}

function historyStatus(
  subject: ReceiptAdjustmentHistoryEvent['subject'],
  value: unknown,
): ReceiptAdjustmentHistoryEvent['statusAfter'] {
  if (typeof value !== 'string') return null;
  if (subject === 'ADJUSTMENT') {
    return STATUS_DTO[value as ReceiptAdjustmentDatabaseStatus] ?? null;
  }
  return RETURN_STATUS_DTO[value as ReceiptReturnDatabaseStatus] ?? null;
}

function historyEventDto(row: ReceiptAdjustmentHistoryRecord): ReceiptAdjustmentHistoryEvent {
  const subject = row.entityType === 'store_receipt_return' ? 'RETURN' : 'ADJUSTMENT';
  const after = row.after;
  const money = jsonObject(after, 'money');
  const moneyBefore = jsonObject(money, 'before');
  const moneyAfter = jsonObject(money, 'after');
  const delta = jsonObject(money, 'delta');
  const appliedSequence = jsonField(after, 'appliedSequence');
  const releasedBagCount = jsonCount(after, 'releasedInventoryBagIds');
  return {
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    type: HISTORY_TYPES[row.action] ?? 'OTHER',
    action: row.action,
    subject,
    returnCode: subject === 'RETURN' ? row.returnCode || null : null,
    actor: {
      accountId: row.actorUserId,
      displayName: row.actorDisplayName,
      username: row.actorUsername,
      role: row.actorRole === null ? null : (AUDIT_ROLE_DTO[row.actorRole] ?? null),
    },
    store: { storeId: row.actorStoreId, code: row.storeCode, name: row.storeName },
    statusBefore: historyStatus(subject, jsonField(row.before, 'status')),
    statusAfter: historyStatus(subject, jsonField(after, 'status')),
    note:
      jsonText(after, 'note') ??
      jsonText(after, 'receiveNote') ??
      jsonText(after, 'resolutionNote') ??
      jsonText(after, 'cancellationReason'),
    changes: {
      reason: jsonText(after, 'reason'),
      evidenceNote: jsonText(after, 'evidenceNote'),
      cause: causeDto(jsonText(after, 'cause')),
      lineCount: jsonCount(after, 'lines'),
      goodsDeltaVnd: jsonMoney(delta, 'goodsVnd'),
      freightDeltaVnd: jsonMoney(delta, 'freightVnd'),
      handlingDeltaVnd: jsonMoney(delta, 'handlingVnd'),
      vatDeltaVnd: jsonMoney(delta, 'vatVnd'),
      totalBeforeVnd: nonNegative(jsonMoney(moneyBefore, 'totalVnd')),
      totalAfterVnd: nonNegative(jsonMoney(moneyAfter, 'totalVnd')),
      costBeforeVnd: nonNegative(jsonMoney(moneyBefore, 'costVnd')),
      costAfterVnd: nonNegative(jsonMoney(moneyAfter, 'costVnd')),
      appliedSequence:
        typeof appliedSequence === 'number' &&
        Number.isSafeInteger(appliedSequence) &&
        appliedSequence > 0
          ? appliedSequence
          : null,
      releasedBagCount,
      returnCount: jsonCount(after, 'returns'),
      entitlementCount: jsonCount(after, 'entitlements'),
    },
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
    reportedBy: accountDto(record.reportedBy),
    reportedAt: record.reportedAt.toISOString(),
    verifiedByAccountId: record.verifiedByUserId,
    verifiedBy: record.verifiedBy === null ? null : accountDto(record.verifiedBy),
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    verificationNote: record.verificationNote,
    infoRequestNote: record.infoRequestNote,
    decidedByAccountId: record.decidedByUserId,
    decidedBy: record.decidedBy === null ? null : accountDto(record.decidedBy),
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

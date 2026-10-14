import type {
  AddSupplierSourceProductsRequest,
  AuthenticatedPrincipal,
  CancelSupplierOrderRequest,
  ConfirmSupplierObservationRequest,
  CreateSupplierSourceRequest,
  ListSupplierOrdersQuery,
  RecordSupplierOrderRequest,
  RecordSupplierSourceReturnRequest,
  SupplierBatch,
  SupplierCommitmentsQuery,
  SupplierCommitmentsResponse,
  SupplierObservation,
  SupplierObservationHistoryQuery,
  SupplierObservationHistoryRow,
  SupplierObservationPreview,
  SupplierObservationRequest,
  SupplierPosition,
  SupplierReconciliationQuery,
  SupplierReconciliationResponse,
  SupplierSource,
} from '@idosi/contracts';
import {
  addSupplierSourceProducts,
  cancelSupplierOrder,
  confirmSupplierStockObservation,
  createSupplierSource,
  listSupplierBatches,
  listSupplierCommitments,
  listSupplierObservationHistory,
  listSupplierReconciliationSummary,
  listSupplierSources,
  previewSupplierStockObservation,
  recordSupplierOrder,
  recordSupplierSourceReturn,
  type Database,
  type SupplierBatchRecord,
  type SupplierObservationRecord,
} from '@idosi/database';
import type { SupplierPosition as DomainSupplierPosition } from '@idosi/domain';

import { forbidden } from './errors.js';
import type { IdempotentResource, Page, RequestContext } from './repository.js';
import {
  isReshareManager,
  pagination,
  RESHARE_MANAGER_FORBIDDEN_MESSAGE,
  reshareStoreScope,
} from './repository.js';

const KIND = {
  order: 'ORDER',
  order_cancel: 'ORDER_CANCEL',
  source_return: 'SOURCE_RETURN',
} as const;
const COVERAGE = {
  open: 'OPEN',
  covered: 'COVERED',
  ambiguous: 'AMBIGUOUS',
  not_applicable: 'NOT_APPLICABLE',
} as const;

/** Admin or HTKD (every store); the database command re-checks the account in its transaction. */
function requireReshareManager(actor: AuthenticatedPrincipal): void {
  if (!isReshareManager(actor)) throw forbidden(RESHARE_MANAGER_FORBIDDEN_MESSAGE);
}

/** Store scope of a reader; undefined means every store (Reshare managers). */
function readerStoreScope(
  actor: AuthenticatedPrincipal,
  storeId: string | undefined,
): { readonly storeIds: readonly string[] | undefined; readonly scoped: boolean } {
  const storeIds = reshareStoreScope(actor, storeId);
  return { storeIds, scoped: !isReshareManager(actor) };
}

/**
 * The issued RE part of U is only sent to callers that asked for it, so bundles that validate
 * the older strict shape keep parsing (it is still counted in U and F for everyone).
 */
export function supplierPositionDto(
  position: DomainSupplierPosition,
  includeIssued = false,
): SupplierPosition {
  const { issuedUnreflectedQuantity, ...rest } = position;
  return includeIssued ? { ...rest, issuedUnreflectedQuantity } : rest;
}

export async function listPostgresSupplierSources(
  db: Database,
  actor: AuthenticatedPrincipal,
): Promise<SupplierSource[]> {
  requireReshareManager(actor);
  const rows = await listSupplierSources(db);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function createPostgresSupplierSource(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: CreateSupplierSourceRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<{ id: string }>> {
  requireReshareManager(actor);
  const result = await createSupplierSource(db, {
    actorUserId: actor.accountId,
    code: input.code,
    name: input.name,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  const id = result.replayed ? String(result.resourceId) : result.value.id;
  return { data: { id }, replayed: result.replayed };
}

export async function addPostgresSupplierSourceProducts(
  db: Database,
  actor: AuthenticatedPrincipal,
  sourceId: string,
  input: AddSupplierSourceProductsRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<{ added: string[] }>> {
  requireReshareManager(actor);
  const result = await addSupplierSourceProducts(db, {
    actorUserId: actor.accountId,
    sourceId,
    productIds: input.productIds,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  if (result.replayed) {
    const body = result.responseBody as { added?: string[] } | null;
    return { data: { added: body?.added ?? [] }, replayed: true };
  }
  return { data: result.value, replayed: false };
}

export async function getPostgresSupplierReconciliation(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: SupplierReconciliationQuery,
): Promise<SupplierReconciliationResponse> {
  requireReshareManager(actor);
  const result = await listSupplierReconciliationSummary(db, {
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    ...(query.search ? { search: query.search } : {}),
    filter: query.filter,
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map((row) => ({
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      productActive: row.productActive,
      sourceId: row.sourceId,
      sourceCode: row.sourceCode,
      status: row.status,
      blockReason: row.blockReason,
      baseline: row.baseline
        ? {
            observedQuantity: row.baseline.observedQuantity,
            observedAt: row.baseline.observedAt.toISOString(),
          }
        : null,
      position: supplierPositionDto(row.position, query.includeIssued === true),
      integrityIssueCount: row.integrityIssues.length,
    })),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
    revision: result.revision,
    generatedAt: result.generatedAt.toISOString(),
  };
}

function observationInput(actor: AuthenticatedPrincipal, input: SupplierObservationRequest) {
  return {
    actorUserId: actor.accountId,
    sourceId: input.sourceId,
    observedAt: new Date(input.observedAt),
    lines: input.lines,
    eventCoverage: input.eventCoverage,
    attestUnlinkedAsNotOrdered: input.attestUnlinkedAsNotOrdered,
    note: input.note ?? null,
    evidenceRef: input.evidenceRef ?? null,
    reshareCoverage: input.reshareCoverage ?? [],
  };
}

export async function previewPostgresSupplierObservation(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: SupplierObservationRequest,
): Promise<SupplierObservationPreview> {
  requireReshareManager(actor);
  const plan = await previewSupplierStockObservation(db, observationInput(actor, input));
  const includeIssued = input.reshareCoverage !== undefined;
  return {
    revision: plan.revision,
    observedAt: plan.observedAt.toISOString(),
    blockingIssues: plan.blockingIssues.filter(
      (issue): issue is SupplierObservationPreview['blockingIssues'][number] =>
        issue === 'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS' ||
        issue === 'LEGACY_ATTESTATION_REQUIRED' ||
        issue === 'VERSION_CONFLICT',
    ),
    lines: plan.lines.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      observedQuantity: line.observedQuantity,
      statusBefore: line.statusBefore,
      statusAfter: line.statusAfter,
      baselineBefore: line.baselineBefore
        ? {
            observedQuantity: line.baselineBefore.observedQuantity,
            observedAt: line.baselineBefore.observedAt.toISOString(),
          }
        : null,
      before: supplierPositionDto(line.before, includeIssued),
      after: supplierPositionDto(line.after, includeIssued),
      events: line.events.map((event) => ({
        id: event.id,
        kind: event.kind,
        quantity: event.quantity,
        coverage: event.coverage,
        occurredAt: event.occurredAt.toISOString(),
        recordedAt: event.recordedAt.toISOString(),
        externalRef: event.externalRef,
        externalLineRef: event.externalLineRef,
        storeId: event.storeId,
        decision: event.decision,
      })),
      undecidedEventCount: line.undecidedEventCount,
      coveredEventCount: line.coveredEventCount,
      unlinkedLegacyQuantity: line.unlinkedLegacyQuantity,
      ...(includeIssued
        ? {
            issuedOrders: line.issuedOrders.map((order) => ({
              lineId: order.lineId,
              orderId: order.orderId,
              code: order.code,
              storeId: order.storeId,
              storeName: order.storeName,
              orderedAt: order.orderedAt.toISOString(),
              quantity: order.quantity,
              unreflectedQuantity: order.unreflectedQuantity,
              declaredReflectedQuantity: order.declaredReflectedQuantity,
              afterObservation: order.afterObservation,
            })),
            reflectedReshareQuantity: line.reflectedReshareQuantity,
          }
        : {}),
      onHandDelta: line.onHandDelta,
    })),
  };
}

function observationDto(row: SupplierObservationRecord): SupplierObservation {
  return {
    id: row.id,
    sourceId: row.sourceId,
    observedAt: row.observedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    note: row.note,
    evidenceRef: row.evidenceRef,
    createdBy: { accountId: row.createdByUserId, displayName: row.createdByDisplayName },
    lines: row.lines.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      observedQuantity: line.observedQuantity,
      coveredEventCount: line.coveredEventCount,
      effectiveSupplierQuantity: line.effectiveSupplierQuantity,
      offerHoldQuantity: line.offerHoldQuantity,
      unorderedReservedQuantity: line.unorderedReservedQuantity,
      orderedReservedQuantity: line.orderedReservedQuantity,
      attestedUnlinkedQuantity: line.attestedUnlinkedQuantity,
      unorderedCommitmentQuantity: line.unorderedCommitmentQuantity,
      freeQuantity: line.freeQuantity,
      shortfallQuantity: line.shortfallQuantity,
      onHandBefore: line.onHandBefore,
      reservedBefore: line.reservedBefore,
      onHandAfter: line.onHandAfter,
      ledgerEntryId: line.ledgerEntryId,
      statusBefore: (
        {
          pending_baseline: 'PENDING_BASELINE',
          active: 'ACTIVE',
          needs_reconciliation: 'NEEDS_RECONCILIATION',
        } as const
      )[line.statusBefore],
    })),
  };
}

export async function confirmPostgresSupplierObservation(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: ConfirmSupplierObservationRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<SupplierObservation>> {
  requireReshareManager(actor);
  const result = await confirmSupplierStockObservation(db, {
    ...observationInput(actor, input),
    expectedRevision: input.expectedRevision,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  return { data: observationDto(result.observation), replayed: result.replayed };
}

export async function listPostgresSupplierObservationHistory(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: SupplierObservationHistoryQuery,
): Promise<Page<SupplierObservationHistoryRow>> {
  requireReshareManager(actor);
  const result = await listSupplierObservationHistory(db, {
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map((row) => ({
      ...row,
      observedAt: row.observedAt.toISOString(),
      recordedAt: row.recordedAt.toISOString(),
    })),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
  };
}

export async function listPostgresSupplierCommitments(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: SupplierCommitmentsQuery,
): Promise<SupplierCommitmentsResponse> {
  const scope = readerStoreScope(actor, query.storeId);
  const result = await listSupplierCommitments(db, {
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    ...(scope.storeIds === undefined ? {} : { storeIds: scope.storeIds }),
    filter: query.filter,
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map((row) => ({
      ...row,
      heldSince: row.heldSince.toISOString(),
      deadlineAt: row.deadlineAt?.toISOString() ?? null,
      // HTKD names are a coordination aid for Reshare managers; stores see only their own rows.
      htkdNames: isReshareManager(actor) ? [...row.htkdNames] : [],
    })),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
    totals: result.totals,
    scoped: scope.scoped,
  };
}

export function supplierBatchDto(row: SupplierBatchRecord): SupplierBatch {
  return {
    id: row.id,
    sourceId: row.sourceId,
    kind: KIND[row.kind],
    externalRef: row.externalRef,
    storeId: row.storeId,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    note: row.note,
    createdBy: { accountId: row.createdByUserId, displayName: row.createdByDisplayName },
    events: row.events.map((event) => ({
      id: event.id,
      productId: event.productId,
      sku: event.sku,
      productName: event.productName,
      kind: KIND[event.kind],
      quantity: event.quantity,
      externalRef: event.externalRef,
      externalLineRef: event.externalLineRef,
      coverage: COVERAGE[event.coverage],
      reversesEventId: event.reversesEventId,
      links: event.links.map((link) => ({ ...link })),
    })),
  };
}

export async function listPostgresSupplierOrders(
  db: Database,
  actor: AuthenticatedPrincipal,
  query: ListSupplierOrdersQuery,
): Promise<Page<SupplierBatch>> {
  const scope = readerStoreScope(actor, query.storeId);
  const result = await listSupplierBatches(db, {
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    ...(query.productId ? { productId: query.productId } : {}),
    ...(scope.storeIds === undefined ? {} : { storeIds: scope.storeIds }),
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    data: result.data.map(supplierBatchDto),
    pagination: pagination(query.page, query.pageSize, result.totalItems),
  };
}

export async function recordPostgresSupplierOrder(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: RecordSupplierOrderRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<SupplierBatch>> {
  if (!isReshareManager(actor)) {
    throw forbidden('Chỉ Admin hoặc HTKD ghi nhận đơn đã đặt Reshare.');
  }
  const result = await recordSupplierOrder(db, {
    actorUserId: actor.accountId,
    sourceId: input.sourceId ?? null,
    externalRef: input.externalRef,
    occurredAt: new Date(input.occurredAt),
    note: input.note ?? null,
    lines: input.lines,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  return { data: supplierBatchDto(result.batch), replayed: result.replayed };
}

export async function cancelPostgresSupplierOrder(
  db: Database,
  actor: AuthenticatedPrincipal,
  eventId: string,
  input: CancelSupplierOrderRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<SupplierBatch>> {
  if (!isReshareManager(actor)) {
    throw forbidden('Chỉ Admin hoặc HTKD ghi nhận hủy đơn Reshare.');
  }
  const result = await cancelSupplierOrder(db, {
    actorUserId: actor.accountId,
    eventId,
    quantity: input.quantity,
    cancelRef: input.cancelRef,
    occurredAt: new Date(input.occurredAt),
    sourceReturned: input.sourceReturned,
    note: input.note ?? null,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  return { data: supplierBatchDto(result.batch), replayed: result.replayed };
}

export async function recordPostgresSupplierSourceReturn(
  db: Database,
  actor: AuthenticatedPrincipal,
  input: RecordSupplierSourceReturnRequest,
  idempotencyKey: string,
  requestHash: string,
  context: RequestContext,
): Promise<IdempotentResource<SupplierBatch>> {
  requireReshareManager(actor);
  const result = await recordSupplierSourceReturn(db, {
    actorUserId: actor.accountId,
    sourceId: input.sourceId,
    productId: input.productId,
    quantity: input.quantity,
    externalRef: input.externalRef,
    occurredAt: new Date(input.occurredAt),
    note: input.note,
    idempotencyKey,
    requestHash,
    requestId: context.requestId,
  });
  return { data: supplierBatchDto(result.batch), replayed: result.replayed };
}

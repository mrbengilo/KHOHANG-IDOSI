import { randomUUID } from 'node:crypto';

import {
  computeSupplierPosition,
  planObservationCoverage,
  type SupplierEventCoverage,
  type SupplierPosition,
  type SupplierProductStatus,
} from '@idosi/domain';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  htkdAssignments,
  products,
  stores,
  supplierExternalEvents,
  supplierObservationEventCoverage,
  supplierObservationReshareCoverage,
  reshareOrderLines,
  supplierSourceProducts,
  supplierSources,
  supplierStockObservationLines,
  supplierStockObservations,
  users,
  type DatabaseUserRole,
  type JsonObject,
} from './schema.js';
import {
  loadSupplierProductFacts,
  lockSupplierProducts,
  lockWarehouseBalances,
  SUPPLIER_STATUS_TO_DOMAIN,
  supplierRevisionToken,
  type SupplierProductFacts,
  type UncoveredSupplierEvent,
} from './supplier-commitments.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';
import { SupplierReconciliationError, type SupplierErrorCode } from './supplier-errors.js';

export { SUPPLIER_ERROR_CODES, SupplierReconciliationError } from './supplier-errors.js';
export type { SupplierErrorCode } from './supplier-errors.js';

export const MAX_OBSERVED_QUANTITY = 1_000_000;
export const MAX_OBSERVATION_LINES = 500;

// ---------------------------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------------------------

export interface SupplierActor {
  readonly id: string;
  readonly role: DatabaseUserRole;
  readonly storeId: string | null;
  /** Name at the time of the command, snapshotted into audit metadata. */
  readonly displayName: string;
  /** Stores the actor may act for; null means every store (Reshare managers). */
  readonly storeIds: readonly string[] | null;
}

/**
 * Roles that manage the whole Reshare module ("Đơn & tồn Reshare") for every store. HTKD is
 * not limited by its store assignments in this module; every other HTKD permission keeps them.
 */
export const RESHARE_MANAGER_ROLES = [
  'admin',
  'htkd',
] as const satisfies readonly DatabaseUserRole[];

/** Re-reads the account inside the command's transaction, so a lock or revoked store is final. */
export async function loadSupplierActor(
  tx: Transaction | Database,
  userId: string,
  allowed: readonly DatabaseUserRole[],
): Promise<SupplierActor> {
  const [actor] = await tx
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      storeId: users.storeId,
      displayName: users.displayName,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!actor || actor.status !== 'active' || !allowed.includes(actor.role)) {
    throw new SupplierReconciliationError('FORBIDDEN', 'Tài khoản không có quyền thao tác này.');
  }
  if (actor.role === 'admin') return { ...actor, storeIds: null };
  if (actor.role === 'htkd') {
    const assigned = await tx
      .select({ storeId: htkdAssignments.storeId })
      .from(htkdAssignments)
      .innerJoin(
        stores,
        and(
          eq(stores.id, htkdAssignments.storeId),
          eq(stores.isActive, true),
          isNull(stores.deletedAt),
        ),
      )
      .where(and(eq(htkdAssignments.userId, actor.id), isNull(htkdAssignments.revokedAt)));
    return { ...actor, storeIds: assigned.map((row) => row.storeId) };
  }
  if (actor.role === 'wholesale') {
    const wholesale = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(eq(stores.kind, 'wholesale'), eq(stores.isActive, true), isNull(stores.deletedAt)),
      );
    return { ...actor, storeIds: wholesale.map((row) => row.id) };
  }
  return { ...actor, storeIds: actor.storeId ? [actor.storeId] : [] };
}

/**
 * Re-reads a Reshare manager (active Admin or HTKD) inside the command's transaction, also on
 * replays: a locked account or a role change is refused at once. Store assignments do not
 * narrow the Reshare module, so the scope is every store for both roles.
 */
export async function loadReshareManager(
  tx: Transaction | Database,
  userId: string,
): Promise<SupplierActor> {
  const actor = await loadSupplierActor(tx, userId, RESHARE_MANAGER_ROLES);
  return { ...actor, storeIds: null };
}

export function actorMayAccessStore(actor: SupplierActor, storeId: string): boolean {
  return actor.storeIds === null || actor.storeIds.includes(storeId);
}

async function audit(
  tx: Transaction,
  input: {
    readonly actor: SupplierActor;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly before?: JsonObject | null;
    readonly after?: JsonObject | null;
    readonly metadata?: JsonObject;
    readonly requestId?: string | null;
    readonly storeId?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    requestId: input.requestId ?? null,
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    actorStoreId: input.storeId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: { actorName: input.actor.displayName, ...input.metadata },
  });
}

// ---------------------------------------------------------------------------------------------
// Sources and SKU mapping (Admin configuration)
// ---------------------------------------------------------------------------------------------

export interface SupplierSourceRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly productCount: number;
  readonly createdAt: Date;
}

export async function listSupplierSources(database: Database): Promise<SupplierSourceRecord[]> {
  const rows = await database
    .select({
      id: supplierSources.id,
      code: supplierSources.code,
      name: supplierSources.name,
      isActive: supplierSources.isActive,
      createdAt: supplierSources.createdAt,
      productCount:
        sql<number>`(select count(*) from ${supplierSourceProducts} where ${supplierSourceProducts.sourceId} = ${supplierSources.id})`.mapWith(
          Number,
        ),
    })
    .from(supplierSources)
    .orderBy(asc(supplierSources.code));
  return rows;
}

export async function createSupplierSource(
  database: Database,
  input: {
    readonly actorUserId: string;
    readonly code: string;
    readonly name: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly requestId?: string | null;
  },
): Promise<IdempotencyResult<{ id: string }>> {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/u.test(code) || name.length < 1 || name.length > 200) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Mã nguồn gồm 2–40 ký tự chữ in hoa, số, "-" hoặc "_"; tên nguồn 1–200 ký tự.',
    );
  }
  return withIdempotency(
    database,
    {
      scope: `supplier-source.create:${input.actorUserId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const actor = await loadReshareManager(tx, input.actorUserId);
      const [existing] = await tx
        .select({ id: supplierSources.id })
        .from(supplierSources)
        .where(eq(supplierSources.code, code))
        .limit(1);
      if (existing) {
        throw new SupplierReconciliationError('VALIDATION', `Mã nguồn ${code} đã tồn tại.`);
      }
      const [created] = await tx
        .insert(supplierSources)
        .values({ code, name, createdByUserId: actor.id })
        .returning({ id: supplierSources.id });
      await audit(tx, {
        actor,
        action: 'SUPPLIER_SOURCE_CREATED',
        entityType: 'supplier_source',
        entityId: created!.id,
        after: { code, name },
        requestId: input.requestId ?? null,
      });
      return {
        value: { id: created!.id },
        responseStatus: 201,
        responseBody: { id: created!.id },
        resourceType: 'supplier_source',
        resourceId: created!.id,
      };
    },
    async (tx) => {
      await loadReshareManager(tx, input.actorUserId);
    },
  );
}

/**
 * Puts SKUs under supplier reconciliation. From now on their legacy inbound, inbound
 * cancellation and manual adjustments are refused and allocation waits for a baseline.
 */
export async function addSupplierSourceProducts(
  database: Database,
  input: {
    readonly actorUserId: string;
    readonly sourceId: string;
    readonly productIds: readonly string[];
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly requestId?: string | null;
  },
): Promise<IdempotencyResult<{ added: string[] }>> {
  const productIds = [...new Set(input.productIds)].sort();
  if (productIds.length === 0 || productIds.length > MAX_OBSERVATION_LINES) {
    throw new SupplierReconciliationError('VALIDATION', 'Chọn từ 1 đến 500 mặt hàng.');
  }
  return withIdempotency(
    database,
    {
      scope: `supplier-source.products:${input.actorUserId}:${input.sourceId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const actor = await loadReshareManager(tx, input.actorUserId);
      const [source] = await tx
        .select()
        .from(supplierSources)
        .where(eq(supplierSources.id, input.sourceId))
        .for('update')
        .limit(1);
      if (!source || !source.isActive) {
        throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy nguồn Reshare.');
      }
      const found = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, productIds), isNull(products.deletedAt)));
      if (found.length !== productIds.length) {
        throw new SupplierReconciliationError('NOT_FOUND', 'Có mặt hàng không tồn tại.');
      }
      await lockWarehouseBalances(tx, productIds);
      const existing = await lockSupplierProducts(tx, productIds);
      const elsewhere = existing.filter((row) => row.sourceId !== input.sourceId);
      if (elsewhere.length > 0) {
        throw new SupplierReconciliationError(
          'VALIDATION',
          'Mặt hàng đã thuộc một nguồn đối chiếu khác; một mặt hàng chỉ có một cơ chế ghi tăng nguồn.',
          { productIds: elsewhere.map((row) => row.productId) },
        );
      }
      const already = new Set(existing.map((row) => row.productId));
      const added = productIds.filter((id) => !already.has(id));
      if (added.length > 0) {
        await tx.insert(supplierSourceProducts).values(
          added.map((productId) => ({
            sourceId: input.sourceId,
            productId,
            createdByUserId: actor.id,
          })),
        );
      }
      await audit(tx, {
        actor,
        action: 'SUPPLIER_SOURCE_PRODUCTS_ADDED',
        entityType: 'supplier_source',
        entityId: input.sourceId,
        after: { added, alreadyMapped: [...already] },
        requestId: input.requestId ?? null,
      });
      return {
        value: { added },
        responseStatus: 200,
        responseBody: { added },
        resourceType: 'supplier_source',
        resourceId: input.sourceId,
      };
    },
    async (tx) => {
      await loadReshareManager(tx, input.actorUserId);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Observation preview / confirm
// ---------------------------------------------------------------------------------------------

export interface SupplierObservationInput {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly observedAt: Date;
  readonly lines: readonly { readonly productId: string; readonly observedQuantity: number }[];
  readonly eventCoverage: readonly { readonly eventId: string; readonly included: boolean }[];
  /** Pre-baseline holds with no recorded B order are declared not ordered at B. */
  readonly attestUnlinkedAsNotOrdered: boolean;
  /**
   * "Số tồn này đã trừ các đơn…": RE line quantities the observed total already deducted. Only
   * what the person states; never inferred from dates or from the difference in totals.
   */
  readonly reshareCoverage?: readonly {
    readonly reshareOrderLineId: string;
    readonly quantity: number;
  }[];
  readonly note?: string | null;
  readonly evidenceRef?: string | null;
}

export interface SupplierObservationEventView {
  readonly id: string;
  readonly kind: UncoveredSupplierEvent['kind'];
  readonly quantity: number;
  readonly coverage: SupplierEventCoverage;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly externalRef: string;
  readonly externalLineRef: string;
  readonly storeId: string | null;
  /** COVERED/OPEN once declared; UNDECIDED needs a declaration; AFTER cannot be covered. */
  readonly decision: 'COVERED' | 'OPEN' | 'UNDECIDED' | 'AFTER_OBSERVATION';
}

export interface SupplierObservationIssuedOrderView {
  readonly lineId: string;
  readonly orderId: string;
  readonly code: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly orderedAt: Date;
  readonly quantity: number;
  readonly unreflectedQuantity: number;
  /** Quantity this observation declares already deducted in the observed total. */
  readonly declaredReflectedQuantity: number;
  /** Created after the observation time: the observed total cannot include it. */
  readonly afterObservation: boolean;
}

export interface SupplierObservationPlanLine {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly observedQuantity: number;
  readonly statusBefore: SupplierProductStatus;
  readonly statusAfter: SupplierProductStatus;
  readonly baselineBefore: { readonly observedQuantity: number; readonly observedAt: Date } | null;
  readonly before: SupplierPosition;
  readonly after: SupplierPosition;
  readonly events: readonly SupplierObservationEventView[];
  readonly undecidedEventCount: number;
  readonly coveredEventCount: number;
  /** Pre-baseline reserved bags without a recorded B order (state UNKNOWN until attested). */
  readonly unlinkedLegacyQuantity: number;
  readonly issuedOrders: readonly SupplierObservationIssuedOrderView[];
  readonly reflectedReshareQuantity: number;
  readonly onHandDelta: number;
}

export interface SupplierObservationPlan {
  readonly revision: string;
  readonly observedAt: Date;
  readonly lines: readonly SupplierObservationPlanLine[];
  readonly blockingIssues: readonly SupplierErrorCode[];
}

function validateObservationInput(input: SupplierObservationInput, now: Date): void {
  if (input.lines.length === 0 || input.lines.length > MAX_OBSERVATION_LINES) {
    throw new SupplierReconciliationError('VALIDATION', 'Nhập từ 1 đến 500 mặt hàng.');
  }
  const ids = input.lines.map((line) => line.productId);
  if (new Set(ids).size !== ids.length) {
    throw new SupplierReconciliationError('VALIDATION', 'Mỗi mặt hàng chỉ được nhập một lần.', {
      duplicateProductIds: ids.filter((id, index) => ids.indexOf(id) !== index),
    });
  }
  for (const line of input.lines) {
    if (
      !Number.isSafeInteger(line.observedQuantity) ||
      line.observedQuantity < 0 ||
      line.observedQuantity > MAX_OBSERVED_QUANTITY
    ) {
      throw new SupplierReconciliationError(
        'VALIDATION',
        'Số tồn Reshare phải là số nguyên bao từ 0 đến 1.000.000.',
      );
    }
  }
  if (Number.isNaN(input.observedAt.getTime())) {
    throw new SupplierReconciliationError('VALIDATION', 'Thời điểm xem tồn không hợp lệ.');
  }
  if (input.observedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Thời điểm xem tồn Reshare không được ở tương lai.',
    );
  }
  const eventIds = input.eventCoverage.map((item) => item.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new SupplierReconciliationError('VALIDATION', 'Mỗi biến động chỉ được khai một lần.');
  }
  const coverageLineIds = (input.reshareCoverage ?? []).map((item) => item.reshareOrderLineId);
  if (new Set(coverageLineIds).size !== coverageLineIds.length) {
    throw new SupplierReconciliationError('VALIDATION', 'Mỗi dòng đơn RE chỉ được khai một lần.');
  }
  for (const item of input.reshareCoverage ?? []) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new SupplierReconciliationError(
        'VALIDATION',
        'Số bao đơn RE đã trừ trong số tồn phải là số nguyên dương.',
      );
    }
  }
  if ((input.note?.length ?? 0) > 500 || (input.evidenceRef?.length ?? 0) > 200) {
    throw new SupplierReconciliationError('VALIDATION', 'Ghi chú tối đa 500, chứng từ 200 ký tự.');
  }
}

async function planObservation(
  tx: Transaction,
  input: SupplierObservationInput,
  now: Date,
): Promise<{ plan: SupplierObservationPlan; facts: Map<string, SupplierProductFacts> }> {
  validateObservationInput(input, now);
  const [source] = await tx
    .select()
    .from(supplierSources)
    .where(eq(supplierSources.id, input.sourceId))
    .limit(1);
  if (!source || !source.isActive) {
    throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy nguồn Reshare.');
  }
  const productIds = input.lines.map((line) => line.productId);
  const facts = await loadSupplierProductFacts(tx, productIds);
  const notMapped = productIds.filter((id) => facts.get(id)?.mapping.sourceId !== input.sourceId);
  if (notMapped.length > 0) {
    throw new SupplierReconciliationError(
      'SOURCE_NOT_RECONCILED',
      'Có mặt hàng chưa được cấu hình thuộc nguồn Reshare này.',
      { productIds: notMapped },
    );
  }
  const productRows = await tx
    .select({ id: products.id, sku: products.sku, name: products.name })
    .from(products)
    .where(inArray(products.id, productIds));
  const productById = new Map(productRows.map((row) => [row.id, row]));
  const declarations = new Map(input.eventCoverage.map((item) => [item.eventId, item.included]));
  const eventProduct = new Map<string, string>();
  for (const fact of facts.values()) {
    for (const event of fact.events) eventProduct.set(event.id, fact.mapping.productId);
  }
  const reshareDeclarations = new Map(
    (input.reshareCoverage ?? []).map((item) => [item.reshareOrderLineId, item.quantity]),
  );
  const issuedLineProduct = new Map<string, string>();
  for (const fact of facts.values()) {
    for (const order of fact.issuedOrders)
      issuedLineProduct.set(order.lineId, fact.mapping.productId);
  }
  const unknownReshare = [...reshareDeclarations.keys()].filter((id) => !issuedLineProduct.has(id));
  if (unknownReshare.length > 0) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Có dòng đơn RE không thuộc các mặt hàng đang cập nhật hoặc đã được trừ đủ trước đó.',
      { reshareOrderLineIds: unknownReshare },
    );
  }
  const unknownDeclarations = [...declarations.keys()].filter((id) => !eventProduct.has(id));
  if (unknownDeclarations.length > 0) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Có biến động không thuộc các mặt hàng đang đối chiếu hoặc đã được đối chiếu trước đó.',
      { eventIds: unknownDeclarations },
    );
  }

  const blockingIssues = new Set<SupplierErrorCode>();
  const lines = input.lines.map((line): SupplierObservationPlanLine => {
    const fact = facts.get(line.productId)!;
    const product = productById.get(line.productId)!;
    if (fact.baseline && input.observedAt.getTime() <= fact.baseline.observedAt.getTime()) {
      throw new SupplierReconciliationError(
        'OBSERVATION_OUT_OF_ORDER',
        `Đã có số Reshare quan sát lúc ${formatBusinessTime(fact.baseline.observedAt)} cho ${product.sku}; lần đối chiếu mới phải sau thời điểm đó.`,
        { productId: line.productId, baselineObservedAt: fact.baseline.observedAt.toISOString() },
      );
    }
    const productDeclarations = new Map(
      [...declarations].filter(([eventId]) => eventProduct.get(eventId) === line.productId),
    );
    const coverage = planObservationCoverage(fact.events, input.observedAt, productDeclarations);
    if (coverage.invalid.length > 0) {
      throw new SupplierReconciliationError(
        'VALIDATION',
        'Không thể khai số Reshare đã gồm một biến động xảy ra sau thời điểm xem tồn.',
        { eventIds: [...coverage.invalid] },
      );
    }
    const covered = new Set(coverage.covered);
    const declaredOpen = new Set(coverage.open);
    const undecided = new Set(coverage.undecided);
    const events = fact.events.map((event): SupplierObservationEventView => ({
      ...event,
      decision: covered.has(event.id)
        ? 'COVERED'
        : declaredOpen.has(event.id)
          ? 'OPEN'
          : undecided.has(event.id)
            ? 'UNDECIDED'
            : 'AFTER_OBSERVATION',
    }));
    const remaining = fact.events
      .filter((event) => !covered.has(event.id))
      .map((event) => ({
        kind: event.kind,
        quantity: event.quantity,
        coverage: (declaredOpen.has(event.id) ? 'OPEN' : event.coverage) as SupplierEventCoverage,
      }));
    const unlinkedLegacyQuantity =
      fact.mapping.status === 'pending_baseline'
        ? fact.reservations.reduce((total, row) => total + row.quantity - row.orderedQuantity, 0)
        : 0;
    const issuedOrders = fact.issuedOrders.map((order): SupplierObservationIssuedOrderView => {
      const declared = reshareDeclarations.get(order.lineId) ?? 0;
      const afterObservation = order.orderedAt.getTime() > input.observedAt.getTime();
      if (declared > 0 && afterObservation) {
        throw new SupplierReconciliationError(
          'VALIDATION',
          `Đơn ${order.code} lập sau thời điểm xem tồn nên số tồn đó chưa thể trừ đơn này.`,
          { reshareOrderLineId: order.lineId },
        );
      }
      if (declared > order.unreflectedQuantity) {
        throw new SupplierReconciliationError(
          'QUANTITY_EXCEEDED',
          `Đơn ${order.code} chỉ còn ${order.unreflectedQuantity} bao chưa được trừ trong số tồn.`,
          { reshareOrderLineId: order.lineId, available: order.unreflectedQuantity },
        );
      }
      return {
        lineId: order.lineId,
        orderId: order.orderId,
        code: order.code,
        storeId: order.storeId,
        storeName: order.storeName,
        orderedAt: order.orderedAt,
        quantity: order.quantity,
        unreflectedQuantity: order.unreflectedQuantity,
        declaredReflectedQuantity: declared,
        afterObservation,
      };
    });
    const reflectedReshareQuantity = issuedOrders.reduce(
      (total, order) => total + order.declaredReflectedQuantity,
      0,
    );
    if (undecided.size > 0) blockingIssues.add('EXTERNAL_EVENT_COVERAGE_AMBIGUOUS');
    if (unlinkedLegacyQuantity > 0 && !input.attestUnlinkedAsNotOrdered) {
      blockingIssues.add('LEGACY_ATTESTATION_REQUIRED');
    }
    if (fact.integrityIssues.length > 0) blockingIssues.add('VERSION_CONFLICT');
    const statusAfter: SupplierProductStatus =
      undecided.size > 0 ? 'NEEDS_RECONCILIATION' : 'ACTIVE';
    const after = computeSupplierPosition({
      status: statusAfter,
      baselineQuantity: line.observedQuantity,
      events: remaining,
      offerHoldQuantity: fact.offerHoldQuantity,
      reservations: fact.reservations.map((row) => ({
        quantity: row.quantity,
        orderedQuantity: row.orderedQuantity,
      })),
      issuedOrders: issuedOrders.map((order) => ({
        quantity: order.quantity,
        reflectedQuantity:
          order.quantity - order.unreflectedQuantity + order.declaredReflectedQuantity,
      })),
      ledgerOnHand: fact.balance.onHand,
      ledgerReserved: fact.balance.reserved,
    });
    return {
      productId: line.productId,
      sku: product.sku,
      productName: product.name,
      observedQuantity: line.observedQuantity,
      statusBefore: SUPPLIER_STATUS_TO_DOMAIN[fact.mapping.status],
      statusAfter,
      baselineBefore: fact.baseline
        ? { observedQuantity: fact.baseline.observedQuantity, observedAt: fact.baseline.observedAt }
        : null,
      before: fact.position,
      after,
      events,
      undecidedEventCount: undecided.size,
      coveredEventCount: covered.size,
      unlinkedLegacyQuantity,
      issuedOrders,
      reflectedReshareQuantity,
      onHandDelta: (after.targetOnHand ?? fact.balance.onHand) - fact.balance.onHand,
    };
  });
  return {
    plan: {
      revision: supplierRevisionToken(facts.values()),
      observedAt: input.observedAt,
      lines,
      blockingIssues: [...blockingIssues],
    },
    facts,
  };
}

/** Read-only: what confirming this observation would change. Admin only. */
export async function previewSupplierStockObservation(
  database: Database,
  input: SupplierObservationInput,
  now = new Date(),
): Promise<SupplierObservationPlan> {
  return withSerializableTransaction(
    database,
    async (tx) => {
      await loadReshareManager(tx, input.actorUserId);
      return (await planObservation(tx, input, now)).plan;
    },
    { accessMode: 'read only' },
  );
}

export interface ConfirmSupplierObservationInput extends SupplierObservationInput {
  /** The preview's revision; a different current revision refuses the command. */
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
}

export interface SupplierObservationRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly observedAt: Date;
  readonly recordedAt: Date;
  readonly note: string | null;
  readonly evidenceRef: string | null;
  readonly createdByUserId: string;
  readonly createdByDisplayName: string;
  readonly lines: readonly SupplierObservationLineRecord[];
}

export type SupplierObservationLineRecord = typeof supplierStockObservationLines.$inferSelect & {
  readonly sku: string;
  readonly productName: string;
};

/**
 * Confirms C's observation atomically: actor → replay → locks → recompute → revision check →
 * coverage → ledger projection (onHand := R + F) → immutable lines → baseline switch → audit.
 */
export async function confirmSupplierStockObservation(
  database: Database,
  input: ConfirmSupplierObservationInput,
  now = new Date(),
): Promise<{ readonly observation: SupplierObservationRecord; readonly replayed: boolean }> {
  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(
      tx,
      'supplier-observation-key',
      `${input.actorUserId}:${input.idempotencyKey}`,
      async () => {
        const actor = await loadReshareManager(tx, input.actorUserId);
        const [previous] = await tx
          .select({
            id: supplierStockObservations.id,
            requestHash: supplierStockObservations.requestHash,
          })
          .from(supplierStockObservations)
          .where(
            and(
              eq(supplierStockObservations.createdByUserId, actor.id),
              eq(supplierStockObservations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (previous) {
          if (previous.requestHash !== input.requestHash) {
            throw new SupplierReconciliationError(
              'IDEMPOTENCY_CONFLICT',
              'Khóa thao tác đã dùng cho một lần đối chiếu khác.',
            );
          }
          return { observation: await loadObservation(tx, previous.id), replayed: true };
        }

        const productIds = input.lines.map((line) => line.productId);
        await lockWarehouseBalances(tx, productIds);
        await lockSupplierProducts(tx, productIds);
        const { plan, facts } = await planObservation(tx, input, now);
        if (plan.revision !== input.expectedRevision) {
          throw new SupplierReconciliationError(
            'VERSION_CONFLICT',
            'Số liệu đã thay đổi sau khi xem trước (giữ hàng, phân bổ, đặt Reshare hoặc biến động kho). Xem trước lại rồi xác nhận.',
            { revision: plan.revision },
          );
        }
        if (plan.blockingIssues.includes('EXTERNAL_EVENT_COVERAGE_AMBIGUOUS')) {
          throw new SupplierReconciliationError(
            'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS',
            'Cần xác nhận từng biến động Reshare xảy ra trước thời điểm xem tồn: đã gồm trong số vừa nhập hay chưa.',
          );
        }
        if (plan.blockingIssues.includes('LEGACY_ATTESTATION_REQUIRED')) {
          throw new SupplierReconciliationError(
            'LEGACY_ATTESTATION_REQUIRED',
            'Có hàng đang giữ trước khi bật đối chiếu chưa ghi nhận đơn Reshare. Ghi nhận các đơn đã đặt, rồi xác nhận phần còn lại chưa đặt.',
          );
        }
        if (plan.blockingIssues.includes('VERSION_CONFLICT')) {
          throw new SupplierReconciliationError(
            'VERSION_CONFLICT',
            'Liên kết đơn Reshare vượt số lượng đang giữ; cần kiểm tra dữ liệu trước khi đối chiếu.',
          );
        }

        const observationId = randomUUID();
        await tx.insert(supplierStockObservations).values({
          id: observationId,
          sourceId: input.sourceId,
          observedAt: input.observedAt,
          recordedAt: now,
          note: input.note?.trim() || null,
          evidenceRef: input.evidenceRef?.trim() || null,
          createdByUserId: actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          requestId: input.requestId ?? null,
        });
        if (input.eventCoverage.length > 0) {
          await tx.insert(supplierObservationEventCoverage).values(
            input.eventCoverage.map((item) => ({
              observationId,
              eventId: item.eventId,
              included: item.included,
              createdAt: now,
            })),
          );
        }
        const reshareCoverage = plan.lines.flatMap((line) =>
          line.issuedOrders
            .filter((order) => order.declaredReflectedQuantity > 0)
            .map((order) => ({ line, order })),
        );
        if (reshareCoverage.length > 0) {
          await tx.insert(supplierObservationReshareCoverage).values(
            reshareCoverage.map(({ line, order }) => ({
              observationId,
              reshareOrderLineId: order.lineId,
              productId: line.productId,
              quantity: order.declaredReflectedQuantity,
              createdAt: now,
            })),
          );
          for (const { order } of reshareCoverage) {
            const [reflected] = await tx
              .update(reshareOrderLines)
              .set({
                supplierReflectedQuantity: sql`${reshareOrderLines.supplierReflectedQuantity} + ${order.declaredReflectedQuantity}`,
                updatedAt: now,
              })
              .where(
                and(
                  eq(reshareOrderLines.id, order.lineId),
                  sql`${reshareOrderLines.supplierReflectedQuantity} + ${order.declaredReflectedQuantity} <= ${reshareOrderLines.quantity}`,
                ),
              )
              .returning({ id: reshareOrderLines.id });
            if (!reflected) {
              throw new SupplierReconciliationError(
                'VERSION_CONFLICT',
                'Đơn RE đã được trừ trong lần cập nhật khác. Xem trước lại rồi xác nhận.',
              );
            }
          }
        }
        const coveredIds = plan.lines.flatMap((line) =>
          line.events.filter((event) => event.decision === 'COVERED').map((event) => event.id),
        );
        const reopenedIds = plan.lines.flatMap((line) =>
          line.events
            .filter((event) => event.decision === 'OPEN' && event.coverage === 'AMBIGUOUS')
            .map((event) => event.id),
        );
        if (coveredIds.length > 0) {
          await tx
            .update(supplierExternalEvents)
            .set({ coverage: 'covered', coveredByObservationId: observationId })
            .where(inArray(supplierExternalEvents.id, coveredIds));
        }
        if (reopenedIds.length > 0) {
          await tx
            .update(supplierExternalEvents)
            .set({ coverage: 'open' })
            .where(inArray(supplierExternalEvents.id, reopenedIds));
        }

        for (const line of [...plan.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
          const fact = facts.get(line.productId)!;
          let ledgerEntryId: string | null = null;
          if (line.onHandDelta !== 0) {
            const movement = await applyWarehouseMovement(tx, {
              productId: line.productId,
              eventType: 'adjustment',
              onHandDelta: line.onHandDelta,
              reservedDelta: 0,
              sourceType: 'supplier_stock_observation',
              sourceId: observationId,
              reason: `Đối chiếu tồn Reshare: B=${line.observedQuantity}, khả dụng ${line.after.freeQuantity}`,
              metadata: {
                projection: 'supplier_free_stock',
                observedQuantity: line.observedQuantity,
                effectiveSupplierQuantity: line.after.effectiveSupplierQuantity,
                unorderedCommitmentQuantity: line.after.unorderedCommitmentQuantity,
                freeQuantity: line.after.freeQuantity,
                shortfallQuantity: line.after.shortfallQuantity,
              },
              actorUserId: actor.id,
              occurredAt: now,
            });
            ledgerEntryId = movement.ledgerEntryId;
          }
          const lineId = randomUUID();
          await tx.insert(supplierStockObservationLines).values({
            id: lineId,
            observationId,
            productId: line.productId,
            observedQuantity: line.observedQuantity,
            previousBaselineLineId: fact.baseline?.lineId ?? null,
            coveredEventCount: line.coveredEventCount,
            pendingDelta: line.after.pendingDelta,
            effectiveSupplierQuantity: line.after.effectiveSupplierQuantity!,
            offerHoldQuantity: line.after.offerHoldQuantity,
            unorderedReservedQuantity: line.after.unorderedReservedQuantity,
            orderedReservedQuantity: line.after.orderedReservedQuantity,
            attestedUnlinkedQuantity: line.unlinkedLegacyQuantity,
            issuedUnreflectedQuantity: line.after.issuedUnreflectedQuantity,
            reflectedReshareQuantity: line.reflectedReshareQuantity,
            unorderedCommitmentQuantity: line.after.unorderedCommitmentQuantity,
            freeQuantity: line.after.freeQuantity,
            shortfallQuantity: line.after.shortfallQuantity,
            onHandBefore: fact.balance.onHand,
            reservedBefore: fact.balance.reserved,
            onHandAfter: line.after.targetOnHand!,
            balanceVersionBefore: fact.balance.version,
            ledgerEntryId,
            statusBefore: fact.mapping.status,
            statusAfter: 'active',
            createdAt: now,
          });
          await tx
            .update(supplierSourceProducts)
            .set({
              status: 'active',
              baselineObservationLineId: lineId,
              blockReason: null,
              blockedAt: null,
              revision: sql`${supplierSourceProducts.revision} + 1`,
              updatedAt: now,
            })
            .where(eq(supplierSourceProducts.productId, line.productId));
        }

        // Self-check: the projection must hold exactly after the command, or nothing commits.
        const afterFacts = await loadSupplierProductFacts(tx, productIds);
        for (const fact of afterFacts.values()) {
          if (fact.position.projectionMismatch || fact.position.state === 'NO_BASELINE') {
            throw new Error(`Supplier projection of ${fact.mapping.productId} did not converge.`);
          }
        }
        await audit(tx, {
          actor,
          action: 'SUPPLIER_STOCK_OBSERVATION_CONFIRMED',
          entityType: 'supplier_stock_observation',
          entityId: observationId,
          after: {
            observedAt: input.observedAt.toISOString(),
            lines: plan.lines.map((line) => ({
              productId: line.productId,
              observedQuantity: line.observedQuantity,
              freeBefore: line.before.ledgerAvailable,
              freeAfter: line.after.freeQuantity,
              shortfall: line.after.shortfallQuantity,
              unorderedCommitment: line.after.unorderedCommitmentQuantity,
              onHandDelta: line.onHandDelta,
              coveredEvents: line.coveredEventCount,
              reflectedReshare: line.issuedOrders
                .filter((order) => order.declaredReflectedQuantity > 0)
                .map((order) => ({
                  reshareOrderLineId: order.lineId,
                  code: order.code,
                  quantity: order.declaredReflectedQuantity,
                })),
              attestedUnlinked: line.unlinkedLegacyQuantity,
            })),
          },
          requestId: input.requestId ?? null,
        });
        return { observation: await loadObservation(tx, observationId), replayed: false };
      },
    ),
  );
}

async function loadObservation(
  tx: Transaction,
  observationId: string,
): Promise<SupplierObservationRecord> {
  const [row] = await tx
    .select({ observation: supplierStockObservations, displayName: users.displayName })
    .from(supplierStockObservations)
    .innerJoin(users, eq(users.id, supplierStockObservations.createdByUserId))
    .where(eq(supplierStockObservations.id, observationId))
    .limit(1);
  if (!row) throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy lần đối chiếu.');
  const lines = await tx
    .select({ line: supplierStockObservationLines, sku: products.sku, name: products.name })
    .from(supplierStockObservationLines)
    .innerJoin(products, eq(products.id, supplierStockObservationLines.productId))
    .where(eq(supplierStockObservationLines.observationId, observationId))
    .orderBy(asc(products.displayOrder), asc(products.sku));
  return {
    id: row.observation.id,
    sourceId: row.observation.sourceId,
    observedAt: row.observation.observedAt,
    recordedAt: row.observation.recordedAt,
    note: row.observation.note,
    evidenceRef: row.observation.evidenceRef,
    createdByUserId: row.observation.createdByUserId,
    createdByDisplayName: row.displayName,
    lines: lines.map(({ line, sku, name }) => ({ ...line, sku, productName: name })),
  };
}

// ---------------------------------------------------------------------------------------------
// Summary and history (Admin)
// ---------------------------------------------------------------------------------------------

export const SUPPLIER_SUMMARY_FILTERS = [
  'ALL',
  'COMMITTED',
  'UNORDERED',
  'SHORTFALL',
  'NEEDS_RECONCILIATION',
] as const;
export type SupplierSummaryFilter = (typeof SUPPLIER_SUMMARY_FILTERS)[number];

export interface SupplierSummaryRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly productActive: boolean;
  readonly sourceId: string;
  readonly sourceCode: string;
  readonly status: SupplierProductStatus;
  readonly blockReason: string | null;
  readonly baseline: { readonly observedQuantity: number; readonly observedAt: Date } | null;
  readonly position: SupplierPosition;
  readonly integrityIssues: readonly string[];
}

export interface SupplierSummaryPage {
  readonly data: SupplierSummaryRow[];
  readonly totalItems: number;
  readonly revision: string;
  readonly generatedAt: Date;
}

/**
 * Every mapped SKU matching the filters, computed in one repeatable-read snapshot. Mapped SKUs
 * are bounded by the catalogue, so the state filter runs after the position is known.
 */
export async function listSupplierReconciliationSummary(
  database: Database,
  input: {
    readonly sourceId?: string;
    readonly search?: string;
    readonly filter: SupplierSummaryFilter;
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<SupplierSummaryPage> {
  return database.transaction(
    async (tx) => {
      const conditions: SQL[] = [isNull(products.deletedAt)];
      if (input.sourceId) conditions.push(eq(supplierSourceProducts.sourceId, input.sourceId));
      if (input.search) {
        conditions.push(
          or(
            ilike(products.name, `%${escapeLike(input.search)}%`),
            ilike(products.sku, `%${escapeLike(input.search)}%`),
          )!,
        );
      }
      const mapped = await tx
        .select({
          productId: supplierSourceProducts.productId,
          sku: products.sku,
          productName: products.name,
          productActive: products.isActive,
          sourceCode: supplierSources.code,
        })
        .from(supplierSourceProducts)
        .innerJoin(products, eq(products.id, supplierSourceProducts.productId))
        .innerJoin(supplierSources, eq(supplierSources.id, supplierSourceProducts.sourceId))
        .where(and(...conditions))
        .orderBy(asc(products.displayOrder), asc(products.sku));
      const facts = await loadSupplierProductFacts(
        tx,
        mapped.map((row) => row.productId),
      );
      const rows = mapped.flatMap((row): SupplierSummaryRow[] => {
        const fact = facts.get(row.productId);
        if (!fact) return [];
        return [
          {
            ...row,
            sourceId: fact.mapping.sourceId,
            status: SUPPLIER_STATUS_TO_DOMAIN[fact.mapping.status],
            blockReason: fact.mapping.blockReason,
            baseline: fact.baseline,
            position: fact.position,
            integrityIssues: fact.integrityIssues,
          },
        ];
      });
      const filtered = rows.filter((row) => {
        switch (input.filter) {
          case 'COMMITTED':
            return (
              row.position.unorderedCommitmentQuantity + row.position.orderedReservedQuantity > 0
            );
          case 'UNORDERED':
            return row.position.unorderedReservedQuantity > 0;
          case 'SHORTFALL':
            return row.position.shortfallQuantity > 0;
          case 'NEEDS_RECONCILIATION':
            return (
              row.position.state === 'NEEDS_RECONCILIATION' || row.position.state === 'NO_BASELINE'
            );
          default:
            return true;
        }
      });
      const start = (input.page - 1) * input.pageSize;
      return {
        data: filtered.slice(start, start + input.pageSize),
        totalItems: filtered.length,
        revision: supplierRevisionToken(facts.values()),
        generatedAt: new Date(),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export interface SupplierObservationHistoryRow {
  readonly lineId: string;
  readonly observationId: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly observedAt: Date;
  readonly recordedAt: Date;
  readonly observedQuantity: number;
  readonly coveredEventCount: number;
  readonly effectiveSupplierQuantity: number;
  readonly unorderedCommitmentQuantity: number;
  readonly freeQuantity: number;
  readonly shortfallQuantity: number;
  readonly onHandBefore: number;
  readonly reservedBefore: number;
  readonly onHandAfter: number;
  readonly attestedUnlinkedQuantity: number;
  readonly statusBefore: SupplierProductStatus;
  readonly note: string | null;
  readonly evidenceRef: string | null;
  readonly createdByDisplayName: string;
}

export async function listSupplierObservationHistory(
  database: Database,
  input: {
    readonly productId?: string;
    readonly sourceId?: string;
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<{ readonly data: SupplierObservationHistoryRow[]; readonly totalItems: number }> {
  const conditions: SQL[] = [];
  if (input.productId)
    conditions.push(eq(supplierStockObservationLines.productId, input.productId));
  if (input.sourceId) conditions.push(eq(supplierStockObservations.sourceId, input.sourceId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totals] = await Promise.all([
    database
      .select({
        line: supplierStockObservationLines,
        observation: supplierStockObservations,
        sku: products.sku,
        productName: products.name,
        displayName: users.displayName,
      })
      .from(supplierStockObservationLines)
      .innerJoin(
        supplierStockObservations,
        eq(supplierStockObservations.id, supplierStockObservationLines.observationId),
      )
      .innerJoin(products, eq(products.id, supplierStockObservationLines.productId))
      .innerJoin(users, eq(users.id, supplierStockObservations.createdByUserId))
      .where(where)
      .orderBy(
        desc(supplierStockObservations.observedAt),
        desc(supplierStockObservationLines.createdAt),
        desc(supplierStockObservationLines.id),
      )
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    database
      .select({ value: count() })
      .from(supplierStockObservationLines)
      .innerJoin(
        supplierStockObservations,
        eq(supplierStockObservations.id, supplierStockObservationLines.observationId),
      )
      .where(where),
  ]);
  return {
    data: rows.map(({ line, observation, sku, productName, displayName }) => ({
      lineId: line.id,
      observationId: observation.id,
      productId: line.productId,
      sku,
      productName,
      observedAt: observation.observedAt,
      recordedAt: observation.recordedAt,
      observedQuantity: line.observedQuantity,
      coveredEventCount: line.coveredEventCount,
      effectiveSupplierQuantity: line.effectiveSupplierQuantity,
      unorderedCommitmentQuantity: line.unorderedCommitmentQuantity,
      freeQuantity: line.freeQuantity,
      shortfallQuantity: line.shortfallQuantity,
      onHandBefore: line.onHandBefore,
      reservedBefore: line.reservedBefore,
      onHandAfter: line.onHandAfter,
      attestedUnlinkedQuantity: line.attestedUnlinkedQuantity,
      statusBefore: SUPPLIER_STATUS_TO_DOMAIN[line.statusBefore],
      note: observation.note,
      evidenceRef: observation.evidenceRef,
      createdByDisplayName: displayName,
    })),
    totalItems: totals[0]?.value ?? 0,
  };
}

/** Business time (Asia/Ho_Chi_Minh) for messages people read. */
function formatBusinessTime(value: Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hourCycle: 'h23',
  }).format(value);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

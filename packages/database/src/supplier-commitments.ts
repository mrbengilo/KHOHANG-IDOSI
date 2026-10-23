import { createHash } from 'node:crypto';

import {
  computeSupplierPosition,
  type SupplierEventCoverage,
  type SupplierEventKind,
  type SupplierPosition,
  type SupplierProductStatus,
} from '@idosi/domain';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  dailyPriorityOffers,
  reservations,
  reshareOrderLines,
  reshareOrderSources,
  reshareOrders,
  supplierExternalEvents,
  supplierOrderSourceLinks,
  supplierSourceProducts,
  supplierStockObservationLines,
  supplierStockObservations,
  warehouseBalances,
  type JsonObject,
} from './schema.js';
import { SupplierReconciliationError } from './supplier-errors.js';
import type { Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

/**
 * Facts and projection of Reshare-reconciled SKUs (docs/supplier-stock-reconciliation.md).
 *
 * Lock order shared by every supplier command (and compatible with worker, dispatch, receipt
 * and adjustment paths, which take reservations → warehouse-balance):
 *   1. idempotency key (advisory)
 *   2. reservations FOR UPDATE, by id (order / cancellation commands only)
 *   3. warehouse-balance advisory locks, by product id
 *   4. supplier_source_products FOR UPDATE, by product id
 */

export type SupplierProductRow = typeof supplierSourceProducts.$inferSelect;

export const SUPPLIER_STATUS_TO_DOMAIN: Record<
  SupplierProductRow['status'],
  SupplierProductStatus
> = {
  pending_baseline: 'PENDING_BASELINE',
  active: 'ACTIVE',
  needs_reconciliation: 'NEEDS_RECONCILIATION',
};

const KIND_TO_DOMAIN: Record<typeof supplierExternalEvents.$inferSelect.kind, SupplierEventKind> = {
  order: 'ORDER',
  order_cancel: 'ORDER_CANCEL',
  source_return: 'SOURCE_RETURN',
};
const COVERAGE_TO_DOMAIN: Record<
  typeof supplierExternalEvents.$inferSelect.coverage,
  SupplierEventCoverage
> = {
  open: 'OPEN',
  covered: 'COVERED',
  ambiguous: 'AMBIGUOUS',
  not_applicable: 'NOT_APPLICABLE',
};

export interface UncoveredSupplierEvent {
  readonly id: string;
  readonly productId: string;
  readonly kind: SupplierEventKind;
  readonly quantity: number;
  readonly coverage: SupplierEventCoverage;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly externalRef: string;
  readonly externalLineRef: string;
  readonly storeId: string | null;
}

export interface SupplierReservationCommitment {
  readonly reservationId: string;
  readonly allocationLineId: string | null;
  readonly commitmentKey: string;
  readonly storeId: string;
  readonly quantity: number;
  readonly orderedQuantity: number;
  readonly cancelledQuantity: number;
}

/** An issued RE line that no confirmed observation has fully reflected yet (part of U). */
export interface SupplierIssuedOrderCommitment {
  readonly lineId: string;
  readonly orderId: string;
  readonly code: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly orderedAt: Date;
  readonly quantity: number;
  /** Declared reflected by observations so far. */
  readonly reflectedQuantity: number;
  /** Recorded as a B order through a pre-RE manual order link (never double counted). */
  readonly orderedQuantity: number;
  /** quantity - reflected - ordered: still owed to B's count. */
  readonly unreflectedQuantity: number;
}

export interface SupplierProductFacts {
  readonly mapping: SupplierProductRow;
  readonly baseline: {
    readonly lineId: string;
    readonly observationId: string;
    readonly observedQuantity: number;
    readonly observedAt: Date;
  } | null;
  readonly events: readonly UncoveredSupplierEvent[];
  readonly offerHoldQuantity: number;
  readonly reservations: readonly SupplierReservationCommitment[];
  readonly issuedOrders: readonly SupplierIssuedOrderCommitment[];
  readonly balance: {
    readonly onHand: number;
    readonly reserved: number;
    readonly version: number;
  };
  /** Links recorded beyond a commitment's quantity (data damage): the SKU is treated as blocked. */
  readonly integrityIssues: readonly string[];
  readonly position: SupplierPosition;
}

/**
 * Net B-ordered quantity per commitment key (allocation line, or the reservation for legacy
 * holds without one). Reads only the links of the given holds through their indexes, so the
 * cost follows the live holds, not the growing order history.
 */
export async function loadOrderedByCommitment(
  tx: Transaction,
  holds: readonly { readonly id: string; readonly allocationLineId: string | null }[],
): Promise<Map<string, { ordered: number; cancelled: number }>> {
  const lineIds = [
    ...new Set(holds.flatMap((hold) => (hold.allocationLineId ? [hold.allocationLineId] : []))),
  ];
  const legacyIds = holds.filter((hold) => !hold.allocationLineId).map((hold) => hold.id);
  if (lineIds.length === 0 && legacyIds.length === 0) return new Map();
  const keyCondition = or(
    lineIds.length > 0 ? inArray(supplierOrderSourceLinks.allocationLineId, lineIds) : undefined,
    legacyIds.length > 0
      ? and(
          isNull(supplierOrderSourceLinks.allocationLineId),
          inArray(supplierOrderSourceLinks.reservationId, legacyIds),
        )
      : undefined,
  );
  const rows = await tx
    .select({
      key: sql<string>`coalesce(${supplierOrderSourceLinks.allocationLineId}, ${supplierOrderSourceLinks.reservationId})`,
      ordered:
        sql<number>`coalesce(sum(${supplierOrderSourceLinks.quantity}) filter (where ${supplierExternalEvents.kind} = 'order'), 0)`.mapWith(
          Number,
        ),
      cancelled:
        sql<number>`coalesce(sum(${supplierOrderSourceLinks.quantity}) filter (where ${supplierExternalEvents.kind} = 'order_cancel'), 0)`.mapWith(
          Number,
        ),
    })
    .from(supplierOrderSourceLinks)
    .innerJoin(
      supplierExternalEvents,
      eq(supplierExternalEvents.id, supplierOrderSourceLinks.eventId),
    )
    .where(keyCondition)
    .groupBy(
      sql`coalesce(${supplierOrderSourceLinks.allocationLineId}, ${supplierOrderSourceLinks.reservationId})`,
    );
  return new Map(
    rows.map((row) => [
      row.key,
      { ordered: row.ordered - row.cancelled, cancelled: row.cancelled },
    ]),
  );
}

/**
 * Loads every fact the reconciliation needs for the given mapped SKUs (or all mapped SKUs) in
 * a bounded number of set queries, then computes each position with the pure domain function.
 */
export async function loadSupplierProductFacts(
  tx: Transaction,
  productIds?: readonly string[],
): Promise<Map<string, SupplierProductFacts>> {
  const mappings = await tx
    .select()
    .from(supplierSourceProducts)
    .where(
      productIds === undefined
        ? undefined
        : productIds.length === 0
          ? sql`false`
          : inArray(supplierSourceProducts.productId, [...productIds]),
    )
    .orderBy(asc(supplierSourceProducts.productId));
  if (mappings.length === 0) return new Map();
  const ids = mappings.map((mapping) => mapping.productId);
  const baselineIds = mappings.flatMap((mapping) =>
    mapping.baselineObservationLineId ? [mapping.baselineObservationLineId] : [],
  );

  const [baselines, events, offerHolds, activeReservations, balances] = await Promise.all([
    baselineIds.length === 0
      ? Promise.resolve([])
      : tx
          .select({
            lineId: supplierStockObservationLines.id,
            observationId: supplierStockObservationLines.observationId,
            productId: supplierStockObservationLines.productId,
            observedQuantity: supplierStockObservationLines.observedQuantity,
            observedAt: supplierStockObservations.observedAt,
          })
          .from(supplierStockObservationLines)
          .innerJoin(
            supplierStockObservations,
            eq(supplierStockObservations.id, supplierStockObservationLines.observationId),
          )
          .where(inArray(supplierStockObservationLines.id, baselineIds)),
    tx
      .select()
      .from(supplierExternalEvents)
      .where(
        and(
          inArray(supplierExternalEvents.productId, ids),
          inArray(supplierExternalEvents.coverage, ['open', 'ambiguous']),
        ),
      )
      .orderBy(asc(supplierExternalEvents.occurredAt), asc(supplierExternalEvents.id)),
    tx
      .select({
        productId: dailyPriorityOffers.productId,
        quantity: sql<number>`coalesce(sum(${dailyPriorityOffers.stockHeldQuantity}), 0)`.mapWith(
          Number,
        ),
      })
      .from(dailyPriorityOffers)
      .where(
        and(
          inArray(dailyPriorityOffers.productId, ids),
          gt(dailyPriorityOffers.stockHeldQuantity, 0),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      )
      .groupBy(dailyPriorityOffers.productId),
    tx
      .select({
        id: reservations.id,
        productId: reservations.productId,
        storeId: reservations.storeId,
        allocationLineId: reservations.allocationLineId,
        quantity: reservations.quantity,
      })
      .from(reservations)
      .where(
        and(
          inArray(reservations.productId, ids),
          eq(reservations.status, 'active'),
          isNull(reservations.deletedAt),
        ),
      )
      .orderBy(asc(reservations.createdAt), asc(reservations.id)),
    tx.select().from(warehouseBalances).where(inArray(warehouseBalances.productId, ids)),
  ]);

  // RE lines issued out of A that no observation reflected yet stay commitments B may not show.
  const issuedLines = await tx
    .select({
      lineId: reshareOrderLines.id,
      orderId: reshareOrders.id,
      code: reshareOrders.code,
      storeId: reshareOrders.storeId,
      storeName: reshareOrders.storeNameSnapshot,
      orderedAt: reshareOrders.orderedAt,
      productId: reshareOrderLines.productId,
      quantity: reshareOrderLines.quantity,
      reflectedQuantity: reshareOrderLines.supplierReflectedQuantity,
    })
    .from(reshareOrderLines)
    .innerJoin(reshareOrders, eq(reshareOrders.id, reshareOrderLines.reshareOrderId))
    .where(
      and(
        inArray(reshareOrderLines.productId, ids),
        sql`${reshareOrderLines.supplierReflectedQuantity} < ${reshareOrderLines.quantity}`,
      ),
    )
    .orderBy(asc(reshareOrders.orderedAt), asc(reshareOrderLines.id));
  const issuedSources =
    issuedLines.length === 0
      ? []
      : await tx
          .select({
            lineId: reshareOrderSources.reshareOrderLineId,
            id: reshareOrderSources.reservationId,
            allocationLineId: reshareOrderSources.allocationLineId,
            quantity: reshareOrderSources.quantity,
          })
          .from(reshareOrderSources)
          .where(
            inArray(
              reshareOrderSources.reshareOrderLineId,
              issuedLines.map((line) => line.lineId),
            ),
          );
  const ordered = await loadOrderedByCommitment(tx, [...activeReservations, ...issuedSources]);
  const baselineByLine = new Map(baselines.map((row) => [row.lineId, row]));
  const eventsByProduct = groupBy(
    events.map((row): UncoveredSupplierEvent => ({
      id: row.id,
      productId: row.productId,
      kind: KIND_TO_DOMAIN[row.kind],
      quantity: row.quantity,
      coverage: COVERAGE_TO_DOMAIN[row.coverage],
      occurredAt: row.occurredAt,
      recordedAt: row.recordedAt,
      externalRef: row.externalRef,
      externalLineRef: row.externalLineRef,
      storeId: row.storeId,
    })),
    (event) => event.productId,
  );
  const holdByProduct = new Map(offerHolds.map((row) => [row.productId, row.quantity]));
  const balanceByProduct = new Map(balances.map((row) => [row.productId, row]));
  const reservationsByProduct = groupBy(activeReservations, (row) => row.productId);
  const issuedByProduct = groupBy(issuedLines, (row) => row.productId);
  const sourcesByLine = groupBy(issuedSources, (row) => row.lineId);

  const result = new Map<string, SupplierProductFacts>();
  for (const mapping of mappings) {
    const integrityIssues: string[] = [];
    const commitments = (reservationsByProduct.get(mapping.productId) ?? []).map(
      (row): SupplierReservationCommitment => {
        const key = row.allocationLineId ?? row.id;
        const linked = ordered.get(key) ?? { ordered: 0, cancelled: 0 };
        if (linked.ordered > row.quantity || linked.ordered < 0) {
          integrityIssues.push(`commitment ${key} links ${linked.ordered} of ${row.quantity}`);
        }
        return {
          reservationId: row.id,
          allocationLineId: row.allocationLineId,
          commitmentKey: key,
          storeId: row.storeId,
          quantity: row.quantity,
          orderedQuantity: Math.min(row.quantity, Math.max(0, linked.ordered)),
          cancelledQuantity: linked.cancelled,
        };
      },
    );
    const issuedOrders = (issuedByProduct.get(mapping.productId) ?? []).map(
      (row): SupplierIssuedOrderCommitment => {
        const linkedOrdered = (sourcesByLine.get(row.lineId) ?? []).reduce((total, source) => {
          const linked = ordered.get(source.allocationLineId ?? source.id)?.ordered ?? 0;
          return total + Math.min(source.quantity, Math.max(0, linked));
        }, 0);
        const orderedQuantity = Math.min(row.quantity - row.reflectedQuantity, linkedOrdered);
        return {
          lineId: row.lineId,
          orderId: row.orderId,
          code: row.code,
          storeId: row.storeId,
          storeName: row.storeName,
          orderedAt: row.orderedAt,
          quantity: row.quantity,
          reflectedQuantity: row.reflectedQuantity,
          orderedQuantity,
          unreflectedQuantity: row.quantity - row.reflectedQuantity - orderedQuantity,
        };
      },
    );
    const balanceRow = balanceByProduct.get(mapping.productId);
    const balance = {
      onHand: balanceRow?.onHandQuantity ?? 0,
      reserved: balanceRow?.reservedQuantity ?? 0,
      version: balanceRow?.version ?? 0,
    };
    const baselineRow = mapping.baselineObservationLineId
      ? baselineByLine.get(mapping.baselineObservationLineId)
      : undefined;
    const baseline = baselineRow
      ? {
          lineId: baselineRow.lineId,
          observationId: baselineRow.observationId,
          observedQuantity: baselineRow.observedQuantity,
          observedAt: baselineRow.observedAt,
        }
      : null;
    const productEvents = eventsByProduct.get(mapping.productId) ?? [];
    const position = computeSupplierPosition({
      status:
        integrityIssues.length > 0 && mapping.status === 'active'
          ? 'NEEDS_RECONCILIATION'
          : SUPPLIER_STATUS_TO_DOMAIN[mapping.status],
      baselineQuantity: baseline?.observedQuantity ?? null,
      events: productEvents,
      offerHoldQuantity: holdByProduct.get(mapping.productId) ?? 0,
      reservations: commitments.map((commitment) => ({
        quantity: commitment.quantity,
        orderedQuantity: commitment.orderedQuantity,
      })),
      issuedOrders: issuedOrders.map((order) => ({
        quantity: order.quantity,
        reflectedQuantity: order.quantity - order.unreflectedQuantity,
      })),
      ledgerOnHand: balance.onHand,
      ledgerReserved: balance.reserved,
    });
    result.set(mapping.productId, {
      mapping,
      baseline,
      events: productEvents,
      offerHoldQuantity: holdByProduct.get(mapping.productId) ?? 0,
      reservations: commitments,
      issuedOrders,
      balance,
      integrityIssues,
      position,
    });
  }
  return result;
}

/**
 * The stale-preview token: it moves whenever a supplier command, a hold, a reservation or any
 * ledger movement could change the numbers of these SKUs.
 */
export function supplierRevisionToken(facts: Iterable<SupplierProductFacts>): string {
  const parts = [...facts]
    .map((fact) => [
      fact.mapping.productId,
      fact.mapping.revision,
      fact.mapping.status,
      fact.mapping.baselineObservationLineId ?? '',
      fact.balance.version,
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Worker seam: the most a new allocation (or a new priority offer) may take per mapped SKU.
 * Unmapped SKUs are absent and keep the ledger rule. Read-only; it never writes the ledger.
 */
export async function loadSupplierAllocationCaps(tx: Transaction): Promise<Map<string, number>> {
  const facts = await loadSupplierProductFacts(tx);
  return new Map(
    [...facts.values()].map((fact) => [
      fact.mapping.productId,
      fact.integrityIssues.length > 0 ? 0 : fact.position.allocatableQuantity,
    ]),
  );
}

/** Product ids among `productIds` that are mapped to a supplier source (any status). */
export async function loadSupplierMappedProductIds(
  tx: Transaction,
  productIds: readonly string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await tx
    .select({ productId: supplierSourceProducts.productId })
    .from(supplierSourceProducts)
    .where(inArray(supplierSourceProducts.productId, [...new Set(productIds)]));
  return new Set(rows.map((row) => row.productId));
}

/**
 * Legacy paths that would add or remove central stock of a reconciled SKU outside the supplier
 * reconciliation (cumulative inbound, inbound cancellation, manual adjustment) are refused.
 */
export async function assertNotSupplierReconciled(
  tx: Transaction,
  productIds: readonly string[],
  action: string,
): Promise<void> {
  const mapped = await loadSupplierMappedProductIds(tx, productIds);
  if (mapped.size > 0) {
    throw new SupplierReconciliationError(
      'SOURCE_RECONCILED',
      `Mặt hàng thuộc nguồn Reshare đang đối chiếu: không ${action}. Dùng "Đối chiếu tồn Reshare" để cập nhật số tồn Reshare.`,
      { productIds: [...mapped] },
    );
  }
}

export async function lockSupplierProducts(
  tx: Transaction,
  productIds: readonly string[],
): Promise<SupplierProductRow[]> {
  if (productIds.length === 0) return [];
  return tx
    .select()
    .from(supplierSourceProducts)
    .where(inArray(supplierSourceProducts.productId, [...new Set(productIds)]))
    .orderBy(asc(supplierSourceProducts.productId))
    .for('update');
}

export interface SupplierProjectionResult {
  readonly productId: string;
  readonly onHandBefore: number;
  readonly reservedBefore: number;
  readonly onHandAfter: number;
  readonly versionBefore: number;
  readonly ledgerEntryId: string | null;
  readonly position: SupplierPosition;
}

/**
 * Moves on-hand of each baselined SKU to R + F with one audited adjustment entry. A SKU whose
 * ledger already matches writes nothing. The caller holds locks 3 and 4 for these products.
 */
export async function projectSupplierAvailability(
  tx: Transaction,
  input: {
    readonly productIds: readonly string[];
    readonly sourceType: 'supplier_stock_observation' | 'supplier_event_batch';
    readonly sourceId: string;
    readonly actorUserId: string;
    readonly reason: string;
    readonly occurredAt: Date;
    readonly metadata?: JsonObject;
  },
): Promise<Map<string, SupplierProjectionResult>> {
  const facts = await loadSupplierProductFacts(tx, input.productIds);
  const results = new Map<string, SupplierProjectionResult>();
  for (const productId of [...new Set(input.productIds)].sort()) {
    const fact = facts.get(productId);
    if (!fact) continue;
    const target = fact.position.targetOnHand;
    let ledgerEntryId: string | null = null;
    let onHandAfter = fact.balance.onHand;
    if (target !== null && target !== fact.balance.onHand) {
      const movement = await applyWarehouseMovement(tx, {
        productId,
        eventType: 'adjustment',
        onHandDelta: target - fact.balance.onHand,
        reservedDelta: 0,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reason: input.reason,
        metadata: {
          ...input.metadata,
          projection: 'supplier_free_stock',
          effectiveSupplierQuantity: fact.position.effectiveSupplierQuantity,
          unorderedCommitmentQuantity: fact.position.unorderedCommitmentQuantity,
          freeQuantity: fact.position.freeQuantity,
          shortfallQuantity: fact.position.shortfallQuantity,
        },
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
      });
      ledgerEntryId = movement.ledgerEntryId;
      onHandAfter = movement.onHandQuantity;
    }
    results.set(productId, {
      productId,
      onHandBefore: fact.balance.onHand,
      reservedBefore: fact.balance.reserved,
      onHandAfter,
      versionBefore: fact.balance.version,
      ledgerEntryId,
      position: fact.position,
    });
  }
  return results;
}

/** Takes the warehouse-balance advisory locks of these SKUs in the shared product order. */
export async function lockWarehouseBalances(
  tx: Transaction,
  productIds: readonly string[],
): Promise<void> {
  for (const productId of [...new Set(productIds)].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-balance:${productId}`}, 0))`,
    );
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(key(row)) ?? [];
    group.push(row);
    result.set(key(row), group);
  }
  return result;
}

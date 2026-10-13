import { planReshareOrder, type ReshareOrderPlan } from '@idosi/domain';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency } from './idempotency.js';
import { loadSupplierActor } from './supplier-reconciliation.js';
import { SupplierReconciliationError } from './supplier-errors.js';
import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  auditLogs,
  orderSessions,
  products,
  reservations,
  reshareOrderLines,
  reshareOrderSources,
  reshareOrders,
  stores,
  users,
  type JsonObject,
} from './schema.js';
import { withTransaction, type Transaction } from './transaction.js';
import { applyWarehouseMovement, WarehouseBalanceViolationError } from './warehouse.js';

/**
 * Internal Reshare orders (docs/reshare-auto-orders.md).
 *
 * Accepting an allocation result with new goods calls issueReshareOrderInTransaction inside the
 * acceptance transaction: one RE order per result, its holds marked issued, and one ledger entry
 * per product taking the goods out of on-hand and out of reserved. The store's stock is not
 * touched; it grows only by the quantity a finalized receipt records.
 *
 * Lock order (callers hold the first three): stock-jobs → shipment → decision FOR UPDATE →
 * the result's reservations FOR UPDATE → RE code counter row (serialized by stock-jobs) →
 * warehouse-balance advisory locks in product order.
 */

export const RESHARE_ORDER_LEDGER_SOURCE = 'reshare_order';

export type ReshareActorRole = 'store' | 'wholesale' | 'htkd';

export class ReshareOrderIntegrityError extends Error {
  public readonly code = 'RESHARE_ORDER_INTEGRITY';

  public constructor(message: string) {
    super(message);
    this.name = 'ReshareOrderIntegrityError';
  }
}

/** The central warehouse cannot cover the accepted holds (H or R already lower than them). */
export class ReshareOrderStockError extends Error {
  public readonly code = 'RESHARE_ORDER_STOCK_CONFLICT';
  public readonly productId: string;
  public readonly quantity: number;

  public constructor(productId: string, quantity: number) {
    super(`The central warehouse cannot issue ${quantity} of product ${productId}.`);
    this.name = 'ReshareOrderStockError';
    this.productId = productId;
    this.quantity = quantity;
  }
}

export interface IssuedReshareOrderLine {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly ledgerEntryId: string;
  readonly onHandAfter: number;
  readonly reservedAfter: number;
}

export interface IssuedReshareOrder {
  readonly id: string;
  readonly code: string;
  readonly totalQuantity: number;
  readonly lines: readonly IssuedReshareOrderLine[];
}

/**
 * Creates the RE order of an accepted decision and issues its goods. The decision row must be
 * the freshly accepted one, locked by the caller in this transaction. Any failure (missing
 * hold, insufficient stock, constraint) throws and rolls back the acceptance with it.
 */
export async function issueReshareOrderInTransaction(
  tx: Transaction,
  input: {
    readonly decision: typeof allocationResultDecisions.$inferSelect;
    readonly actorUserId: string;
    /** admin only for a reviewed cutover backfill (origin 'backfill'). */
    readonly actorRole: ReshareActorRole | 'admin';
    readonly requestId: string | null;
    readonly occurredAt: Date;
    readonly origin?: 'acceptance' | 'backfill';
  },
): Promise<IssuedReshareOrder> {
  const origin = input.origin ?? 'acceptance';
  if ((input.actorRole === 'admin') !== (origin === 'backfill')) {
    throw new ReshareOrderIntegrityError('Only a cutover backfill is issued by an administrator.');
  }
  const { decision } = input;
  if (decision.status !== 'accepted' || decision.respondedAt === null) {
    throw new ReshareOrderIntegrityError(`Decision ${decision.id} is not accepted.`);
  }
  // Only the result's own goods: holds carried from earlier results already have their RE order
  // (or predate RE orders and keep the receipt-time rule); they are never issued again here.
  const holds = await tx
    .select({
      reservationId: reservations.id,
      allocationLineId: allocationLines.id,
      productId: reservations.productId,
      quantity: reservations.quantity,
      allocatedQuantity: allocationLines.allocatedQuantity,
    })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .where(
      and(
        eq(allocationLines.allocationRunId, decision.allocationRunId),
        eq(allocationLines.storeId, decision.storeId),
        eq(reservations.storeId, decision.storeId),
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
      ),
    )
    .orderBy(asc(reservations.id))
    .for('update', { of: reservations });
  if (holds.some((hold) => hold.quantity !== hold.allocatedQuantity)) {
    throw new ReshareOrderIntegrityError(
      `A hold of result ${decision.id} does not match its allocation line.`,
    );
  }
  let plan: ReshareOrderPlan;
  try {
    plan = planReshareOrder(holds);
  } catch (error: unknown) {
    throw new ReshareOrderIntegrityError(error instanceof Error ? error.message : String(error));
  }
  if (plan.totalQuantity !== decision.grantedQuantity) {
    throw new ReshareOrderIntegrityError(
      `Result ${decision.id} holds ${plan.totalQuantity} of its ${decision.grantedQuantity} granted bags.`,
    );
  }

  const [context] = await tx
    .select({ storeName: stores.name, sessionCode: orderSessions.code })
    .from(stores)
    .innerJoin(orderSessions, eq(orderSessions.id, decision.orderSessionId))
    .where(eq(stores.id, decision.storeId))
    .limit(1);
  if (!context) throw new ReshareOrderIntegrityError('Store or session of the result is missing.');
  const productRows = await tx
    .select({ id: products.id, name: products.name, sku: products.sku })
    .from(products)
    .where(
      inArray(
        products.id,
        plan.lines.map((line) => line.productId),
      ),
    );
  const productById = new Map(productRows.map((row) => [row.id, row]));

  const [order] = await tx
    .insert(reshareOrders)
    .values({
      allocationDecisionId: decision.id,
      allocationRunId: decision.allocationRunId,
      orderSessionId: decision.orderSessionId,
      storeId: decision.storeId,
      origin,
      storeNameSnapshot: context.storeName,
      sessionCodeSnapshot: context.sessionCode,
      totalQuantity: plan.totalQuantity,
      acceptedAt: decision.respondedAt,
      orderedAt: input.occurredAt,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      requestId: input.requestId,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    })
    .returning({ id: reshareOrders.id, code: reshareOrders.code });
  if (!order) throw new Error('RE order insert returned no row.');

  const issuedRows = await tx
    .update(reservations)
    .set({ status: 'issued', updatedAt: input.occurredAt })
    .where(
      and(
        inArray(
          reservations.id,
          holds.map((hold) => hold.reservationId),
        ),
        eq(reservations.status, 'active'),
      ),
    )
    .returning({ id: reservations.id });
  if (issuedRows.length !== holds.length) {
    throw new ReshareOrderIntegrityError('Holds changed while the RE order was issued.');
  }

  const lines: IssuedReshareOrderLine[] = [];
  for (const line of plan.lines) {
    const product = productById.get(line.productId);
    if (!product) throw new ReshareOrderIntegrityError(`Product ${line.productId} is missing.`);
    let movement;
    try {
      movement = await applyWarehouseMovement(tx, {
        productId: line.productId,
        eventType: 'outbound',
        onHandDelta: -line.quantity,
        reservedDelta: -line.quantity,
        sourceType: RESHARE_ORDER_LEDGER_SOURCE,
        sourceId: order.id,
        eventSequence: 1,
        reason: `Xuất theo đơn ${order.code}`,
        metadata: {
          reshareOrderCode: order.code,
          allocationDecisionId: decision.id,
          allocationRunId: decision.allocationRunId,
          orderSessionId: decision.orderSessionId,
          sessionCode: context.sessionCode,
          storeId: decision.storeId,
          storeName: context.storeName,
          quantity: line.quantity,
        },
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
      });
    } catch (error: unknown) {
      if (error instanceof WarehouseBalanceViolationError) {
        throw new ReshareOrderStockError(line.productId, line.quantity);
      }
      throw error;
    }
    if (movement.replayed) {
      throw new ReshareOrderIntegrityError(`RE order ${order.code} was already issued.`);
    }
    const [inserted] = await tx
      .insert(reshareOrderLines)
      .values({
        reshareOrderId: order.id,
        productId: line.productId,
        productNameSnapshot: product.name,
        productSkuSnapshot: product.sku,
        quantity: line.quantity,
        issueLedgerEntryId: movement.ledgerEntryId,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      })
      .returning({ id: reshareOrderLines.id });
    if (!inserted) throw new Error('RE order line insert returned no row.');
    await tx.insert(reshareOrderSources).values(
      line.sources.map((source) => ({
        reshareOrderId: order.id,
        reshareOrderLineId: inserted.id,
        reservationId: source.reservationId,
        allocationLineId: source.allocationLineId,
        storeId: decision.storeId,
        productId: line.productId,
        quantity: source.quantity,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      })),
    );
    lines.push({
      id: inserted.id,
      productId: line.productId,
      quantity: line.quantity,
      ledgerEntryId: movement.ledgerEntryId,
      onHandAfter: movement.onHandQuantity,
      reservedAfter: movement.reservedQuantity,
    });
  }

  await tx.insert(auditLogs).values({
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    actorStoreId: decision.storeId,
    action: 'RESHARE_ORDER_CREATED',
    entityType: 'reshare_order',
    entityId: order.id,
    before: null,
    after: {
      code: order.code,
      status: 'ordered',
      allocationDecisionId: decision.id,
      allocationRunId: decision.allocationRunId,
      orderSessionId: decision.orderSessionId,
      storeId: decision.storeId,
      totalQuantity: plan.totalQuantity,
      lines: lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        ledgerEntryId: line.ledgerEntryId,
        onHandAfter: line.onHandAfter,
        reservedAfter: line.reservedAfter,
        onHandBefore: line.onHandAfter + line.quantity,
        reservedBefore: line.reservedAfter + line.quantity,
      })),
      sources: plan.lines.flatMap((line) =>
        line.sources.map((source) => ({
          reservationId: source.reservationId,
          allocationLineId: source.allocationLineId,
          productId: source.productId,
          quantity: source.quantity,
        })),
      ),
    } satisfies JsonObject,
    metadata: {
      trigger: origin === 'backfill' ? 'reshare-cutover-backfill' : 'allocation-result-accepted',
    },
    createdAt: input.occurredAt,
  });

  return { id: order.id, code: order.code, totalQuantity: plan.totalQuantity, lines };
}

// ---------------------------------------------------------------------------------------------
// Read model: "Lịch sử đặt hàng theo phân bổ"
// ---------------------------------------------------------------------------------------------

export const RESHARE_HISTORY_STATUSES = ['ordered', 'not_ordered', 'cancelled'] as const;
export type ReshareHistoryStatus = (typeof RESHARE_HISTORY_STATUSES)[number];

export interface ReshareHistoryLine {
  readonly productId: string;
  readonly productName: string;
  readonly productSku: string;
  readonly quantity: number;
}

export interface ReshareHistoryDelivery {
  readonly issuedQuantity: number;
  readonly receivedQuantity: number;
  readonly shortageQuantity: number;
  /** Issued, not yet settled by a receipt (waiting for a shipment or for the store's receipt). */
  readonly awaitingReceiptQuantity: number;
  readonly onShipmentQuantity: number;
}

export interface ReshareHistoryRow {
  readonly statusControl: {
    readonly version: number;
    readonly updatedAt: Date | null;
    readonly updatedByName: string | null;
  };
  readonly decisionId: string;
  readonly decisionStatus: (typeof allocationResultDecisions.$inferSelect)['status'];
  readonly allocationRunId: string;
  readonly runNumber: number;
  readonly sessionId: string;
  readonly sessionCode: string;
  readonly businessDate: string;
  readonly sessionOpenedAt: Date | null;
  readonly allocationCompletedAt: Date | null;
  readonly publishedAt: Date;
  readonly acceptedAt: Date | null;
  readonly respondedByName: string | null;
  readonly storeId: string;
  readonly storeName: string;
  readonly status: ReshareHistoryStatus;
  readonly order: {
    readonly id: string;
    readonly code: string;
    readonly status: 'ordered' | 'cancelled';
    readonly origin: string;
    readonly orderedAt: Date;
    readonly actorName: string | null;
    readonly actorRole: string;
    readonly cancelledAt: Date | null;
    readonly cancelReason: string | null;
  } | null;
  readonly lines: readonly ReshareHistoryLine[];
  readonly totalQuantity: number;
  readonly delivery: ReshareHistoryDelivery | null;
}

export interface ListReshareHistoryInput {
  readonly page: number;
  readonly pageSize: number;
  /** Server-authorized store scope; undefined means every store (Admin only). */
  readonly storeIds?: readonly string[];
  readonly sessionId?: string;
  readonly productId?: string;
  readonly status?: ReshareHistoryStatus;
  readonly from?: Date;
  readonly to?: Date;
  readonly code?: string;
  readonly decisionId?: string;
}

export interface ReshareHistoryPage {
  readonly data: readonly ReshareHistoryRow[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

type Reader = Database | Transaction;

/** History time of a row: when its RE was ordered, else when its result was published. */
const historyTime = sql`coalesce(${reshareOrders.orderedAt}, ${allocationResultDecisions.createdAt})`;
const historyStatus = sql`case when ${reshareOrders.status} = 'cancelled' then 'cancelled' else coalesce(${allocationResultDecisions.reshareStatus}, ${reshareOrders.status}::text, 'not_ordered') end`;

/**
 * One row per allocation result that granted new goods and was not rejected: an RE order
 * (ordered/cancelled), or a result still waiting for the store (not ordered). Paged by result so
 * the product lines of one order are never split, filtered and sorted on the server.
 */
export async function listReshareOrderHistory(
  database: Database,
  input: ListReshareHistoryInput,
): Promise<ReshareHistoryPage> {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100
  ) {
    throw new RangeError('Invalid RE order history pagination.');
  }
  const empty = { page: input.page, pageSize: input.pageSize, totalItems: 0, totalPages: 0 };
  if (input.storeIds?.length === 0) return { data: [], pagination: empty };
  return withTransaction(
    database,
    async (tx) => {
      const predicates: SQL[] = [
        // Rejected results never became orders; not-required/legacy results granted nothing new
        // to order. Accepted results without an order predate RE orders (not ordered).
        inArray(allocationResultDecisions.status, ['pending', 'accepted']),
      ];
      if (input.storeIds) {
        predicates.push(inArray(allocationResultDecisions.storeId, [...new Set(input.storeIds)]));
      }
      if (input.decisionId) predicates.push(eq(allocationResultDecisions.id, input.decisionId));
      if (input.sessionId) {
        predicates.push(eq(allocationResultDecisions.orderSessionId, input.sessionId));
      }
      if (input.status) predicates.push(sql`${historyStatus} = ${input.status}`);
      if (input.from) predicates.push(sql`${historyTime} >= ${input.from}`);
      if (input.to) predicates.push(sql`${historyTime} < ${input.to}`);
      if (input.code) {
        predicates.push(sql`${reshareOrders.code} ilike ${`%${escapeLike(input.code)}%`}`);
      }
      if (input.productId) {
        predicates.push(sql`(
          exists (select 1 from ${reshareOrderLines} rl
            where rl.reshare_order_id = ${reshareOrders.id} and rl.product_id = ${input.productId})
          or (${reshareOrders.id} is null and exists (select 1 from ${allocationLines} al
            where al.allocation_run_id = ${allocationResultDecisions.allocationRunId}
              and al.store_id = ${allocationResultDecisions.storeId}
              and al.product_id = ${input.productId} and al.allocated_quantity > 0))
        )`);
      }
      const where = and(...predicates);
      const [totalRow] = await tx
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(allocationResultDecisions)
        .leftJoin(
          reshareOrders,
          eq(reshareOrders.allocationDecisionId, allocationResultDecisions.id),
        )
        .where(where);
      const actor = users;
      const headers = await tx
        .select({
          decision: allocationResultDecisions,
          order: reshareOrders,
          runNumber: allocationRuns.runNumber,
          allocationCompletedAt: allocationRuns.finishedAt,
          sessionCode: orderSessions.code,
          businessDate: orderSessions.businessDate,
          sessionOpenedAt: orderSessions.openedAt,
          storeName: stores.name,
          actorName: actor.displayName,
        })
        .from(allocationResultDecisions)
        .leftJoin(
          reshareOrders,
          eq(reshareOrders.allocationDecisionId, allocationResultDecisions.id),
        )
        .innerJoin(allocationRuns, eq(allocationRuns.id, allocationResultDecisions.allocationRunId))
        .innerJoin(orderSessions, eq(orderSessions.id, allocationResultDecisions.orderSessionId))
        .innerJoin(stores, eq(stores.id, allocationResultDecisions.storeId))
        .leftJoin(actor, eq(actor.id, allocationResultDecisions.respondedByUserId))
        .where(where)
        .orderBy(sql`${historyTime} desc`, sql`${allocationResultDecisions.id} desc`)
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const totalItems = totalRow?.value ?? 0;
      return {
        data: await assembleHistoryRows(tx, headers),
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

type HistoryHeader = {
  readonly decision: typeof allocationResultDecisions.$inferSelect;
  readonly order: typeof reshareOrders.$inferSelect | null;
  readonly runNumber: number;
  readonly allocationCompletedAt: Date | null;
  readonly sessionCode: string;
  readonly businessDate: string;
  readonly sessionOpenedAt: Date | null;
  readonly storeName: string;
  readonly actorName: string | null;
};

async function assembleHistoryRows(
  reader: Reader,
  headers: readonly HistoryHeader[],
): Promise<ReshareHistoryRow[]> {
  if (headers.length === 0) return [];
  const orderIds = headers.flatMap((header) => (header.order ? [header.order.id] : []));
  const unordered = headers.filter((header) => !header.order);
  const orderLines =
    orderIds.length === 0
      ? []
      : await reader
          .select()
          .from(reshareOrderLines)
          .where(inArray(reshareOrderLines.reshareOrderId, orderIds))
          .orderBy(asc(reshareOrderLines.productNameSnapshot), asc(reshareOrderLines.productId));
  const settlement =
    orderIds.length === 0
      ? []
      : await reader
          .select({
            orderId: reshareOrderSources.reshareOrderId,
            issued: sql<number>`sum(${reshareOrderSources.quantity})`.mapWith(Number),
            received:
              sql<number>`coalesce(sum(${reshareOrderSources.receivedQuantity}), 0)`.mapWith(
                Number,
              ),
            shortage:
              sql<number>`coalesce(sum(${reshareOrderSources.shortageQuantity}), 0)`.mapWith(
                Number,
              ),
            awaiting:
              sql<number>`coalesce(sum(${reshareOrderSources.quantity}) filter (where ${reshareOrderSources.settledAt} is null), 0)`.mapWith(
                Number,
              ),
            onShipment:
              sql<number>`coalesce(sum(${reshareOrderSources.quantity}) filter (where ${reshareOrderSources.settledAt} is null and ${reservations.outboundRequestLineId} is not null), 0)`.mapWith(
                Number,
              ),
          })
          .from(reshareOrderSources)
          .innerJoin(reservations, eq(reservations.id, reshareOrderSources.reservationId))
          .where(inArray(reshareOrderSources.reshareOrderId, orderIds))
          .groupBy(reshareOrderSources.reshareOrderId);
  const orderActorIds = [
    ...new Set(
      headers.flatMap((header) => [
        ...(header.order ? [header.order.actorUserId] : []),
        ...(header.decision.reshareStatusUpdatedBy ? [header.decision.reshareStatusUpdatedBy] : []),
      ]),
    ),
  ];
  const orderActors =
    orderActorIds.length === 0
      ? []
      : await reader
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, orderActorIds));
  const pendingLines =
    unordered.length === 0
      ? []
      : await reader
          .select({
            allocationRunId: allocationLines.allocationRunId,
            storeId: allocationLines.storeId,
            productId: allocationLines.productId,
            productName: products.name,
            productSku: products.sku,
            quantity: sql<number>`sum(${allocationLines.allocatedQuantity})`.mapWith(Number),
          })
          .from(allocationLines)
          .innerJoin(products, eq(products.id, allocationLines.productId))
          .where(
            and(
              inArray(allocationLines.allocationRunId, [
                ...new Set(unordered.map((header) => header.decision.allocationRunId)),
              ]),
              inArray(allocationLines.storeId, [
                ...new Set(unordered.map((header) => header.decision.storeId)),
              ]),
              sql`${allocationLines.allocatedQuantity} > 0`,
            ),
          )
          .groupBy(
            allocationLines.allocationRunId,
            allocationLines.storeId,
            allocationLines.productId,
            products.name,
            products.sku,
          )
          .orderBy(asc(products.name), asc(allocationLines.productId));
  const actorName = new Map(orderActors.map((row) => [row.id, row.name]));

  return headers.map((header): ReshareHistoryRow => {
    const { decision, order } = header;
    const lines: ReshareHistoryLine[] = order
      ? orderLines
          .filter((line) => line.reshareOrderId === order.id)
          .map((line) => ({
            productId: line.productId,
            productName: line.productNameSnapshot,
            productSku: line.productSkuSnapshot,
            quantity: line.quantity,
          }))
      : pendingLines
          .filter(
            (line) =>
              line.allocationRunId === decision.allocationRunId &&
              line.storeId === decision.storeId,
          )
          .map((line) => ({
            productId: line.productId,
            productName: line.productName,
            productSku: line.productSku,
            quantity: line.quantity,
          }));
    const delivery = order ? settlement.find((row) => row.orderId === order.id) : undefined;
    return {
      decisionId: decision.id,
      decisionStatus: decision.status,
      allocationRunId: decision.allocationRunId,
      runNumber: header.runNumber,
      sessionId: decision.orderSessionId,
      sessionCode: order?.sessionCodeSnapshot ?? header.sessionCode,
      businessDate: header.businessDate,
      sessionOpenedAt: header.sessionOpenedAt,
      allocationCompletedAt: header.allocationCompletedAt,
      publishedAt: decision.createdAt,
      acceptedAt: decision.respondedAt,
      respondedByName: header.actorName,
      storeId: decision.storeId,
      storeName: order?.storeNameSnapshot ?? header.storeName,
      status: effectiveReshareStatus(decision.reshareStatus, order?.status ?? null),
      statusControl: {
        version: decision.reshareStatusVersion,
        updatedAt: decision.reshareStatusUpdatedAt,
        updatedByName: decision.reshareStatusUpdatedBy
          ? (actorName.get(decision.reshareStatusUpdatedBy) ?? null)
          : null,
      },
      order: order
        ? {
            id: order.id,
            code: order.code,
            status: order.status,
            origin: order.origin,
            orderedAt: order.orderedAt,
            actorName: actorName.get(order.actorUserId) ?? null,
            actorRole: order.actorRole,
            cancelledAt: order.cancelledAt,
            cancelReason: order.cancelReason,
          }
        : null,
      lines,
      totalQuantity: order
        ? order.totalQuantity
        : lines.reduce((sum, line) => sum + line.quantity, 0),
      delivery: delivery
        ? {
            issuedQuantity: delivery.issued,
            receivedQuantity: delivery.received,
            shortageQuantity: delivery.shortage,
            awaitingReceiptQuantity: delivery.awaiting,
            onShipmentQuantity: delivery.onShipment,
          }
        : null,
    };
  });
}

export interface ReshareOrderSummary {
  readonly id: string;
  readonly code: string;
  readonly status: 'ordered' | 'cancelled';
  readonly orderedAt: Date;
  readonly totalQuantity: number;
}

/** RE summaries by decision id, for decision lists and notices (one query per page). */
export async function loadReshareOrderSummaries(
  reader: Reader,
  decisionIds: readonly string[],
): Promise<Map<string, ReshareOrderSummary>> {
  if (decisionIds.length === 0) return new Map();
  const rows = await reader
    .select({
      decisionId: reshareOrders.allocationDecisionId,
      id: reshareOrders.id,
      code: reshareOrders.code,
      status: reshareOrders.status,
      orderedAt: reshareOrders.orderedAt,
      totalQuantity: reshareOrders.totalQuantity,
    })
    .from(reshareOrders)
    .where(inArray(reshareOrders.allocationDecisionId, [...new Set(decisionIds)]));
  return new Map(
    rows.map((row) => [
      row.decisionId,
      {
        id: row.id,
        code: row.code,
        status: row.status,
        orderedAt: row.orderedAt,
        totalQuantity: row.totalQuantity,
      },
    ]),
  );
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function effectiveReshareStatus(
  manual: string | null,
  order: 'ordered' | 'cancelled' | null,
): ReshareHistoryStatus {
  if (order === 'cancelled') return 'cancelled';
  return manual === 'ordered' || manual === 'not_ordered' ? manual : (order ?? 'not_ordered');
}

/** Admin acknowledgement only. No RE creation, warehouse movement or supplier coverage change. */
export async function updateReshareOrderStatus(
  database: Database,
  input: {
    readonly decisionId: string;
    readonly actorUserId: string;
    readonly status: 'ORDERED' | 'NOT_ORDERED';
    readonly expectedStatus: 'ORDERED' | 'NOT_ORDERED';
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly requestId?: string;
  },
) {
  if (
    !['ORDERED', 'NOT_ORDERED'].includes(input.status) ||
    !['ORDERED', 'NOT_ORDERED'].includes(input.expectedStatus) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new SupplierReconciliationError('VALIDATION', 'Trạng thái hoặc phiên bản không hợp lệ.');
  }
  return withIdempotency(
    database,
    {
      scope: `reshare-status:${input.actorUserId}:${input.decisionId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const [decision] = await tx
        .select()
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.id, input.decisionId))
        .for('update');
      if (!decision)
        throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy kết quả phân bổ.');
      const [order] = await tx
        .select({ status: reshareOrders.status })
        .from(reshareOrders)
        .where(eq(reshareOrders.allocationDecisionId, decision.id))
        .for('update');
      const before = effectiveReshareStatus(decision.reshareStatus, order?.status ?? null);
      if (
        !['pending', 'accepted'].includes(decision.status) ||
        decision.grantedQuantity <= 0 ||
        before === 'cancelled'
      ) {
        throw new SupplierReconciliationError(
          'ORDER_SOURCE_NOT_ELIGIBLE',
          'Chỉ đổi trạng thái cho kết quả còn hiệu lực, có hàng được cấp và chưa hủy.',
        );
      }
      if (
        decision.reshareStatusVersion !== input.expectedVersion ||
        before.toUpperCase() !== input.expectedStatus
      ) {
        throw new SupplierReconciliationError(
          'VERSION_CONFLICT',
          'Trạng thái đã thay đổi. Hãy tải lại danh sách trước khi sửa.',
        );
      }
      const status = input.status === 'ORDERED' ? 'ordered' : 'not_ordered';
      const version = decision.reshareStatusVersion + 1;
      await tx
        .update(allocationResultDecisions)
        .set({
          reshareStatus: status,
          reshareStatusVersion: version,
          reshareStatusUpdatedAt: new Date(),
          reshareStatusUpdatedBy: input.actorUserId,
        })
        .where(eq(allocationResultDecisions.id, decision.id));
      await tx.insert(auditLogs).values({
        actorUserId: input.actorUserId,
        actorRole: 'admin',
        actorStoreId: decision.storeId,
        requestId: input.requestId,
        action: 'RESHARE_ORDER_STATUS_UPDATED',
        entityType: 'allocation_result_decision',
        entityId: decision.id,
        before: { status: before, version: decision.reshareStatusVersion },
        after: { status, version },
      });
      const value = { decisionId: decision.id, status: input.status, version };
      return {
        value,
        responseBody: value,
        responseStatus: 200,
        resourceType: 'allocation_result_decision',
        resourceId: decision.id,
      };
    },
    async (tx) => {
      await loadSupplierActor(tx, input.actorUserId, ['admin']);
    },
  );
}

import { createHash, randomUUID } from 'node:crypto';
import {
  PriorityOrderInputSchema,
  PriorityOrderSchema,
  type PriorityContext,
  type PriorityOrderInput,
  type PriorityOrder,
  type PriorityOrderPage,
  type PriorityOrderQuery,
  type PriorityStatusInput,
  type PriorityAvailability,
} from '@idosi/contracts';
import { and, eq, inArray, isNull, sql, desc, count, lte } from 'drizzle-orm';
import type { Database } from './client.js';
import { STOCK_JOBS_LOCK } from './allocation-decisions.js';
import { SHIPPABLE_DECISION_STATUSES } from './allocation-decision-gate.js';
import { withIdempotency } from './idempotency.js';
import { withAdvisoryLock, withTransaction, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';
import { loadSupplierProductFacts } from './supplier-commitments.js';
import { dispatchWarehouseOutboundInTransaction } from './outbound-requests.js';
import {
  allocationLines,
  allocationResultDecisions,
  auditLogs,
  emergencyPriorityOrders as orders,
  emergencyPrioritySources as sources,
  outboundRequestLines,
  outboundRequests,
  products,
  reservations,
  reshareOrderLines,
  reshareOrderSources,
  reshareOrders,
  storeWaitDocuments,
  stores,
  users,
  warehouseBalances,
} from './schema.js';

export class PriorityOrderError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INSUFFICIENT_STOCK',
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
type Reader = Database | Transaction;
async function actorFor(tx: Transaction, userId: string, manager = false) {
  const [actor] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active'), isNull(users.deletedAt)))
    .for('share');
  if (!actor || (manager && actor.role !== 'admin' && actor.role !== 'htkd'))
    throw new PriorityOrderError('FORBIDDEN', 'Bạn không có quyền xử lý đơn ưu tiên khẩn cấp.');
  return actor;
}
async function storeFor(tx: Transaction, storeId: string) {
  const [store] = await tx
    .select()
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .for('share');
  if (!store) throw new PriorityOrderError('CONFLICT', 'Cửa hàng không còn hoạt động.');
  return store;
}
async function readerScope(tx: Transaction, userId: string, storeId?: string) {
  const actor = await actorFor(tx, userId);
  if (actor.role === 'admin' || actor.role === 'htkd') return storeId ? [storeId] : undefined;
  const allowed =
    actor.role === 'store'
      ? actor.storeId
        ? [actor.storeId]
        : []
      : (
          await tx
            .select({ id: stores.id })
            .from(stores)
            .where(
              and(
                eq(stores.kind, 'wholesale'),
                eq(stores.isActive, true),
                isNull(stores.deletedAt),
              ),
            )
        ).map((r) => r.id);
  if (storeId && !allowed.includes(storeId))
    throw new PriorityOrderError('FORBIDDEN', 'Không có quyền xem cửa hàng này.');
  return storeId ? [storeId] : allowed;
}
async function available(tx: Transaction, ids?: string[]): Promise<PriorityAvailability[]> {
  const rows = await tx
    .select({ id: products.id, name: products.name, sku: products.sku })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        isNull(products.deletedAt),
        ids ? inArray(products.id, ids) : undefined,
      ),
    )
    .orderBy(products.name);
  const balances = await tx
    .select({
      product_id: warehouseBalances.productId,
      available: sql<number>`${warehouseBalances.onHandQuantity}-${warehouseBalances.reservedQuantity}`,
    })
    .from(warehouseBalances)
    .where(
      inArray(
        warehouseBalances.productId,
        rows.map((r) => r.id),
      ),
    );
  const byId = new Map(balances.map((r) => [r.product_id, r.available]));
  const facts = await loadSupplierProductFacts(
    tx,
    rows.map((r) => r.id),
  );
  const observedAt = new Date().toISOString();
  return rows.map((r) => {
    const availableBags = Math.max(0, byId.get(r.id) ?? 0);
    const fact = facts.get(r.id);
    const cap = fact
      ? fact.integrityIssues.length
        ? 0
        : fact.position.allocatableQuantity
      : availableBags;
    const maxAdditionalBags = Math.max(0, Math.min(10000, availableBags, cap));
    return {
      productId: r.id,
      name: r.name,
      sku: r.sku,
      availableBags,
      maxAdditionalBags,
      orderable: maxAdditionalBags > 0,
      blockingReason:
        availableBags === 0
          ? 'Tồn khả dụng = 0, không thể đặt mặt hàng này.'
          : maxAdditionalBags === 0
            ? 'Nguồn Reshare đang chặn cấp mới; cần đối chiếu tồn.'
            : null,
      observedAt,
    };
  });
}
function sourceQuery(tx: Reader, storeId: string, ids?: string[]) {
  return tx
    .select({
      hold: reservations,
      name: products.name,
      code: reshareOrders.code,
      issueId: reshareOrderSources.id,
    })
    .from(reservations)
    .innerJoin(products, eq(products.id, reservations.productId))
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .innerJoin(
      allocationResultDecisions,
      and(
        eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
        eq(allocationResultDecisions.storeId, allocationLines.storeId),
      ),
    )
    .leftJoin(reshareOrderSources, eq(reshareOrderSources.reservationId, reservations.id))
    .leftJoin(reshareOrders, eq(reshareOrders.id, reshareOrderSources.reshareOrderId))
    .where(
      and(
        eq(reservations.storeId, storeId),
        eq(allocationLines.storeId, storeId),
        eq(allocationLines.productId, reservations.productId),
        eq(allocationLines.allocatedQuantity, reservations.quantity),
        eq(reservations.consumedQuantity, 0),
        isNull(reservations.deletedAt),
        isNull(reservations.outboundRequestLineId),
        inArray(reservations.status, ['active', 'issued']),
        inArray(allocationResultDecisions.status, [...SHIPPABLE_DECISION_STATUSES]),
        ids ? inArray(reservations.id, ids) : undefined,
      ),
    )
    .orderBy(reservations.id);
}
function revision(hold: typeof reservations.$inferSelect) {
  return `${hold.status}:${hold.quantity}:${hold.updatedAt.toISOString()}`;
}
export async function getPriorityContext(
  database: Database,
  userId: string,
  storeId?: string,
  sourcePage = 1,
): Promise<PriorityContext> {
  return withTransaction(
    database,
    async (tx) => {
      await actorFor(tx, userId, true);
      const storeRows = await tx
        .select({ id: stores.id, name: stores.name })
        .from(stores)
        .where(and(eq(stores.isActive, true), isNull(stores.deletedAt)))
        .orderBy(stores.name);
      if (!storeId)
        return {
          stores: storeRows,
          sources: [],
          sourcePage,
          sourcesHaveMore: false,
          products: [],
          waitDocuments: [],
        };
      await storeFor(tx, storeId);
      const held = await sourceQuery(tx, storeId)
        .limit(51)
        .offset((sourcePage - 1) * 50);
      return {
        stores: storeRows,
        sourcePage,
        sourcesHaveMore: held.length > 50,
        sources: held
          .slice(0, 50)
          .filter((r) => (r.hold.status === 'active' ? r.issueId === null : r.issueId !== null))
          .map((r) => ({
            id: r.hold.id,
            revision: revision(r.hold),
            productId: r.hold.productId,
            name: r.name,
            quantity: r.hold.quantity,
            status: r.hold.status as 'active' | 'issued',
            heldSince: r.hold.createdAt.toISOString(),
            reshareCode: r.code,
          })),
        products: await available(tx),
        waitDocuments: await tx
          .select({ id: storeWaitDocuments.id, code: storeWaitDocuments.code })
          .from(storeWaitDocuments)
          .where(
            and(eq(storeWaitDocuments.storeId, storeId), eq(storeWaitDocuments.status, 'current')),
          ),
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
export async function getPriorityAvailability(
  database: Database,
  userId: string,
  storeId: string,
  productId: string,
) {
  return withTransaction(
    database,
    async (tx) => {
      await actorFor(tx, userId, true);
      await storeFor(tx, storeId);
      const [row] = await available(tx, [productId]);
      if (!row) throw new PriorityOrderError('NOT_FOUND', 'Mặt hàng không còn hoạt động.');
      return row;
    },
    { isolationLevel: 'repeatable read' },
  );
}
async function validateDraft(tx: Transaction, input: PriorityOrderInput, lock: boolean) {
  const query = sourceQuery(
    tx,
    input.storeId,
    input.sources.map((s) => s.id),
  );
  const held = lock ? await query.for('update', { of: reservations }) : await query;
  if (
    held.length !== input.sources.length ||
    held.some((r) => input.sources.find((s) => s.id === r.hold.id)?.revision !== revision(r.hold))
  )
    throw new PriorityOrderError(
      'CONFLICT',
      'Nguồn đang giữ đã thay đổi hoặc đã có chuyến giao. Vui lòng tải lại.',
    );
  if (held.some((r) => (r.hold.status === 'issued' ? !r.issueId : !!r.issueId)))
    throw new PriorityOrderError('CONFLICT', 'Chứng từ xuất của nguồn đang giữ không nhất quán.');
  const stock = await available(
    tx,
    input.additionalLines.map((l) => l.productId),
  );
  const shortages = input.additionalLines.flatMap((line) => {
    const row = stock.find((r) => r.productId === line.productId);
    const maxAdditionalBags = row?.maxAdditionalBags ?? 0;
    return !row || line.quantity > maxAdditionalBags
      ? [
          {
            productId: line.productId,
            requested: line.quantity,
            availableBags: row?.availableBags ?? 0,
            maxAdditionalBags,
            shortage: Math.max(0, line.quantity - maxAdditionalBags),
            reason: row?.blockingReason ?? null,
          },
        ]
      : [];
  });
  if (shortages.length) {
    const first = shortages[0]!;
    throw new PriorityOrderError(
      'INSUFFICIENT_STOCK',
      first.reason ??
        `Kho chỉ còn ${first.maxAdditionalBags} bao khả dụng, chỉ được đặt tối đa ${first.maxAdditionalBags} bao.`,
      { items: shortages },
    );
  }
  const total =
    held.reduce((n, r) => n + r.hold.quantity, 0) +
    input.additionalLines.reduce((n, r) => n + r.quantity, 0);
  if (total > 10000) throw new PriorityOrderError('CONFLICT', 'Tổng đơn tối đa 10000 bao.');
  return { held, stock, total };
}
export async function previewPriorityOrder(
  database: Database,
  userId: string,
  raw: PriorityOrderInput,
) {
  const input = PriorityOrderInputSchema.parse(raw);
  return withTransaction(
    database,
    async (tx) => {
      await actorFor(tx, userId, true);
      await storeFor(tx, input.storeId);
      const p = await validateDraft(tx, input, false);
      return { totalQuantity: p.total, products: p.stock };
    },
    { isolationLevel: 'repeatable read' },
  );
}
export async function submitPriorityOrder(
  database: Database,
  userId: string,
  raw: PriorityOrderInput,
  key: string,
  requestId: string | null = null,
) {
  const input = PriorityOrderInputSchema.parse(raw);
  input.sources.sort((a, b) => a.id.localeCompare(b.id));
  input.additionalLines.sort((a, b) => a.productId.localeCompare(b.productId));
  const result = await withIdempotency(
    database,
    {
      scope: `emergency-priority:${userId}`,
      key,
      requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    },
    async (tx) =>
      withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, async () => {
        const actor = await actorFor(tx, userId, true),
          store = await storeFor(tx, input.storeId);
        const { held, total } = await validateDraft(tx, input, true);
        const now = new Date(),
          id = randomUUID(),
          outboundId = randomUUID();
        await tx.insert(outboundRequests).values({
          id: outboundId,
          requestNumber: `UK-${id}`,
          storeId: store.id,
          status: 'reserved',
          requestedByUserId: userId,
          approvedByUserId: userId,
          submittedAt: now,
          approvedAt: now,
          notes: 'Đơn ưu tiên khẩn cấp',
        });
        const [order] = await tx
          .insert(orders)
          .values({
            id,
            storeId: store.id,
            outboundRequestId: outboundId,
            actorUserId: userId,
            actorName: actor.displayName,
            storeName: store.name,
            totalQuantity: total,
            notes: input.notes,
            approvedAt: now,
          })
          .returning();
        if (!order) throw new Error('Missing priority header');
        const allHolds = held.map((r) => ({ ...r.hold, kind: 'held' as 'held' | 'additional' }));
        const productIds = [
          ...new Set([
            ...held.map((r) => r.hold.productId),
            ...input.additionalLines.map((r) => r.productId),
          ]),
        ].sort();
        const outboundLineByProduct = new Map<string, string>();
        for (const productId of productIds) {
          const additional =
            input.additionalLines.find((l) => l.productId === productId)?.quantity ?? 0;
          const quantity =
            additional +
            held
              .filter((r) => r.hold.productId === productId)
              .reduce((n, r) => n + r.hold.quantity, 0);
          const [line] = await tx
            .insert(outboundRequestLines)
            .values({
              outboundRequestId: outboundId,
              productId,
              requestedQuantity: quantity,
              approvedQuantity: quantity,
              reservedQuantity: quantity,
            })
            .returning();
          if (!line) throw new Error('Missing outbound line');
          outboundLineByProduct.set(productId, line.id);
          if (additional) {
            await applyWarehouseMovement(tx, {
              productId,
              eventType: 'reservation',
              onHandDelta: 0,
              reservedDelta: additional,
              sourceType: 'emergency_priority_order',
              sourceId: id,
              actorUserId: userId,
              occurredAt: now,
            });
            const [hold] = await tx
              .insert(reservations)
              .values({
                productId,
                storeId: store.id,
                outboundRequestLineId: line.id,
                quantity: additional,
                createdByUserId: userId,
              })
              .returning();
            if (!hold) throw new Error('Missing new reservation');
            allHolds.push({ ...hold, kind: 'additional' });
          }
        }
        for (const row of held) {
          const changed = await tx
            .update(reservations)
            .set({
              outboundRequestLineId: outboundLineByProduct.get(row.hold.productId)!,
              updatedAt: now,
            })
            .where(
              and(eq(reservations.id, row.hold.id), isNull(reservations.outboundRequestLineId)),
            )
            .returning({ id: reservations.id });
          if (changed.length !== 1)
            throw new PriorityOrderError('CONFLICT', 'Nguồn đã được gắn vào chuyến giao khác.');
        }
        await tx
          .insert(sources)
          .values(allHolds.map((h) => ({ orderId: id, reservationId: h.id, kind: h.kind })));
        const toIssue = allHolds.filter((h) => h.status === 'active');
        const [re] = await tx
          .insert(reshareOrders)
          .values({
            emergencyOrderId: id,
            storeId: store.id,
            origin: 'emergency',
            storeNameSnapshot: store.name,
            sessionCodeSnapshot: order.code,
            totalQuantity: toIssue.reduce((n, h) => n + h.quantity, 0),
            acceptedAt: now,
            orderedAt: now,
            actorUserId: userId,
            actorRole: actor.role,
            requestId,
          })
          .returning();
        if (!re) throw new Error('Missing RE');
        await tx
          .update(reservations)
          .set({ status: 'issued', updatedAt: now })
          .where(
            inArray(
              reservations.id,
              toIssue.map((h) => h.id),
            ),
          );
        for (const productId of [...new Set(toIssue.map((h) => h.productId))].sort()) {
          const rows = toIssue.filter((h) => h.productId === productId),
            quantity = rows.reduce((n, h) => n + h.quantity, 0);
          const [product] = await tx.select().from(products).where(eq(products.id, productId));
          if (!product) throw new Error('Missing product');
          const movement = await applyWarehouseMovement(tx, {
            productId,
            eventType: 'outbound',
            onHandDelta: -quantity,
            reservedDelta: -quantity,
            sourceType: 'reshare_order',
            sourceId: re.id,
            actorUserId: userId,
            occurredAt: now,
            reason: `Xuất theo đơn ${re.code}`,
            metadata: { emergencyPriorityOrderId: id, storeId: store.id },
          });
          const [reLine] = await tx
            .insert(reshareOrderLines)
            .values({
              reshareOrderId: re.id,
              productId,
              productNameSnapshot: product.name,
              productSkuSnapshot: product.sku,
              quantity,
              issueLedgerEntryId: movement.ledgerEntryId,
            })
            .returning();
          if (!reLine) throw new Error('Missing RE line');
          await tx.insert(reshareOrderSources).values(
            rows.map((h) => ({
              reshareOrderId: re.id,
              reshareOrderLineId: reLine.id,
              reservationId: h.id,
              allocationLineId: h.allocationLineId,
              storeId: store.id,
              productId,
              quantity: h.quantity,
            })),
          );
        }
        await dispatchWarehouseOutboundInTransaction(tx, {
          outboundRequestId: outboundId,
          expectedVersion: 0,
          dispatcher: { kind: 'emergency', orderId: id, userId },
          dispatchedAt: now,
          requestId,
        });
        await tx.insert(auditLogs).values([
          {
            actorUserId: userId,
            actorRole: actor.role,
            actorStoreId: store.id,
            action: 'EMERGENCY_PRIORITY_ORDER_APPROVED',
            entityType: 'emergency_priority_order',
            entityId: id,
            requestId,
            after: {
              code: order.code,
              totalQuantity: total,
              reshareCode: re.code,
              sources: allHolds.map((h) => ({ id: h.id, quantity: h.quantity, kind: h.kind })),
              additionalLines: input.additionalLines,
            },
            metadata: { actorName: actor.displayName },
          },
          {
            actorUserId: userId,
            actorRole: actor.role,
            actorStoreId: store.id,
            action: 'RESHARE_ORDER_CREATED',
            entityType: 'reshare_order',
            entityId: re.id,
            requestId,
            after: { code: re.code, totalQuantity: re.totalQuantity, emergencyPriorityOrderId: id },
            metadata: { actorName: actor.displayName, trigger: 'emergency-priority-order' },
          },
        ]);
        const data = await readOrder(tx, id);
        if (!data) throw new Error('Missing submitted order');
        return {
          value: data,
          responseStatus: 201,
          responseBody: JSON.parse(JSON.stringify(data)),
          resourceType: 'emergency_priority_order',
          resourceId: id,
        };
      }),
    async (tx) => {
      await actorFor(tx, userId, true);
      await storeFor(tx, input.storeId);
    },
  );
  return {
    data: PriorityOrderSchema.parse(result.replayed ? result.responseBody : result.value),
    replayed: result.replayed,
  };
}

async function readOrders(tx: Reader, ids: string[]): Promise<PriorityOrder[]> {
  if (!ids.length) return [];
  const headers = await tx
    .select({ order: orders, outbound: outboundRequests, re: reshareOrders })
    .from(orders)
    .innerJoin(outboundRequests, eq(outboundRequests.id, orders.outboundRequestId))
    .innerJoin(reshareOrders, eq(reshareOrders.emergencyOrderId, orders.id))
    .where(inArray(orders.id, ids))
    .orderBy(desc(orders.approvedAt), desc(orders.id));
  const allSources = await tx
    .select({
      orderId: sources.orderId,
      reservation: reservations,
      kind: sources.kind,
      name: products.name,
      reshareCode: reshareOrders.code,
    })
    .from(sources)
    .innerJoin(reservations, eq(reservations.id, sources.reservationId))
    .innerJoin(products, eq(products.id, reservations.productId))
    .innerJoin(reshareOrderSources, eq(reshareOrderSources.reservationId, reservations.id))
    .innerJoin(reshareOrders, eq(reshareOrders.id, reshareOrderSources.reshareOrderId))
    .where(inArray(sources.orderId, ids))
    .orderBy(products.name, reservations.id);
  const rankedHistory = tx
    .select({
      id: auditLogs.id,
      orderId: auditLogs.entityId,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
      rank: sql<number>`row_number() over (partition by ${auditLogs.entityId} order by ${auditLogs.createdAt} desc, ${auditLogs.id} desc)`.as(
        'history_rank',
      ),
    })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.entityType, 'emergency_priority_order'), inArray(auditLogs.entityId, ids)),
    )
    .as('priority_history');
  const allHistory = await tx
    .select()
    .from(rankedHistory)
    .where(lte(rankedHistory.rank, 100))
    .orderBy(desc(rankedHistory.createdAt), desc(rankedHistory.id));
  return headers.map((row) => {
    const id = row.order.id;
    const sourceRows = allSources.filter((r) => r.orderId === id);
    const history = allHistory.filter((h) => h.orderId === id);
    const lines = new Map<
      string,
      { productId: string; name: string; held: number; additional: number; total: number }
    >();
    for (const r of sourceRows) {
      const line = lines.get(r.reservation.productId) ?? {
        productId: r.reservation.productId,
        name: r.name,
        held: 0,
        additional: 0,
        total: 0,
      };
      if (r.kind === 'held') line.held += r.reservation.quantity;
      else line.additional += r.reservation.quantity;
      line.total += r.reservation.quantity;
      lines.set(line.productId, line);
    }

    return PriorityOrderSchema.parse({
      id,
      code: row.order.code,
      type: 'EMERGENCY_PRIORITY_ORDER',
      storeId: row.order.storeId,
      storeName: row.order.storeName,
      actorName: row.order.actorName,
      approvedAt: row.order.approvedAt.toISOString(),
      status: row.outbound.status,
      version: row.order.version,
      totalQuantity: row.order.totalQuantity,
      outboundRequestId: row.outbound.id,
      reshareId: row.re.id,
      reshareCode: row.re.code,
      reshareQuantity: row.re.totalQuantity,
      reshareStatus: row.order.reshareStatus,
      notes: row.order.notes,
      lines: [...lines.values()],
      sources: sourceRows.map((r) => ({
        reservationId: r.reservation.id,
        productId: r.reservation.productId,
        quantity: r.reservation.quantity,
        kind: r.kind,
        reshareCode: r.reshareCode,
      })),
      history: history.map((h) => ({
        action: h.action,
        actorName:
          typeof h.metadata.actorName === 'string' ? h.metadata.actorName : row.order.actorName,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  });
}
async function readOrder(tx: Reader, id: string): Promise<PriorityOrder | null> {
  return (await readOrders(tx, [id]))[0] ?? null;
}
export async function getPriorityOrder(database: Database, userId: string, id: string) {
  return withTransaction(
    database,
    async (tx) => {
      const scope = await readerScope(tx, userId);
      const [header] = await tx
        .select({ storeId: orders.storeId })
        .from(orders)
        .where(eq(orders.id, id));
      if (!header || (scope && !scope.includes(header.storeId)))
        throw new PriorityOrderError('NOT_FOUND', 'Không tìm thấy đơn.');
      const data = await readOrder(tx, id);
      if (!data) throw new PriorityOrderError('NOT_FOUND', 'Không tìm thấy đơn.');
      return data;
    },
    { isolationLevel: 'repeatable read' },
  );
}
export async function listPriorityOrders(
  database: Database,
  userId: string,
  query: PriorityOrderQuery,
): Promise<PriorityOrderPage> {
  return withTransaction(
    database,
    async (tx) => {
      const scope = await readerScope(tx, userId, query.storeId);
      const where = scope ? inArray(orders.storeId, scope) : undefined;
      const [total] = await tx.select({ n: count() }).from(orders).where(where);
      const headers = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(where)
        .orderBy(desc(orders.approvedAt), desc(orders.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const data = await readOrders(
        tx,
        headers.map((h) => h.id),
      );
      const totalItems = total?.n ?? 0;
      return {
        data,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / query.pageSize),
        },
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
export async function updatePriorityReshareStatus(
  database: Database,
  userId: string,
  id: string,
  input: PriorityStatusInput,
  key: string,
) {
  const result = await withIdempotency(
    database,
    {
      scope: `emergency-reshare-status:${userId}:${id}`,
      key,
      requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    },
    async (tx) => {
      const actor = await actorFor(tx, userId, true);
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!order) throw new PriorityOrderError('NOT_FOUND', 'Không tìm thấy đơn.');
      if (order.version !== input.expectedVersion)
        throw new PriorityOrderError('CONFLICT', 'Trạng thái đã thay đổi, vui lòng tải lại.');
      if (input.status !== order.reshareStatus) {
        await tx
          .update(orders)
          .set({ reshareStatus: input.status, version: order.version + 1 })
          .where(eq(orders.id, id));
        await tx.insert(auditLogs).values({
          actorUserId: userId,
          actorRole: actor.role,
          actorStoreId: order.storeId,
          action: 'RESHARE_ORDER_STATUS_UPDATED',
          entityType: 'emergency_priority_order',
          entityId: id,
          before: { status: order.reshareStatus },
          after: { status: input.status },
          metadata: { actorName: actor.displayName },
        });
      }
      const data = await readOrder(tx, id);
      if (!data) throw new Error('Missing order');
      return {
        value: data,
        responseBody: JSON.parse(JSON.stringify(data)),
        responseStatus: 200,
        resourceType: 'emergency_priority_order',
        resourceId: id,
      };
    },
    async (tx) => {
      await actorFor(tx, userId, true);
    },
  );
  return {
    data: PriorityOrderSchema.parse(result.replayed ? result.responseBody : result.value),
    replayed: result.replayed,
  };
}

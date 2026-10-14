import { randomUUID } from 'node:crypto';

import {
  distributeSupplierCancellation,
  supplierOrderState,
  type SupplierOrderState,
} from '@idosi/domain';
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { SHIPPABLE_DECISION_STATUSES } from './allocation-decision-gate.js';
import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  auditLogs,
  dailyPriorityOffers,
  htkdAssignments,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  reservations,
  stores,
  supplierEventBatches,
  supplierExternalEvents,
  supplierOrderSourceLinks,
  supplierSourceProducts,
  users,
  type JsonObject,
} from './schema.js';
import {
  loadOrderedByCommitment,
  lockSupplierProducts,
  lockWarehouseBalances,
  projectSupplierAvailability,
} from './supplier-commitments.js';
import {
  actorMayAccessStore,
  loadReshareManager,
  SupplierReconciliationError,
  type SupplierActor,
} from './supplier-reconciliation.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';

const MAX_ORDER_LINES = 50;
const LATE_EVENT_REASON =
  'Có biến động Reshare ghi nhận muộn, xảy ra trước lần xem tồn gần nhất; cần đối chiếu lại.';

export interface SupplierBatchRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: (typeof supplierEventBatches.$inferSelect)['kind'];
  readonly externalRef: string;
  readonly storeId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdByDisplayName: string;
  readonly events: readonly SupplierEventRecord[];
}

export interface SupplierEventRecord {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly kind: (typeof supplierExternalEvents.$inferSelect)['kind'];
  readonly quantity: number;
  readonly externalRef: string;
  readonly externalLineRef: string;
  readonly coverage: (typeof supplierExternalEvents.$inferSelect)['coverage'];
  readonly reversesEventId: string | null;
  readonly links: readonly {
    readonly reservationId: string;
    readonly allocationLineId: string | null;
    readonly storeId: string;
    readonly quantity: number;
  }[];
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

interface CommandMeta {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
}

export interface RecordSupplierOrderInput extends CommandMeta {
  /** Optional: when omitted the source is the one the SKUs are mapped to (all must share it). */
  readonly sourceId?: string | null;
  /** B's order number. */
  readonly externalRef: string;
  /** When B accepted the order (its orderable stock dropped then). */
  readonly occurredAt: Date;
  readonly note?: string | null;
  /** One entry per A commitment; entries sharing externalLineRef form one B line (one SKU). */
  readonly lines: readonly {
    readonly reservationId: string;
    readonly quantity: number;
    readonly externalLineRef: string;
  }[];
}

/**
 * A Reshare manager (Admin or any active HTKD, every active store) records what B actually
 * accepted, linked to the A commitments it fulfils. B's orderable stock and U drop by the same q,
 * so free stock F does not move; reserved stock stays held until the receipt lifecycle consumes it.
 */
export async function recordSupplierOrder(
  database: Database,
  input: RecordSupplierOrderInput,
  now = new Date(),
): Promise<{ readonly batch: SupplierBatchRecord; readonly replayed: boolean }> {
  const externalRef = input.externalRef.trim();
  validateRef(externalRef, 'Mã đơn Reshare');
  validateOccurredAt(input.occurredAt, now);
  validateNote(input.note);
  if (input.lines.length === 0 || input.lines.length > MAX_ORDER_LINES) {
    throw new SupplierReconciliationError('VALIDATION', 'Đơn Reshare cần từ 1 đến 50 dòng.');
  }
  const reservationIds = input.lines.map((line) => line.reservationId);
  if (new Set(reservationIds).size !== reservationIds.length) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Mỗi lượng giữ hàng chỉ xuất hiện một lần trong đơn.',
    );
  }
  for (const line of input.lines) {
    validateRef(line.externalLineRef.trim(), 'Dòng đơn Reshare');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100_000) {
      throw new SupplierReconciliationError('VALIDATION', 'Số bao đặt phải là số nguyên dương.');
    }
  }

  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(
      tx,
      'supplier-batch-key',
      `${input.actorUserId}:${input.idempotencyKey}`,
      async () => {
        const actor = await loadReshareManager(tx, input.actorUserId);
        const replay = await findReplay(tx, actor, input);
        if (replay) return { batch: replay, replayed: true };

        const locked = await tx
          .select()
          .from(reservations)
          .where(inArray(reservations.id, [...reservationIds].sort()))
          .orderBy(asc(reservations.id))
          .for('update');
        const byId = new Map(locked.map((row) => [row.id, row]));
        const storeIds = new Set<string>();
        for (const id of reservationIds) {
          const row = byId.get(id);
          if (!row || row.status !== 'active' || row.deletedAt !== null) {
            throw new SupplierReconciliationError(
              'ORDER_SOURCE_NOT_ELIGIBLE',
              'Lượng giữ hàng không còn hiệu lực để đặt Reshare.',
              { reservationId: id },
            );
          }
          storeIds.add(row.storeId);
        }
        if (storeIds.size !== 1) {
          throw new SupplierReconciliationError(
            'VALIDATION',
            'Một đơn Reshare chỉ ghi cho một cửa hàng; tách đơn theo cửa hàng.',
          );
        }
        const storeId = [...storeIds][0]!;
        await assertStoreActionable(tx, actor, storeId);

        const productIds = [...new Set(locked.map((row) => row.productId))];
        const mappings = await tx
          .select()
          .from(supplierSourceProducts)
          .where(inArray(supplierSourceProducts.productId, productIds));
        const mappingByProduct = new Map(mappings.map((row) => [row.productId, row]));
        const sourceId = input.sourceId ?? mappings[0]?.sourceId;
        if (sourceId === undefined) {
          throw new SupplierReconciliationError(
            'SOURCE_NOT_RECONCILED',
            'Mặt hàng chưa thuộc nguồn Reshare nào.',
          );
        }
        for (const productId of productIds) {
          if (mappingByProduct.get(productId)?.sourceId !== sourceId) {
            throw new SupplierReconciliationError(
              'SOURCE_NOT_RECONCILED',
              'Mặt hàng chưa thuộc nguồn Reshare đang ghi nhận.',
              { productId },
            );
          }
        }

        // Only goods past the current acceptance gate may be ordered at B.
        const lineIds = locked.flatMap((row) =>
          row.allocationLineId ? [row.allocationLineId] : [],
        );
        const decisionRows =
          lineIds.length === 0
            ? []
            : await tx
                .select({ lineId: allocationLines.id, status: allocationResultDecisions.status })
                .from(allocationLines)
                .leftJoin(
                  allocationResultDecisions,
                  and(
                    eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
                    eq(allocationResultDecisions.storeId, allocationLines.storeId),
                  ),
                )
                .where(inArray(allocationLines.id, lineIds));
        const decisionByLine = new Map(decisionRows.map((row) => [row.lineId, row.status]));
        for (const row of locked) {
          const status = row.allocationLineId ? decisionByLine.get(row.allocationLineId) : null;
          if (
            !row.allocationLineId ||
            !status ||
            !(SHIPPABLE_DECISION_STATUSES as readonly string[]).includes(status)
          ) {
            throw new SupplierReconciliationError(
              'ORDER_SOURCE_NOT_ELIGIBLE',
              'Chỉ đặt Reshare cho kết quả phân bổ đã được cửa hàng chấp nhận (hoặc không cần xác nhận).',
              { reservationId: row.id, decisionStatus: status ?? null },
            );
          }
        }

        const ordered = await loadOrderedByCommitment(tx, locked);
        for (const line of input.lines) {
          const row = byId.get(line.reservationId)!;
          const key = row.allocationLineId ?? row.id;
          const already = ordered.get(key)?.ordered ?? 0;
          if (already + line.quantity > row.quantity) {
            throw new SupplierReconciliationError(
              'QUANTITY_EXCEEDED',
              `Chỉ còn ${Math.max(0, row.quantity - already)} bao chưa đặt Reshare cho lượng giữ này.`,
              { reservationId: row.id, remaining: Math.max(0, row.quantity - already) },
            );
          }
        }

        const groups = new Map<
          string,
          { productId: string; lines: (typeof input.lines)[number][] }
        >();
        for (const line of input.lines) {
          const ref = line.externalLineRef.trim();
          const productId = byId.get(line.reservationId)!.productId;
          const group = groups.get(ref) ?? { productId, lines: [] };
          if (group.productId !== productId) {
            throw new SupplierReconciliationError(
              'VALIDATION',
              'Một dòng đơn Reshare chỉ gồm một mặt hàng.',
            );
          }
          group.lines.push(line);
          groups.set(ref, group);
        }
        await assertNewIdentities(tx, sourceId, 'order', externalRef, [...groups.keys()]);

        await lockWarehouseBalances(tx, productIds);
        await lockSupplierProducts(tx, productIds);
        const batchId = randomUUID();
        await tx.insert(supplierEventBatches).values({
          id: batchId,
          sourceId,
          kind: 'order',
          externalRef,
          storeId,
          occurredAt: input.occurredAt,
          recordedAt: now,
          note: input.note?.trim() || null,
          createdByUserId: actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          requestId: input.requestId ?? null,
        });
        const lateProducts = new Set<string>();
        for (const [lineRef, group] of groups) {
          const coverage = await coverageForNewEvent(tx, group.productId, input.occurredAt);
          if (coverage === 'ambiguous') lateProducts.add(group.productId);
          const eventId = randomUUID();
          await tx.insert(supplierExternalEvents).values({
            id: eventId,
            batchId,
            sourceId,
            productId: group.productId,
            kind: 'order',
            quantity: group.lines.reduce((total, line) => total + line.quantity, 0),
            externalRef,
            externalLineRef: lineRef,
            storeId,
            occurredAt: input.occurredAt,
            recordedAt: now,
            coverage,
            createdByUserId: actor.id,
          });
          await tx.insert(supplierOrderSourceLinks).values(
            group.lines.map((line) => {
              const row = byId.get(line.reservationId)!;
              return {
                eventId,
                allocationLineId: row.allocationLineId,
                reservationId: row.id,
                storeId,
                productId: row.productId,
                quantity: line.quantity,
                createdAt: now,
              };
            }),
          );
        }
        await finishBatch(tx, {
          actor,
          batchId,
          productIds,
          lateProducts,
          action: 'SUPPLIER_ORDER_RECORDED',
          storeId,
          now,
          requestId: input.requestId ?? null,
          after: {
            externalRef,
            occurredAt: input.occurredAt.toISOString(),
            lines: input.lines.map((line) => ({ ...line })),
          },
        });
        return { batch: await loadBatch(tx, batchId), replayed: false };
      },
    ),
  );
}

export interface CancelSupplierOrderInput extends CommandMeta {
  /** The recorded B order line being cancelled. */
  readonly eventId: string;
  readonly quantity: number;
  /** B's cancellation reference. */
  readonly cancelRef: string;
  readonly occurredAt: Date;
  /** B confirmed the cancelled bags are orderable again (raises B's orderable stock). */
  readonly sourceReturned: boolean;
  readonly note?: string | null;
}

/**
 * B cancelled (part of) an order: the A commitment is owed again (U rises), so F falls unless
 * B also returned the bags to orderable stock. Never deletes the original order.
 */
export async function cancelSupplierOrder(
  database: Database,
  input: CancelSupplierOrderInput,
  now = new Date(),
): Promise<{ readonly batch: SupplierBatchRecord; readonly replayed: boolean }> {
  const cancelRef = input.cancelRef.trim();
  validateRef(cancelRef, 'Mã hủy Reshare');
  validateOccurredAt(input.occurredAt, now);
  validateNote(input.note);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new SupplierReconciliationError('VALIDATION', 'Số bao hủy phải là số nguyên dương.');
  }
  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(
      tx,
      'supplier-batch-key',
      `${input.actorUserId}:${input.idempotencyKey}`,
      async () => {
        const actor = await loadReshareManager(tx, input.actorUserId);
        const replay = await findReplay(tx, actor, input);
        if (replay) return { batch: replay, replayed: true };

        const [order] = await tx
          .select()
          .from(supplierExternalEvents)
          .where(eq(supplierExternalEvents.id, input.eventId))
          .limit(1);
        if (!order || order.kind !== 'order' || !order.storeId) {
          throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy dòng đơn Reshare.');
        }
        await assertStoreActionable(tx, actor, order.storeId);
        if (input.occurredAt.getTime() < order.occurredAt.getTime()) {
          throw new SupplierReconciliationError(
            'VALIDATION',
            'Thời điểm hủy không thể trước thời điểm Reshare nhận đơn.',
          );
        }
        const links = await tx
          .select()
          .from(supplierOrderSourceLinks)
          .where(eq(supplierOrderSourceLinks.eventId, order.id))
          .orderBy(asc(supplierOrderSourceLinks.createdAt), asc(supplierOrderSourceLinks.id));
        const previousCancels = await tx
          .select({ link: supplierOrderSourceLinks })
          .from(supplierOrderSourceLinks)
          .innerJoin(
            supplierExternalEvents,
            eq(supplierExternalEvents.id, supplierOrderSourceLinks.eventId),
          )
          .where(eq(supplierExternalEvents.reversesEventId, order.id));
        const cancelledByKey = new Map<string, number>();
        for (const { link } of previousCancels) {
          const key = link.allocationLineId ?? link.reservationId;
          cancelledByKey.set(key, (cancelledByKey.get(key) ?? 0) + link.quantity);
        }
        const keys = links.map((link) => link.allocationLineId ?? link.reservationId);
        // The commitment owed again is its current active hold; goods already received cannot be
        // "un-ordered" at B by this command.
        const activeRows = await tx
          .select()
          .from(reservations)
          .where(
            and(
              eq(reservations.status, 'active'),
              isNull(reservations.deletedAt),
              sql`coalesce(${reservations.allocationLineId}, ${reservations.id}) in (${sql.join(
                keys.map((key) => sql`${key}::uuid`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(asc(reservations.id))
          .for('update');
        const consumedRows = await tx
          .select({
            key: sql<string>`coalesce(${reservations.allocationLineId}, ${reservations.id})`,
          })
          .from(reservations)
          .where(
            and(
              eq(reservations.status, 'consumed'),
              sql`coalesce(${reservations.allocationLineId}, ${reservations.id}) in (${sql.join(
                keys.map((key) => sql`${key}::uuid`),
                sql`, `,
              )})`,
            ),
          );
        const consumed = new Set(consumedRows.map((row) => row.key));
        const activeByKey = new Map(activeRows.map((row) => [row.allocationLineId ?? row.id, row]));
        const cancellable = links
          .map((link) => {
            const key = link.allocationLineId ?? link.reservationId;
            return {
              key,
              link,
              netQuantity: consumed.has(key)
                ? 0
                : Math.max(0, link.quantity - (cancelledByKey.get(key) ?? 0)),
            };
          })
          .filter((entry) => entry.netQuantity > 0);
        const available = cancellable.reduce((total, entry) => total + entry.netQuantity, 0);
        if (input.quantity > available) {
          throw new SupplierReconciliationError(
            'QUANTITY_EXCEEDED',
            `Chỉ hủy được tối đa ${available} bao chưa giao của dòng đơn này.`,
            { available },
          );
        }
        const split = distributeSupplierCancellation(
          cancellable.map((entry) => ({ key: entry.key, netQuantity: entry.netQuantity })),
          input.quantity,
        );
        await assertNewIdentities(tx, order.sourceId, 'order_cancel', cancelRef, [
          order.externalLineRef,
        ]);
        if (input.sourceReturned) {
          await assertNewIdentities(tx, order.sourceId, 'source_return', cancelRef, [
            order.externalLineRef,
          ]);
        }

        await lockWarehouseBalances(tx, [order.productId]);
        await lockSupplierProducts(tx, [order.productId]);
        const batchId = randomUUID();
        await tx.insert(supplierEventBatches).values({
          id: batchId,
          sourceId: order.sourceId,
          kind: 'order_cancel',
          externalRef: cancelRef,
          storeId: order.storeId,
          occurredAt: input.occurredAt,
          recordedAt: now,
          note: input.note?.trim() || null,
          createdByUserId: actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          requestId: input.requestId ?? null,
        });
        const cancelId = randomUUID();
        await tx.insert(supplierExternalEvents).values({
          id: cancelId,
          batchId,
          sourceId: order.sourceId,
          productId: order.productId,
          kind: 'order_cancel',
          quantity: input.quantity,
          externalRef: cancelRef,
          externalLineRef: order.externalLineRef,
          storeId: order.storeId,
          occurredAt: input.occurredAt,
          recordedAt: now,
          coverage: 'not_applicable',
          reversesEventId: order.id,
          createdByUserId: actor.id,
        });
        const linkByKey = new Map(cancellable.map((entry) => [entry.key, entry.link]));
        await tx.insert(supplierOrderSourceLinks).values(
          split.map((part) => {
            const original = linkByKey.get(part.key)!;
            return {
              eventId: cancelId,
              allocationLineId: original.allocationLineId,
              reservationId: activeByKey.get(part.key)?.id ?? original.reservationId,
              storeId: original.storeId,
              productId: original.productId,
              quantity: part.quantity,
              createdAt: now,
            };
          }),
        );
        const lateProducts = new Set<string>();
        if (input.sourceReturned) {
          const coverage = await coverageForNewEvent(tx, order.productId, input.occurredAt);
          if (coverage === 'ambiguous') lateProducts.add(order.productId);
          await tx.insert(supplierExternalEvents).values({
            batchId,
            sourceId: order.sourceId,
            productId: order.productId,
            kind: 'source_return',
            quantity: input.quantity,
            externalRef: cancelRef,
            externalLineRef: order.externalLineRef,
            storeId: order.storeId,
            occurredAt: input.occurredAt,
            recordedAt: now,
            coverage,
            reversesEventId: order.id,
            createdByUserId: actor.id,
          });
        }
        await finishBatch(tx, {
          actor,
          batchId,
          productIds: [order.productId],
          lateProducts,
          action: 'SUPPLIER_ORDER_CANCELLED',
          storeId: order.storeId,
          now,
          requestId: input.requestId ?? null,
          after: {
            orderEventId: order.id,
            cancelRef,
            quantity: input.quantity,
            sourceReturned: input.sourceReturned,
            split: split.map((part) => ({ ...part })),
          },
        });
        return { batch: await loadBatch(tx, batchId), replayed: false };
      },
    ),
  );
}

export interface RecordSupplierSourceReturnInput extends CommandMeta {
  readonly sourceId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly externalRef: string;
  readonly occurredAt: Date;
  /** Evidence is mandatory: this is the only path that raises B without an observation. */
  readonly note: string;
}

/** Admin: B confirmed bags are orderable again (found shortage, return to B...). */
export async function recordSupplierSourceReturn(
  database: Database,
  input: RecordSupplierSourceReturnInput,
  now = new Date(),
): Promise<{ readonly batch: SupplierBatchRecord; readonly replayed: boolean }> {
  const externalRef = input.externalRef.trim();
  validateRef(externalRef, 'Mã chứng từ hoàn nguồn');
  validateOccurredAt(input.occurredAt, now);
  validateNote(input.note);
  if ((input.note?.trim().length ?? 0) < 3) {
    throw new SupplierReconciliationError('VALIDATION', 'Cần ghi căn cứ hoàn nguồn (≥ 3 ký tự).');
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100_000) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Số bao hoàn nguồn phải là số nguyên dương.',
    );
  }
  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(
      tx,
      'supplier-batch-key',
      `${input.actorUserId}:${input.idempotencyKey}`,
      async () => {
        const actor = await loadReshareManager(tx, input.actorUserId);
        const replay = await findReplay(tx, actor, input);
        if (replay) return { batch: replay, replayed: true };
        await lockWarehouseBalances(tx, [input.productId]);
        const [mapping] = await lockSupplierProducts(tx, [input.productId]);
        if (!mapping || mapping.sourceId !== input.sourceId) {
          throw new SupplierReconciliationError(
            'SOURCE_NOT_RECONCILED',
            'Mặt hàng chưa thuộc nguồn Reshare này.',
          );
        }
        await assertNewIdentities(tx, input.sourceId, 'source_return', externalRef, [
          input.productId,
        ]);
        const batchId = randomUUID();
        await tx.insert(supplierEventBatches).values({
          id: batchId,
          sourceId: input.sourceId,
          kind: 'source_return',
          externalRef,
          storeId: null,
          occurredAt: input.occurredAt,
          recordedAt: now,
          note: input.note.trim(),
          createdByUserId: actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          requestId: input.requestId ?? null,
        });
        const coverage = await coverageForNewEvent(tx, input.productId, input.occurredAt);
        await tx.insert(supplierExternalEvents).values({
          batchId,
          sourceId: input.sourceId,
          productId: input.productId,
          kind: 'source_return',
          quantity: input.quantity,
          externalRef,
          externalLineRef: input.productId,
          storeId: null,
          occurredAt: input.occurredAt,
          recordedAt: now,
          coverage,
          createdByUserId: actor.id,
        });
        await finishBatch(tx, {
          actor,
          batchId,
          productIds: [input.productId],
          lateProducts: coverage === 'ambiguous' ? new Set([input.productId]) : new Set(),
          action: 'SUPPLIER_SOURCE_RETURN_RECORDED',
          storeId: null,
          now,
          requestId: input.requestId ?? null,
          after: { productId: input.productId, quantity: input.quantity, externalRef },
        });
        return { batch: await loadBatch(tx, batchId), replayed: false };
      },
    ),
  );
}

async function finishBatch(
  tx: Transaction,
  input: {
    readonly actor: SupplierActor;
    readonly batchId: string;
    readonly productIds: readonly string[];
    readonly lateProducts: ReadonlySet<string>;
    readonly action: string;
    readonly storeId: string | null;
    readonly now: Date;
    readonly requestId: string | null;
    readonly after: JsonObject;
  },
): Promise<void> {
  for (const productId of [...input.productIds].sort()) {
    const late = input.lateProducts.has(productId);
    await tx
      .update(supplierSourceProducts)
      .set({
        revision: sql`${supplierSourceProducts.revision} + 1`,
        ...(late
          ? {
              status: sql`case when ${supplierSourceProducts.status} = 'active' then 'needs_reconciliation'::supplier_source_product_status else ${supplierSourceProducts.status} end`,
              blockReason: sql`case when ${supplierSourceProducts.status} = 'active' then ${LATE_EVENT_REASON} else ${supplierSourceProducts.blockReason} end`,
              blockedAt: sql`case when ${supplierSourceProducts.status} = 'active' then now() else ${supplierSourceProducts.blockedAt} end`,
            }
          : {}),
        updatedAt: input.now,
      })
      .where(eq(supplierSourceProducts.productId, productId));
  }
  const projection = await projectSupplierAvailability(tx, {
    productIds: input.productIds,
    sourceType: 'supplier_event_batch',
    sourceId: input.batchId,
    actorUserId: input.actor.id,
    reason: 'Ghi nhận biến động Reshare: cập nhật khả dụng theo đối chiếu',
    occurredAt: input.now,
    metadata: { batchId: input.batchId },
  });
  await tx.insert(auditLogs).values({
    requestId: input.requestId,
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    actorStoreId: input.storeId,
    action: input.action,
    entityType: 'supplier_event_batch',
    entityId: input.batchId,
    metadata: { actorName: input.actor.displayName },
    after: {
      ...input.after,
      projection: [...projection.values()].map((result) => ({
        productId: result.productId,
        onHandBefore: result.onHandBefore,
        onHandAfter: result.onHandAfter,
        reserved: result.reservedBefore,
        free: result.position.freeQuantity,
        shortfall: result.position.shortfallQuantity,
        state: result.position.state,
      })),
      lateProducts: [...input.lateProducts],
    },
  });
}

/** A late event dated at or before the current baseline cannot be placed without C. */
async function coverageForNewEvent(
  tx: Transaction,
  productId: string,
  occurredAt: Date,
): Promise<'open' | 'ambiguous'> {
  const [row] = await tx
    .execute<{ observed_at: Date | string | null }>(
      sql`
    select o.observed_at
    from supplier_source_products m
    left join supplier_stock_observation_lines l on l.id = m.baseline_observation_line_id
    left join supplier_stock_observations o on o.id = l.observation_id
    where m.product_id = ${productId}
  `,
    )
    .then((result) => result.rows);
  if (!row?.observed_at) return 'open';
  return occurredAt.getTime() <= new Date(row.observed_at).getTime() ? 'ambiguous' : 'open';
}

async function assertNewIdentities(
  tx: Transaction,
  sourceId: string,
  kind: (typeof supplierExternalEvents.$inferSelect)['kind'],
  externalRef: string,
  lineRefs: readonly string[],
): Promise<void> {
  const existing = await tx
    .select({ lineRef: supplierExternalEvents.externalLineRef })
    .from(supplierExternalEvents)
    .where(
      and(
        eq(supplierExternalEvents.sourceId, sourceId),
        eq(supplierExternalEvents.kind, kind),
        eq(supplierExternalEvents.externalRef, externalRef),
        inArray(supplierExternalEvents.externalLineRef, [...lineRefs]),
      ),
    );
  if (existing.length > 0) {
    throw new SupplierReconciliationError(
      'DUPLICATE_EXTERNAL_EVENT',
      `Chứng từ Reshare ${externalRef} (dòng ${existing.map((row) => row.lineRef).join(', ')}) đã được ghi nhận.`,
    );
  }
}

async function assertStoreActionable(
  tx: Transaction,
  actor: SupplierActor,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!store || !actorMayAccessStore(actor, storeId)) {
    throw new SupplierReconciliationError(
      'FORBIDDEN',
      'Cửa hàng không thuộc phạm vi đang hoạt động của tài khoản.',
    );
  }
}

async function findReplay(
  tx: Transaction,
  actor: SupplierActor,
  input: CommandMeta,
): Promise<SupplierBatchRecord | null> {
  const [previous] = await tx
    .select()
    .from(supplierEventBatches)
    .where(
      and(
        eq(supplierEventBatches.createdByUserId, actor.id),
        eq(supplierEventBatches.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!previous) return null;
  if (previous.requestHash !== input.requestHash) {
    throw new SupplierReconciliationError(
      'IDEMPOTENCY_CONFLICT',
      'Khóa thao tác đã dùng cho một ghi nhận Reshare khác.',
    );
  }
  // A replay re-checks the actor (re-read above: locked or demoted accounts are refused) and its
  // scope; Reshare managers cover every store, so only the role and status can revoke it.
  if (previous.storeId !== null && !actorMayAccessStore(actor, previous.storeId)) {
    throw new SupplierReconciliationError(
      'FORBIDDEN',
      'Cửa hàng không còn thuộc phạm vi của tài khoản.',
    );
  }
  return loadBatch(tx, previous.id);
}

async function loadBatch(
  tx: Transaction | Database,
  batchId: string,
): Promise<SupplierBatchRecord> {
  const [row] = await tx
    .select({ batch: supplierEventBatches, displayName: users.displayName })
    .from(supplierEventBatches)
    .innerJoin(users, eq(users.id, supplierEventBatches.createdByUserId))
    .where(eq(supplierEventBatches.id, batchId))
    .limit(1);
  if (!row) throw new SupplierReconciliationError('NOT_FOUND', 'Không tìm thấy ghi nhận Reshare.');
  const events = await loadEvents(tx, [batchId]);
  return {
    ...row.batch,
    createdByDisplayName: row.displayName,
    events: events.get(batchId) ?? [],
  };
}

async function loadEvents(
  tx: Transaction | Database,
  batchIds: readonly string[],
): Promise<Map<string, SupplierEventRecord[]>> {
  if (batchIds.length === 0) return new Map();
  const events = await tx
    .select({ event: supplierExternalEvents, sku: products.sku, name: products.name })
    .from(supplierExternalEvents)
    .innerJoin(products, eq(products.id, supplierExternalEvents.productId))
    .where(inArray(supplierExternalEvents.batchId, [...batchIds]))
    .orderBy(asc(supplierExternalEvents.externalLineRef), asc(supplierExternalEvents.id));
  const links =
    events.length === 0
      ? []
      : await tx
          .select()
          .from(supplierOrderSourceLinks)
          .where(
            inArray(
              supplierOrderSourceLinks.eventId,
              events.map(({ event }) => event.id),
            ),
          )
          .orderBy(asc(supplierOrderSourceLinks.createdAt), asc(supplierOrderSourceLinks.id));
  const linksByEvent = new Map<string, SupplierEventRecord['links'][number][]>();
  for (const link of links) {
    const group = linksByEvent.get(link.eventId) ?? [];
    group.push({
      reservationId: link.reservationId,
      allocationLineId: link.allocationLineId,
      storeId: link.storeId,
      quantity: link.quantity,
    });
    linksByEvent.set(link.eventId, group);
  }
  const result = new Map<string, SupplierEventRecord[]>();
  for (const { event, sku, name } of events) {
    const group = result.get(event.batchId) ?? [];
    group.push({
      id: event.id,
      productId: event.productId,
      sku,
      productName: name,
      kind: event.kind,
      quantity: event.quantity,
      externalRef: event.externalRef,
      externalLineRef: event.externalLineRef,
      coverage: event.coverage,
      reversesEventId: event.reversesEventId,
      links: linksByEvent.get(event.id) ?? [],
    });
    result.set(event.batchId, group);
  }
  return result;
}

function validateRef(value: string, label: string): void {
  if (value.length < 1 || value.length > 100) {
    throw new SupplierReconciliationError('VALIDATION', `${label} cần 1–100 ký tự.`);
  }
}

function validateOccurredAt(value: Date, now: Date): void {
  if (Number.isNaN(value.getTime()) || value.getTime() > now.getTime() + 5 * 60_000) {
    throw new SupplierReconciliationError(
      'VALIDATION',
      'Thời điểm Reshare ghi nhận không hợp lệ hoặc ở tương lai.',
    );
  }
}

function validateNote(value: string | null | undefined): void {
  if ((value?.length ?? 0) > 500) {
    throw new SupplierReconciliationError('VALIDATION', 'Ghi chú tối đa 500 ký tự.');
  }
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

export const SUPPLIER_COMMITMENT_FILTERS = ['ALL', 'ORDERABLE', 'UNORDERED', 'ORDERED'] as const;
export type SupplierCommitmentFilter = (typeof SUPPLIER_COMMITMENT_FILTERS)[number];

export interface SupplierCommitmentRow {
  readonly kind: 'OFFER_HOLD' | 'RESERVATION';
  readonly id: string;
  readonly commitmentKey: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly orderSessionId: string | null;
  readonly orderSessionCode: string | null;
  readonly businessDate: string | null;
  readonly allocationRunId: string | null;
  readonly allocationLineId: string | null;
  readonly priorityLevel: string | null;
  readonly decisionStatus: string | null;
  readonly outboundRequestNumber: string | null;
  readonly outboundStatus: string | null;
  readonly quantity: number;
  readonly orderedQuantity: number;
  readonly cancelledQuantity: number;
  readonly unorderedQuantity: number;
  readonly orderState: SupplierOrderState;
  readonly orderable: boolean;
  readonly notOrderableReason:
    'PRIORITY_OFFER' | 'DECISION_PENDING' | 'NO_BASELINE_SOURCE' | 'FULLY_ORDERED' | null;
  readonly heldSince: Date;
  readonly deadlineAt: Date | null;
  readonly htkdNames: readonly string[];
}

export interface SupplierCommitmentPage {
  readonly data: SupplierCommitmentRow[];
  readonly totalItems: number;
  readonly totals: {
    readonly quantity: number;
    readonly orderedQuantity: number;
    readonly unorderedQuantity: number;
  };
}

/**
 * Live commitments (priority holds and active reservations) of reconciled SKUs with their B
 * state. Paged in SQL over one ordered union; totals cover the whole filtered set, never just
 * the page. `storeIds` scopes HTKD/store readers; omitted means every store (Admin).
 */
export async function listSupplierCommitments(
  database: Database,
  input: {
    readonly productId?: string;
    readonly sourceId?: string;
    readonly storeId?: string;
    readonly storeIds?: readonly string[];
    readonly filter: SupplierCommitmentFilter;
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<SupplierCommitmentPage> {
  if (input.storeIds !== undefined && input.storeIds.length === 0) {
    return {
      data: [],
      totalItems: 0,
      totals: { quantity: 0, orderedQuantity: 0, unorderedQuantity: 0 },
    };
  }
  const shippable = sql.join(
    SHIPPABLE_DECISION_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const scope: SQL[] = [sql`true`];
  if (input.productId) scope.push(sql`c.product_id = ${input.productId}::uuid`);
  if (input.sourceId) scope.push(sql`m.source_id = ${input.sourceId}::uuid`);
  if (input.storeId) scope.push(sql`c.store_id = ${input.storeId}::uuid`);
  if (input.storeIds) {
    scope.push(
      sql`c.store_id in (${sql.join(
        input.storeIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  switch (input.filter) {
    case 'ORDERABLE':
      scope.push(
        sql`c.kind = 'RESERVATION' and m.status <> 'pending_baseline' and c.quantity - c.ordered > 0 and c.decision_status in (${shippable})`,
      );
      break;
    case 'UNORDERED':
      scope.push(sql`c.quantity - c.ordered > 0`);
      break;
    case 'ORDERED':
      scope.push(sql`c.ordered > 0`);
      break;
    default:
      break;
  }
  const where = sql.join(scope, sql` and `);
  const result = await database.execute<{
    kind: 'OFFER_HOLD' | 'RESERVATION';
    id: string;
    commitment_key: string;
    product_id: string;
    store_id: string;
    quantity: number;
    ordered: number;
    cancelled: number;
    order_session_id: string | null;
    allocation_run_id: string | null;
    allocation_line_id: string | null;
    priority_level: string | null;
    decision_status: string | null;
    outbound_request_line_id: string | null;
    held_since: string | Date;
    deadline_at: string | Date | null;
    mapping_status: string;
    total_items: string;
    total_quantity: string;
    total_ordered: string;
  }>(sql`
    with ordered as (
      select coalesce(l.allocation_line_id, l.reservation_id) as key,
        coalesce(sum(l.quantity) filter (where e.kind = 'order'), 0)
          - coalesce(sum(l.quantity) filter (where e.kind = 'order_cancel'), 0) as ordered,
        coalesce(sum(l.quantity) filter (where e.kind = 'order_cancel'), 0) as cancelled
      from ${supplierOrderSourceLinks} l
      join ${supplierExternalEvents} e on e.id = l.event_id
      where l.allocation_line_id in (
          select r.allocation_line_id from ${reservations} r
          where r.status = 'active' and r.deleted_at is null and r.allocation_line_id is not null
        )
        or (l.allocation_line_id is null and l.reservation_id in (
          select r.id from ${reservations} r where r.status = 'active' and r.deleted_at is null
        ))
      group by 1
    ), commitments as (
      select 'RESERVATION'::text as kind, r.id, coalesce(r.allocation_line_id, r.id) as commitment_key,
        r.product_id, r.store_id, r.quantity, ar.order_session_id, al.allocation_run_id,
        r.allocation_line_id, al.priority_level::text as priority_level,
        d.status::text as decision_status, r.outbound_request_line_id,
        r.created_at as held_since, null::timestamptz as deadline_at
      from ${reservations} r
      left join ${allocationLines} al on al.id = r.allocation_line_id
      left join ${allocationRuns} ar on ar.id = al.allocation_run_id
      left join ${allocationResultDecisions} d
        on d.allocation_run_id = al.allocation_run_id and d.store_id = r.store_id
      where r.status = 'active' and r.deleted_at is null
      union all
      select 'OFFER_HOLD'::text, o.id, o.id, o.product_id, o.store_id, o.stock_held_quantity,
        o.order_session_id, null, null, o.priority_level::text, null, null,
        o.created_at, o.response_deadline_at
      from ${dailyPriorityOffers} o
      where o.stock_held_quantity > 0 and o.deleted_at is null
    ), scoped as (
      select x.*, least(x.quantity, greatest(0, coalesce(od.ordered, 0)))::int as ordered,
        coalesce(od.cancelled, 0)::int as cancelled
      from commitments x
      left join ordered od on od.key = x.commitment_key and x.kind = 'RESERVATION'
    )
    select c.kind, c.id, c.commitment_key, c.product_id, c.store_id, c.quantity, c.ordered,
      c.cancelled, c.order_session_id, c.allocation_run_id, c.allocation_line_id,
      c.priority_level, c.decision_status, c.outbound_request_line_id, c.held_since,
      c.deadline_at, m.status::text as mapping_status,
      count(*) over () as total_items,
      sum(c.quantity) over () as total_quantity,
      sum(c.ordered) over () as total_ordered
    from scoped c
    join ${supplierSourceProducts} m on m.product_id = c.product_id
    where ${where}
    order by c.held_since asc, c.id asc
    limit ${input.pageSize} offset ${(input.page - 1) * input.pageSize}
  `);
  const rows = result.rows;
  const totalItems = Number(rows[0]?.total_items ?? 0);
  const totalsQuantity = Number(rows[0]?.total_quantity ?? 0);
  const totalsOrdered = Number(rows[0]?.total_ordered ?? 0);
  if (rows.length === 0 && input.page > 1) {
    // Totals of an out-of-range page still describe the filtered set.
    const first = await listSupplierCommitments(database, { ...input, page: 1, pageSize: 1 });
    return { data: [], totalItems: first.totalItems, totals: first.totals };
  }

  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const storeIds = [...new Set(rows.map((row) => row.store_id))];
  const sessionIds = [
    ...new Set(rows.flatMap((row) => (row.order_session_id ? [row.order_session_id] : []))),
  ];
  const outboundLineIds = [
    ...new Set(
      rows.flatMap((row) => (row.outbound_request_line_id ? [row.outbound_request_line_id] : [])),
    ),
  ];
  const [productRows, storeRows, sessionRows, outboundRows, htkdRows] = await Promise.all([
    productIds.length === 0
      ? []
      : database
          .select({ id: products.id, sku: products.sku, name: products.name })
          .from(products)
          .where(inArray(products.id, productIds)),
    storeIds.length === 0
      ? []
      : database
          .select({ id: stores.id, code: stores.code, name: stores.name })
          .from(stores)
          .where(inArray(stores.id, storeIds)),
    sessionIds.length === 0
      ? []
      : database
          .select({
            id: orderSessions.id,
            code: orderSessions.code,
            businessDate: orderSessions.businessDate,
          })
          .from(orderSessions)
          .where(inArray(orderSessions.id, sessionIds)),
    outboundLineIds.length === 0
      ? []
      : database
          .select({
            lineId: outboundRequestLines.id,
            requestNumber: outboundRequests.requestNumber,
            status: outboundRequests.status,
          })
          .from(outboundRequestLines)
          .innerJoin(
            outboundRequests,
            eq(outboundRequests.id, outboundRequestLines.outboundRequestId),
          )
          .where(inArray(outboundRequestLines.id, outboundLineIds)),
    storeIds.length === 0
      ? []
      : database
          .select({ storeId: htkdAssignments.storeId, name: users.displayName })
          .from(htkdAssignments)
          .innerJoin(users, eq(users.id, htkdAssignments.userId))
          .where(
            and(
              inArray(htkdAssignments.storeId, storeIds),
              isNull(htkdAssignments.revokedAt),
              eq(users.status, 'active'),
              isNull(users.deletedAt),
            ),
          )
          .orderBy(asc(users.displayName)),
  ]);
  const productById = new Map(productRows.map((row) => [row.id, row]));
  const storeById = new Map(storeRows.map((row) => [row.id, row]));
  const sessionById = new Map(sessionRows.map((row) => [row.id, row]));
  const outboundByLine = new Map(outboundRows.map((row) => [row.lineId, row]));
  const htkdByStore = new Map<string, string[]>();
  for (const row of htkdRows) {
    const group = htkdByStore.get(row.storeId) ?? [];
    group.push(row.name);
    htkdByStore.set(row.storeId, group);
  }

  return {
    data: rows.map((row): SupplierCommitmentRow => {
      const quantity = Number(row.quantity);
      const ordered = Number(row.ordered);
      const cancelled = Number(row.cancelled);
      const baselineKnown = row.mapping_status !== 'pending_baseline';
      const decisionShippable =
        row.decision_status !== null &&
        (SHIPPABLE_DECISION_STATUSES as readonly string[]).includes(row.decision_status);
      const notOrderableReason: SupplierCommitmentRow['notOrderableReason'] =
        row.kind === 'OFFER_HOLD'
          ? 'PRIORITY_OFFER'
          : ordered >= quantity
            ? 'FULLY_ORDERED'
            : !decisionShippable
              ? 'DECISION_PENDING'
              : !baselineKnown
                ? 'NO_BASELINE_SOURCE'
                : null;
      const session = row.order_session_id ? sessionById.get(row.order_session_id) : undefined;
      const outbound = row.outbound_request_line_id
        ? outboundByLine.get(row.outbound_request_line_id)
        : undefined;
      return {
        kind: row.kind,
        id: row.id,
        commitmentKey: row.commitment_key,
        productId: row.product_id,
        sku: productById.get(row.product_id)?.sku ?? '',
        productName: productById.get(row.product_id)?.name ?? '',
        storeId: row.store_id,
        storeCode: storeById.get(row.store_id)?.code ?? '',
        storeName: storeById.get(row.store_id)?.name ?? '',
        orderSessionId: row.order_session_id,
        orderSessionCode: session?.code ?? null,
        businessDate: session?.businessDate ?? null,
        allocationRunId: row.allocation_run_id,
        allocationLineId: row.allocation_line_id,
        priorityLevel: row.priority_level,
        decisionStatus: row.decision_status,
        outboundRequestNumber: outbound?.requestNumber ?? null,
        outboundStatus: outbound?.status ?? null,
        quantity,
        orderedQuantity: ordered,
        cancelledQuantity: cancelled,
        unorderedQuantity: quantity - ordered,
        orderState:
          row.kind === 'OFFER_HOLD'
            ? 'NOT_ORDERED'
            : supplierOrderState({
                baselineKnown,
                active: true,
                quantity,
                orderedQuantity: ordered,
                cancelledQuantity: cancelled,
              }),
        orderable: notOrderableReason === null,
        notOrderableReason,
        heldSince: new Date(row.held_since),
        deadlineAt: row.deadline_at ? new Date(row.deadline_at) : null,
        htkdNames: htkdByStore.get(row.store_id) ?? [],
      };
    }),
    totalItems,
    totals: {
      quantity: totalsQuantity,
      orderedQuantity: totalsOrdered,
      unorderedQuantity: totalsQuantity - totalsOrdered,
    },
  };
}

/** Recorded B commands, newest first; `storeIds` scopes HTKD and store readers. */
export async function listSupplierBatches(
  database: Database,
  input: {
    readonly sourceId?: string;
    readonly productId?: string;
    readonly storeId?: string;
    readonly storeIds?: readonly string[];
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<{ readonly data: SupplierBatchRecord[]; readonly totalItems: number }> {
  if (input.storeIds !== undefined && input.storeIds.length === 0)
    return { data: [], totalItems: 0 };
  const conditions: SQL[] = [];
  if (input.sourceId) conditions.push(eq(supplierEventBatches.sourceId, input.sourceId));
  if (input.storeId) conditions.push(eq(supplierEventBatches.storeId, input.storeId));
  if (input.storeIds) conditions.push(inArray(supplierEventBatches.storeId, [...input.storeIds]));
  if (input.productId) {
    conditions.push(
      sql`exists (select 1 from ${supplierExternalEvents} e where e.batch_id = ${supplierEventBatches.id} and e.product_id = ${input.productId}::uuid)`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totals] = await Promise.all([
    database
      .select({ batch: supplierEventBatches, displayName: users.displayName })
      .from(supplierEventBatches)
      .innerJoin(users, eq(users.id, supplierEventBatches.createdByUserId))
      .where(where)
      .orderBy(desc(supplierEventBatches.recordedAt), desc(supplierEventBatches.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    database.select({ value: count() }).from(supplierEventBatches).where(where),
  ]);
  const events = await loadEvents(
    database,
    rows.map((row) => row.batch.id),
  );
  return {
    data: rows.map((row) => ({
      ...row.batch,
      createdByDisplayName: row.displayName,
      events: events.get(row.batch.id) ?? [],
    })),
    totalItems: totals[0]?.value ?? 0,
  };
}

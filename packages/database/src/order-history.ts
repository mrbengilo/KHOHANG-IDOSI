import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  type SQL,
} from 'drizzle-orm';

import type { Database } from './client.js';
import {
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  stores,
  users,
} from './schema.js';

export type OrderHistoryStatusFilter = 'submitted' | 'merged' | 'cancelled';

export interface ListOrderHistoryInput {
  readonly page: number;
  readonly pageSize: number;
  /** undefined = every store (Admin); an empty list = no store in scope. */
  readonly storeIds?: readonly string[];
  readonly sessionId?: string;
  readonly status?: OrderHistoryStatusFilter;
  readonly productId?: string;
  readonly code?: string;
  /** Inclusive lower and exclusive upper submission instants. */
  readonly submittedFrom?: Date;
  readonly submittedBefore?: Date;
}

/**
 * Original order requests, one page of request headers at a time, newest first. Every line of a
 * selected request is returned so a multi-line request is never cut at a page boundary, and the
 * product filter selects requests without hiding their other lines. Requested quantities are the
 * ones submitted; merging or allocation never rewrites them. Count and page share one snapshot.
 */
export async function listOrderHistory(database: Database, input: ListOrderHistoryInput) {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100 ||
    !Number.isSafeInteger((input.page - 1) * input.pageSize)
  ) {
    throw new RangeError('Invalid order history pagination');
  }
  const emptyPage = (totalItems: number) => ({
    data: [],
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / input.pageSize),
    },
  });
  if (input.storeIds?.length === 0) return emptyPage(0);

  return database.transaction(
    async (tx) => {
      // A draft was never sent, so it has no submission time and is not history.
      const predicates: SQL[] = [
        isNotNull(orderRequests.submittedAt),
        isNull(orderRequests.deletedAt),
      ];
      if (input.storeIds) predicates.push(inArray(orderRequests.storeId, [...input.storeIds]));
      if (input.sessionId) predicates.push(eq(orderRequests.orderSessionId, input.sessionId));
      if (input.status === 'submitted') {
        predicates.push(inArray(orderRequests.status, ['draft', 'submitted']));
      } else if (input.status === 'merged') {
        predicates.push(
          inArray(orderRequests.status, [
            'merged',
            'partially_allocated',
            'allocated',
            'waitlisted',
          ]),
        );
      } else if (input.status === 'cancelled') {
        predicates.push(eq(orderRequests.status, 'cancelled'));
      }
      if (input.code) predicates.push(ilike(orderRequests.code, `%${escapeLike(input.code)}%`));
      if (input.submittedFrom) predicates.push(gte(orderRequests.submittedAt, input.submittedFrom));
      if (input.submittedBefore) {
        predicates.push(lt(orderRequests.submittedAt, input.submittedBefore));
      }
      if (input.productId) {
        predicates.push(
          exists(
            tx
              .select({ id: orderRequestItems.id })
              .from(orderRequestItems)
              .where(
                and(
                  eq(orderRequestItems.orderRequestId, orderRequests.id),
                  eq(orderRequestItems.productId, input.productId),
                ),
              ),
          ),
        );
      }
      const where = and(...predicates);
      const [total] = await tx.select({ value: count() }).from(orderRequests).where(where);
      const totalItems = total?.value ?? 0;
      const headers = await tx
        .select({
          id: orderRequests.id,
          code: orderRequests.code,
          requestNumber: orderRequests.requestNumber,
          status: orderRequests.status,
          storeId: orderRequests.storeId,
          storeCode: stores.code,
          storeName: stores.name,
          submittedAt: orderRequests.submittedAt,
          cancelledAt: orderRequests.cancelledAt,
          cancellationReason: orderRequests.cancellationReason,
          requestedByUserId: orderRequests.requestedByUserId,
          requestedByDisplayName: users.displayName,
          session: {
            id: orderSessions.id,
            code: orderSessions.code,
            kind: orderSessions.kind,
            businessDate: orderSessions.businessDate,
            status: orderSessions.status,
            openedAt: orderSessions.openedAt,
            createdAt: orderSessions.createdAt,
            requestClosesAt: orderSessions.inventorySnapshotDueAt,
            allocationStartsAt: orderSessions.requestDeadlineAt,
            completedAt: orderSessions.completedAt,
          },
        })
        .from(orderRequests)
        .innerJoin(stores, eq(stores.id, orderRequests.storeId))
        .innerJoin(orderSessions, eq(orderSessions.id, orderRequests.orderSessionId))
        .leftJoin(users, eq(users.id, orderRequests.requestedByUserId))
        .where(where)
        .orderBy(desc(orderRequests.submittedAt), desc(orderRequests.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      if (headers.length === 0) return emptyPage(totalItems);

      const requestIds = headers.map((header) => header.id);
      const lines = await tx
        .select({
          id: orderRequestItems.id,
          orderRequestId: orderRequestItems.orderRequestId,
          productId: orderRequestItems.productId,
          sku: products.sku,
          productName: products.name,
          unit: products.unit,
          displayOrder: products.displayOrder,
          requestedQuantity: orderRequestItems.requestedQuantity,
        })
        .from(orderRequestItems)
        .innerJoin(products, eq(products.id, orderRequestItems.productId))
        .where(inArray(orderRequestItems.orderRequestId, requestIds))
        .orderBy(asc(products.displayOrder), asc(products.sku), asc(orderRequestItems.id));
      // The merged document of a request is the one of its own session and store; the sources
      // table is immutable, so this link never changes after the allocation run.
      const merged = await tx
        .selectDistinct({
          orderRequestId: orderRequestItems.orderRequestId,
          mergedOrderId: mergedOrders.id,
          sessionId: mergedOrders.orderSessionId,
          storeId: mergedOrders.storeId,
          version: mergedOrders.version,
        })
        .from(mergedOrderSources)
        .innerJoin(
          orderRequestItems,
          eq(orderRequestItems.id, mergedOrderSources.orderRequestItemId),
        )
        .innerJoin(mergedOrderItems, eq(mergedOrderItems.id, mergedOrderSources.mergedOrderItemId))
        .innerJoin(mergedOrders, eq(mergedOrders.id, mergedOrderItems.mergedOrderId))
        .where(inArray(orderRequestItems.orderRequestId, requestIds))
        .orderBy(asc(orderRequestItems.orderRequestId), desc(mergedOrders.version));

      const linesByRequest = new Map<string, (typeof lines)[number][]>();
      for (const line of lines) {
        const group = linesByRequest.get(line.orderRequestId) ?? [];
        group.push(line);
        linesByRequest.set(line.orderRequestId, group);
      }
      const mergedByRequest = new Map<string, (typeof merged)[number]>();
      for (const document of merged) {
        if (!mergedByRequest.has(document.orderRequestId)) {
          mergedByRequest.set(document.orderRequestId, document);
        }
      }
      return {
        data: headers.map((header) => ({
          ...header,
          lines: (linesByRequest.get(header.id) ?? []).map((line) => ({
            ...line,
            matchesFilter: input.productId === undefined || line.productId === input.productId,
          })),
          mergedDocument: mergedByRequest.get(header.id) ?? null,
        })),
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / input.pageSize),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export type OrderHistoryPage = Awaited<ReturnType<typeof listOrderHistory>>;
export type OrderHistoryRecord = OrderHistoryPage['data'][number];

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

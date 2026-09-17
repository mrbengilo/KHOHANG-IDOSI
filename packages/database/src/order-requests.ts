import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  htkdAssignments,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  stores,
  users,
  waitTickets,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

export interface CreateOrderRequestItemInput {
  readonly productId: string;
  readonly quantity: number;
  readonly notes?: string | null;
}

export interface CreateOrderRequestInput {
  readonly orderSessionId: string;
  readonly storeId: string;
  readonly requestedByUserId: string;
  readonly notes?: string | null;
  readonly items: readonly CreateOrderRequestItemInput[];
}

export interface SubmitOrderRequestInput extends CreateOrderRequestInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly onCreated?: (tx: Transaction, request: CreatedOrderRequest) => Promise<void>;
}

export interface CreatedOrderRequest {
  readonly id: string;
  readonly requestNumber: number;
  readonly submittedAt: Date;
}

export class RequestLimitExceededError extends Error {
  public readonly code = 'ORDER_REQUEST_LIMIT_EXCEEDED';

  public constructor(orderSessionId: string, storeId: string) {
    super(`Store "${storeId}" already has two requests in order session "${orderSessionId}".`);
    this.name = 'RequestLimitExceededError';
  }
}

export class OrderRequestAuthorizationError extends Error {
  public readonly code = 'ORDER_REQUEST_FORBIDDEN';

  public constructor() {
    super('The requesting user is not allowed to submit for this store.');
    this.name = 'OrderRequestAuthorizationError';
  }
}

export class OrderSessionUnavailableError extends Error {
  public readonly code = 'ORDER_SESSION_UNAVAILABLE';

  public constructor() {
    super('The order session is not open for requests.');
    this.name = 'OrderSessionUnavailableError';
  }
}

export class ActiveWaitTicketExistsError extends Error {
  public readonly code = 'ACTIVE_WAIT_TICKET_EXISTS';

  public constructor(storeId: string, productIds: readonly string[]) {
    super(
      `Store "${storeId}" already has an active wait ticket for product(s): ${productIds.join(', ')}.`,
    );
    this.name = 'ActiveWaitTicketExistsError';
  }
}

export function isRequestDeadlineClosed(requestDeadlineAt: Date, instant: Date): boolean {
  return requestDeadlineAt.getTime() <= instant.getTime();
}

export async function createOrderRequest(
  tx: Transaction,
  input: CreateOrderRequestInput,
): Promise<CreatedOrderRequest> {
  validateItems(input.items);

  return withAdvisoryLock(
    tx,
    'order-request-slot',
    `${input.orderSessionId}:${input.storeId}`,
    async () => {
      const [session] = await tx
        .select({
          id: orderSessions.id,
          status: orderSessions.status,
          requestDeadlineAt: orderSessions.requestDeadlineAt,
          deletedAt: orderSessions.deletedAt,
        })
        .from(orderSessions)
        .where(eq(orderSessions.id, input.orderSessionId))
        .limit(1);

      const now = new Date();
      if (
        !session ||
        session.status !== 'open' ||
        session.deletedAt !== null ||
        isRequestDeadlineClosed(session.requestDeadlineAt, now)
      ) {
        throw new OrderSessionUnavailableError();
      }

      await assertUserMayAccessStore(tx, input.requestedByUserId, input.storeId);
      await assertProductsAreActive(
        tx,
        input.items.map((item) => item.productId),
      );

      return withStoreProductWaitLocks(
        tx,
        input.storeId,
        input.items.map((item) => item.productId),
        async () => {
          await assertNoActiveWaitTickets(
            tx,
            input.storeId,
            input.items.map((item) => item.productId),
          );

          // The advisory lock makes slot selection atomic. The CHECK + UNIQUE constraints remain
          // the final guard against bypasses and guarantee that a third request cannot be stored.
          const existingRequests = await tx
            .select({ requestNumber: orderRequests.requestNumber })
            .from(orderRequests)
            .where(
              and(
                eq(orderRequests.orderSessionId, input.orderSessionId),
                eq(orderRequests.storeId, input.storeId),
              ),
            );

          const usedSlots = new Set(existingRequests.map((request) => request.requestNumber));
          const requestNumber = usedSlots.has(1) ? (usedSlots.has(2) ? null : 2) : 1;

          if (requestNumber === null) {
            throw new RequestLimitExceededError(input.orderSessionId, input.storeId);
          }

          const [createdRequest] = await tx
            .insert(orderRequests)
            .values({
              orderSessionId: input.orderSessionId,
              storeId: input.storeId,
              requestNumber,
              status: 'submitted',
              requestedByUserId: input.requestedByUserId,
              submittedAt: now,
              notes: input.notes ?? null,
            })
            .returning({
              id: orderRequests.id,
              requestNumber: orderRequests.requestNumber,
              submittedAt: orderRequests.submittedAt,
            });

          if (!createdRequest) {
            throw new Error('Order request insert returned no row.');
          }

          await tx.insert(orderRequestItems).values(
            input.items.map((item) => ({
              orderRequestId: createdRequest.id,
              productId: item.productId,
              requestedQuantity: item.quantity,
              priorityLevel: 'P1' as const,
              notes: item.notes ?? null,
            })),
          );

          return { ...createdRequest, submittedAt: createdRequest.submittedAt ?? now };
        },
      );
    },
  );
}

export async function submitOrderRequest(
  database: Database,
  input: SubmitOrderRequestInput,
): Promise<IdempotencyResult<CreatedOrderRequest>> {
  return withIdempotency(
    database,
    {
      scope: 'order-request.submit',
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const created = await createOrderRequest(tx, input);
      await input.onCreated?.(tx, created);
      const responseBody: JsonObject = {
        orderRequestId: created.id,
        requestNumber: created.requestNumber,
      };

      return {
        value: created,
        responseStatus: 201,
        responseBody,
        resourceType: 'order_request',
        resourceId: created.id,
      };
    },
  );
}

function validateItems(items: readonly CreateOrderRequestItemInput[]): void {
  if (items.length === 0) {
    throw new Error('An order request must contain at least one item.');
  }

  const productIds = new Set<string>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new RangeError('Order request item quantities must be positive safe integers.');
    }

    if (productIds.has(item.productId)) {
      throw new Error(`Duplicate product "${item.productId}" in order request.`);
    }
    productIds.add(item.productId);
  }
}

async function assertUserMayAccessStore(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);

  if (!store) {
    throw new OrderRequestAuthorizationError();
  }

  const [user] = await tx
    .select({ id: users.id, role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user || user.status !== 'active') {
    throw new OrderRequestAuthorizationError();
  }

  if (user.role === 'admin' || (user.role === 'store' && user.storeId === storeId)) {
    return;
  }

  if (user.role === 'htkd') {
    const [assignment] = await tx
      .select({ id: htkdAssignments.id })
      .from(htkdAssignments)
      .where(
        and(
          eq(htkdAssignments.userId, userId),
          eq(htkdAssignments.storeId, storeId),
          isNull(htkdAssignments.revokedAt),
        ),
      )
      .limit(1);

    if (assignment) {
      return;
    }
  }

  throw new OrderRequestAuthorizationError();
}

async function withStoreProductWaitLocks<T>(
  tx: Transaction,
  storeId: string,
  productIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const sortedProductIds = [...new Set(productIds)].sort();

  const acquire = async (index: number): Promise<T> => {
    const productId = sortedProductIds[index];
    if (productId === undefined) {
      return operation();
    }

    return withAdvisoryLock(tx, 'store-product-wait', `${storeId}:${productId}`, () =>
      acquire(index + 1),
    );
  };

  return acquire(0);
}

async function assertNoActiveWaitTickets(
  tx: Transaction,
  storeId: string,
  productIds: readonly string[],
): Promise<void> {
  const activeWaits = await tx
    .select({ productId: waitTickets.productId })
    .from(waitTickets)
    .where(
      and(
        eq(waitTickets.storeId, storeId),
        inArray(waitTickets.productId, [...productIds]),
        eq(waitTickets.status, 'active'),
        isNull(waitTickets.deletedAt),
      ),
    );

  if (activeWaits.length > 0) {
    throw new ActiveWaitTicketExistsError(
      storeId,
      activeWaits.map((wait) => wait.productId).sort(),
    );
  }
}

async function assertProductsAreActive(
  tx: Transaction,
  productIds: readonly string[],
): Promise<void> {
  const activeProducts = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        inArray(products.id, [...productIds]),
        eq(products.isActive, true),
        isNull(products.deletedAt),
      ),
    );

  if (activeProducts.length !== productIds.length) {
    throw new Error('One or more requested products do not exist or are inactive.');
  }
}

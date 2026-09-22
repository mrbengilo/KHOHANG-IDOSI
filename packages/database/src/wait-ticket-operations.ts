import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  type SQL,
} from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  dailyPriorityOffers,
  htkdAssignments,
  mergedOrderItems,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  stores,
  users,
  waitTickets,
  type DatabaseUserRole,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;

export type WaitTicketDatabaseStatus = typeof waitTickets.$inferSelect.status;
export type WaitTicketPriority = typeof waitTickets.$inferSelect.priorityLevel;
export type WaitTicketEffectiveStatus = 'waiting' | 'offered' | 'partially_fulfilled';
export type PriorityOfferDatabaseStatus = typeof dailyPriorityOffers.$inferSelect.status;
export type PriorityOfferResponseAction = 'accept' | 'decline' | 'expire';
export type PriorityOfferEffectiveAction = PriorityOfferResponseAction | 'cancel';

interface ActiveActor {
  readonly id: string;
  readonly role: DatabaseUserRole;
  readonly storeId: string | null;
}

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PageMetadata {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface WaitTicketListInput extends PageInput {
  readonly actorUserId: string;
  readonly storeId?: string;
  readonly productId?: string;
  readonly sessionId?: string;
  readonly status?: WaitTicketDatabaseStatus;
  readonly effectiveStatus?: WaitTicketEffectiveStatus;
  readonly priorityLevel?: WaitTicketPriority;
}

export interface WaitTicketRecord {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly sourceOrderRequestItemId: string;
  readonly orderSessionId: string;
  readonly mergedOrderId: string | null;
  readonly status: WaitTicketDatabaseStatus;
  readonly priorityLevel: WaitTicketPriority;
  readonly originalQuantity: number;
  readonly remainingQuantity: number;
  readonly fulfilledQuantity: number;
  readonly queuedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly hasOpenOffer: boolean;
}

export interface WaitTicketPage {
  readonly data: readonly WaitTicketRecord[];
  readonly pagination: PageMetadata;
}

export interface PriorityOfferListInput extends PageInput {
  readonly actorUserId: string;
  readonly waitTicketId?: string;
  readonly storeId?: string;
  readonly status?: PriorityOfferDatabaseStatus;
}

export interface PriorityOfferRecord {
  readonly id: string;
  readonly businessDate: string;
  readonly storeId: string;
  readonly productId: string;
  readonly waitTicketId: string;
  readonly priorityLevel: WaitTicketPriority;
  readonly roundNumber: number;
  readonly offeredQuantity: number;
  readonly acceptedQuantity: number;
  readonly status: PriorityOfferDatabaseStatus;
  readonly effectiveStatus: PriorityOfferDatabaseStatus;
  readonly responseDeadlineAt: Date;
  readonly respondedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PriorityOfferPage {
  readonly data: readonly PriorityOfferRecord[];
  readonly pagination: PageMetadata;
}

export interface WaitTicketHistoryInput {
  readonly actorUserId: string;
  readonly waitTicketId: string;
  readonly limit?: number;
}

export interface WaitTicketAuditRecord {
  readonly id: string;
  readonly requestId: string | null;
  readonly actorUserId: string | null;
  readonly actorRole: DatabaseUserRole | null;
  readonly actorStoreId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: JsonObject | null;
  readonly after: JsonObject | null;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
}

export interface WaitTicketHistory {
  readonly ticket: WaitTicketRecord;
  readonly offers: readonly PriorityOfferRecord[];
  readonly audit: readonly WaitTicketAuditRecord[];
}

export interface CancelWaitTicketInput {
  readonly waitTicketId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CancelledWaitTicket {
  readonly waitTicketId: string;
  readonly status: 'cancelled';
  readonly cancelledOfferIds: readonly string[];
  readonly resolvedAt: Date;
}

interface RespondPriorityOfferBaseInput {
  readonly offerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export type RespondPriorityOfferInput =
  | (RespondPriorityOfferBaseInput & {
      readonly action: 'accept';
      readonly actorUserId: string;
      readonly acceptedQuantity: number;
    })
  | (RespondPriorityOfferBaseInput & {
      readonly action: 'decline';
      readonly actorUserId: string;
      readonly reason?: string;
    })
  | (RespondPriorityOfferBaseInput & {
      readonly action: 'expire';
      readonly actorUserId: string | null;
    });

type RespondPriorityOfferTransactionInput = RespondPriorityOfferInput extends infer Input
  ? Input extends RespondPriorityOfferInput
    ? Omit<Input, 'idempotencyKey' | 'requestHash'>
    : never
  : never;

export interface RespondedPriorityOffer {
  readonly offerId: string;
  readonly waitTicketId: string;
  readonly status: 'accepted' | 'declined' | 'expired' | 'cancelled';
  readonly acceptedQuantity: number;
  readonly effectiveAction: PriorityOfferEffectiveAction;
  readonly respondedAt: Date;
}

export interface PriorityOfferTransitionInput {
  readonly action: PriorityOfferResponseAction;
  readonly currentStatus: PriorityOfferDatabaseStatus;
  readonly offeredQuantity: number;
  readonly acceptedQuantity?: number;
  readonly responseDeadlineAt: Date;
  readonly now: Date;
  readonly waitTicketStatus: WaitTicketDatabaseStatus;
  readonly waitTicketRemainingQuantity: number;
}

export interface PriorityOfferTransition {
  readonly status: 'accepted' | 'declined' | 'expired' | 'cancelled';
  readonly acceptedQuantity: number;
  readonly effectiveAction: PriorityOfferEffectiveAction;
}

export class WaitTicketAuthorizationError extends Error {
  public readonly code = 'WAIT_TICKET_FORBIDDEN';

  public constructor() {
    super('The actor is not allowed to access this store.');
    this.name = 'WaitTicketAuthorizationError';
  }
}

export class WaitTicketNotFoundError extends Error {
  public readonly code = 'WAIT_TICKET_NOT_FOUND';

  public constructor() {
    super('The wait ticket does not exist or is unavailable.');
    this.name = 'WaitTicketNotFoundError';
  }
}

export class PriorityOfferNotFoundError extends Error {
  public readonly code = 'PRIORITY_OFFER_NOT_FOUND';

  public constructor() {
    super('The priority offer does not exist or is unavailable.');
    this.name = 'PriorityOfferNotFoundError';
  }
}

export class WaitTicketConflictError extends Error {
  public readonly code = 'WAIT_TICKET_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'WaitTicketConflictError';
  }
}

export class PriorityOfferConflictError extends Error {
  public readonly code = 'PRIORITY_OFFER_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'PriorityOfferConflictError';
  }
}

export class WaitTicketValidationError extends Error {
  public readonly code = 'WAIT_TICKET_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'WaitTicketValidationError';
  }
}

export async function listWaitTickets(
  database: Database,
  input: WaitTicketListInput,
): Promise<WaitTicketPage> {
  const pagination = normalizePage(input);
  const accessibleStoreIds = await resolveAccessibleStoreIds(
    database,
    input.actorUserId,
    input.storeId,
  );
  if (accessibleStoreIds !== null && accessibleStoreIds.length === 0) {
    return emptyPage(pagination);
  }

  const now = new Date();
  const conditions: SQL[] = [isNull(waitTickets.deletedAt)];
  appendStoreScope(conditions, accessibleStoreIds, input.storeId, waitTickets.storeId);
  if (input.productId !== undefined) {
    conditions.push(eq(waitTickets.productId, input.productId));
  }
  if (input.sessionId !== undefined) {
    conditions.push(eq(orderRequests.orderSessionId, input.sessionId));
  }
  if (input.status !== undefined) {
    conditions.push(eq(waitTickets.status, input.status));
  }
  if (input.effectiveStatus !== undefined) {
    conditions.push(eq(waitTickets.status, 'active'));
    const openOffer = exists(
      database
        .select({ id: dailyPriorityOffers.id })
        .from(dailyPriorityOffers)
        .where(
          and(
            eq(dailyPriorityOffers.waitTicketId, waitTickets.id),
            eq(dailyPriorityOffers.status, 'offered'),
            gt(dailyPriorityOffers.responseDeadlineAt, now),
            isNull(dailyPriorityOffers.deletedAt),
          ),
        ),
    );
    if (input.effectiveStatus === 'offered') {
      conditions.push(openOffer);
    } else {
      conditions.push(
        notExists(
          database
            .select({ id: dailyPriorityOffers.id })
            .from(dailyPriorityOffers)
            .where(
              and(
                eq(dailyPriorityOffers.waitTicketId, waitTickets.id),
                eq(dailyPriorityOffers.status, 'offered'),
                gt(dailyPriorityOffers.responseDeadlineAt, now),
                isNull(dailyPriorityOffers.deletedAt),
              ),
            ),
        ),
      );
      conditions.push(
        input.effectiveStatus === 'partially_fulfilled'
          ? gt(waitTickets.fulfilledQuantity, 0)
          : eq(waitTickets.fulfilledQuantity, 0),
      );
    }
  }
  if (input.priorityLevel !== undefined) {
    conditions.push(eq(waitTickets.priorityLevel, input.priorityLevel));
  }

  const predicate = and(...conditions);
  const [totals, rows] = await Promise.all([
    database
      .select({ value: count() })
      .from(waitTickets)
      .innerJoin(orderRequestItems, eq(orderRequestItems.id, waitTickets.sourceOrderRequestItemId))
      .innerJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
      .where(predicate),
    database
      .select({
        id: waitTickets.id,
        storeId: waitTickets.storeId,
        productId: waitTickets.productId,
        sourceOrderRequestItemId: waitTickets.sourceOrderRequestItemId,
        orderSessionId: orderRequests.orderSessionId,
        mergedOrderId: mergedOrderItems.mergedOrderId,
        status: waitTickets.status,
        priorityLevel: waitTickets.priorityLevel,
        originalQuantity: waitTickets.originalQuantity,
        remainingQuantity: waitTickets.remainingQuantity,
        fulfilledQuantity: waitTickets.fulfilledQuantity,
        queuedAt: waitTickets.queuedAt,
        resolvedAt: waitTickets.resolvedAt,
        resolutionReason: waitTickets.resolutionReason,
        createdAt: waitTickets.createdAt,
        updatedAt: waitTickets.updatedAt,
      })
      .from(waitTickets)
      .innerJoin(orderRequestItems, eq(orderRequestItems.id, waitTickets.sourceOrderRequestItemId))
      .innerJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
      .leftJoin(
        mergedOrderSources,
        eq(mergedOrderSources.orderRequestItemId, waitTickets.sourceOrderRequestItemId),
      )
      .leftJoin(mergedOrderItems, eq(mergedOrderItems.id, mergedOrderSources.mergedOrderItemId))
      .where(predicate)
      .orderBy(desc(waitTickets.queuedAt), desc(waitTickets.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);

  const openOfferTicketIds = await findOpenOfferTicketIds(
    database,
    rows.map((row) => row.id),
    now,
  );
  const data = rows.map((row) => ({ ...row, hasOpenOffer: openOfferTicketIds.has(row.id) }));
  const totalItems = totals[0]?.value ?? 0;
  return {
    data,
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

export async function listPriorityOffers(
  database: Database,
  input: PriorityOfferListInput,
): Promise<PriorityOfferPage> {
  const pagination = normalizePage(input);
  const accessibleStoreIds = await resolveAccessibleStoreIds(
    database,
    input.actorUserId,
    input.storeId,
  );
  if (accessibleStoreIds !== null && accessibleStoreIds.length === 0) {
    return emptyPage(pagination);
  }

  const conditions: SQL[] = [isNull(dailyPriorityOffers.deletedAt)];
  appendStoreScope(conditions, accessibleStoreIds, input.storeId, dailyPriorityOffers.storeId);
  if (input.waitTicketId !== undefined) {
    conditions.push(eq(dailyPriorityOffers.waitTicketId, input.waitTicketId));
  }
  const now = new Date();
  if (input.status !== undefined) {
    conditions.push(priorityOfferStatusCondition(input.status, now));
  }

  const predicate = and(...conditions);
  const [totals, rows] = await Promise.all([
    database.select({ value: count() }).from(dailyPriorityOffers).where(predicate),
    database
      .select({
        id: dailyPriorityOffers.id,
        businessDate: dailyPriorityOffers.businessDate,
        storeId: dailyPriorityOffers.storeId,
        productId: dailyPriorityOffers.productId,
        waitTicketId: dailyPriorityOffers.waitTicketId,
        priorityLevel: dailyPriorityOffers.priorityLevel,
        roundNumber: dailyPriorityOffers.roundNumber,
        offeredQuantity: dailyPriorityOffers.offeredQuantity,
        acceptedQuantity: dailyPriorityOffers.acceptedQuantity,
        status: dailyPriorityOffers.status,
        responseDeadlineAt: dailyPriorityOffers.responseDeadlineAt,
        respondedAt: dailyPriorityOffers.respondedAt,
        createdAt: dailyPriorityOffers.createdAt,
        updatedAt: dailyPriorityOffers.updatedAt,
      })
      .from(dailyPriorityOffers)
      .where(predicate)
      .orderBy(desc(dailyPriorityOffers.createdAt), desc(dailyPriorityOffers.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);

  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows.map((row) => ({
      ...row,
      effectiveStatus: effectivePriorityOfferStatus(row, now),
    })),
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

export async function getWaitTicketHistory(
  database: Database,
  input: WaitTicketHistoryInput,
): Promise<WaitTicketHistory> {
  const limit = normalizeLimit(input.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, 'limit');
  const accessibleStoreIds = await resolveAccessibleStoreIds(database, input.actorUserId);
  if (accessibleStoreIds !== null && accessibleStoreIds.length === 0) {
    throw new WaitTicketNotFoundError();
  }

  const conditions: SQL[] = [eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)];
  appendStoreScope(conditions, accessibleStoreIds, undefined, waitTickets.storeId);
  const [ticket] = await database
    .select({
      id: waitTickets.id,
      storeId: waitTickets.storeId,
      productId: waitTickets.productId,
      sourceOrderRequestItemId: waitTickets.sourceOrderRequestItemId,
      orderSessionId: orderRequests.orderSessionId,
      mergedOrderId: mergedOrderItems.mergedOrderId,
      status: waitTickets.status,
      priorityLevel: waitTickets.priorityLevel,
      originalQuantity: waitTickets.originalQuantity,
      remainingQuantity: waitTickets.remainingQuantity,
      fulfilledQuantity: waitTickets.fulfilledQuantity,
      queuedAt: waitTickets.queuedAt,
      resolvedAt: waitTickets.resolvedAt,
      resolutionReason: waitTickets.resolutionReason,
      createdAt: waitTickets.createdAt,
      updatedAt: waitTickets.updatedAt,
    })
    .from(waitTickets)
    .innerJoin(orderRequestItems, eq(orderRequestItems.id, waitTickets.sourceOrderRequestItemId))
    .innerJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
    .leftJoin(
      mergedOrderSources,
      eq(mergedOrderSources.orderRequestItemId, waitTickets.sourceOrderRequestItemId),
    )
    .leftJoin(mergedOrderItems, eq(mergedOrderItems.id, mergedOrderSources.mergedOrderItemId))
    .where(and(...conditions))
    .limit(1);
  if (!ticket) {
    throw new WaitTicketNotFoundError();
  }

  const offerRows = await database
    .select({
      id: dailyPriorityOffers.id,
      businessDate: dailyPriorityOffers.businessDate,
      storeId: dailyPriorityOffers.storeId,
      productId: dailyPriorityOffers.productId,
      waitTicketId: dailyPriorityOffers.waitTicketId,
      priorityLevel: dailyPriorityOffers.priorityLevel,
      roundNumber: dailyPriorityOffers.roundNumber,
      offeredQuantity: dailyPriorityOffers.offeredQuantity,
      acceptedQuantity: dailyPriorityOffers.acceptedQuantity,
      status: dailyPriorityOffers.status,
      responseDeadlineAt: dailyPriorityOffers.responseDeadlineAt,
      respondedAt: dailyPriorityOffers.respondedAt,
      createdAt: dailyPriorityOffers.createdAt,
      updatedAt: dailyPriorityOffers.updatedAt,
    })
    .from(dailyPriorityOffers)
    .where(
      and(
        eq(dailyPriorityOffers.waitTicketId, ticket.id),
        eq(dailyPriorityOffers.storeId, ticket.storeId),
        isNull(dailyPriorityOffers.deletedAt),
      ),
    )
    .orderBy(desc(dailyPriorityOffers.createdAt), desc(dailyPriorityOffers.id))
    .limit(limit);
  const historyReadAt = new Date();
  const offers = offerRows.map((offer) => ({
    ...offer,
    effectiveStatus: effectivePriorityOfferStatus(offer, historyReadAt),
  }));

  const auditEntities: SQL[] = [
    and(eq(auditLogs.entityType, 'wait_ticket'), eq(auditLogs.entityId, ticket.id))!,
  ];
  if (offers.length > 0) {
    auditEntities.push(
      and(
        eq(auditLogs.entityType, 'priority_offer'),
        inArray(
          auditLogs.entityId,
          offers.map((offer) => offer.id),
        ),
      )!,
    );
  }
  const audit = await database
    .select({
      id: auditLogs.id,
      requestId: auditLogs.requestId,
      actorUserId: auditLogs.actorUserId,
      actorRole: auditLogs.actorRole,
      actorStoreId: auditLogs.actorStoreId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      before: auditLogs.before,
      after: auditLogs.after,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(or(...auditEntities))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit);

  const openOfferTicketIds = await findOpenOfferTicketIds(database, [ticket.id], new Date());
  return {
    ticket: { ...ticket, hasOpenOffer: openOfferTicketIds.has(ticket.id) },
    offers,
    audit,
  };
}

export async function cancelWaitTicket(
  database: Database,
  input: CancelWaitTicketInput,
): Promise<IdempotencyResult<CancelledWaitTicket>> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new WaitTicketValidationError(
      'A cancellation reason must contain at least 3 characters.',
    );
  }

  return withIdempotency(
    database,
    {
      scope: `wait-ticket.cancel:${input.waitTicketId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const cancelled = await cancelWaitTicketInTransaction(tx, input, reason);
      const responseBody: JsonObject = {
        waitTicketId: cancelled.waitTicketId,
        status: cancelled.status,
        cancelledOfferIds: [...cancelled.cancelledOfferIds],
        resolvedAt: cancelled.resolvedAt.toISOString(),
      };
      return {
        value: cancelled,
        responseStatus: 200,
        responseBody,
        resourceType: 'wait_ticket',
        resourceId: cancelled.waitTicketId,
      };
    },
  );
}

export async function cancelWaitTicketInTransaction(
  tx: Transaction,
  input: Omit<CancelWaitTicketInput, 'idempotencyKey' | 'requestHash'>,
  normalizedReason = input.reason.trim(),
): Promise<CancelledWaitTicket> {
  if (normalizedReason.length < 3) {
    throw new WaitTicketValidationError(
      'A cancellation reason must contain at least 3 characters.',
    );
  }

  return withAdvisoryLock(tx, 'wait-ticket', input.waitTicketId, async () => {
    const [scope] = await tx
      .select({ storeId: waitTickets.storeId, productId: waitTickets.productId })
      .from(waitTickets)
      .where(and(eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)))
      .limit(1);
    if (!scope) {
      throw new WaitTicketNotFoundError();
    }
    const actor = await assertActorMayAccessStore(tx, input.actorUserId, scope.storeId);

    return withAdvisoryLock(
      tx,
      'store-product-wait',
      `${scope.storeId}:${scope.productId}`,
      async () => {
        const [ticket] = await tx
          .select()
          .from(waitTickets)
          .where(and(eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)))
          .for('update')
          .limit(1);
        if (!ticket) {
          throw new WaitTicketNotFoundError();
        }
        if (ticket.storeId !== scope.storeId || ticket.productId !== scope.productId) {
          throw new WaitTicketConflictError('The wait ticket scope changed during cancellation.');
        }
        if (ticket.status !== 'active') {
          throw new WaitTicketConflictError('Only an active wait ticket can be cancelled.');
        }

        const pendingOffers = await tx
          .select()
          .from(dailyPriorityOffers)
          .where(
            and(
              eq(dailyPriorityOffers.waitTicketId, ticket.id),
              inArray(dailyPriorityOffers.status, ['offered', 'accepted']),
              isNull(dailyPriorityOffers.deletedAt),
            ),
          )
          .orderBy(asc(dailyPriorityOffers.id))
          .for('update');

        if (pendingOffers.some((offer) => offer.status === 'accepted')) {
          throw new WaitTicketConflictError(
            'A wait ticket with an accepted priority offer cannot be cancelled.',
          );
        }

        const now = new Date();
        const cancelledOffers = pendingOffers.filter((offer) => offer.status === 'offered');
        const cancelledOfferIds = cancelledOffers.map((offer) => offer.id);
        if (cancelledOfferIds.length > 0) {
          await tx
            .update(dailyPriorityOffers)
            .set({
              status: 'cancelled',
              acceptedQuantity: 0,
              respondedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                inArray(dailyPriorityOffers.id, cancelledOfferIds),
                eq(dailyPriorityOffers.status, 'offered'),
              ),
            );
        }

        const [updated] = await tx
          .update(waitTickets)
          .set({
            status: 'cancelled',
            resolvedAt: now,
            resolutionReason: normalizedReason,
            updatedAt: now,
          })
          .where(and(eq(waitTickets.id, ticket.id), eq(waitTickets.status, 'active')))
          .returning({ id: waitTickets.id });
        if (!updated) {
          throw new WaitTicketConflictError('The wait ticket changed during cancellation.');
        }

        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: actor.id,
          actorRole: actor.role,
          actorStoreId: ticket.storeId,
          action: 'WAIT_TICKET_CANCELLED',
          entityType: 'wait_ticket',
          entityId: ticket.id,
          before: waitTicketAuditSnapshot(ticket),
          after: {
            ...waitTicketAuditSnapshot(ticket),
            status: 'cancelled',
            resolvedAt: now.toISOString(),
            resolutionReason: normalizedReason,
          },
          metadata: { cancelledOfferIds },
        });

        if (cancelledOfferIds.length > 0) {
          await tx.insert(auditLogs).values(
            cancelledOffers.map((offer) => ({
              requestId: input.requestId ?? null,
              actorUserId: actor.id,
              actorRole: actor.role,
              actorStoreId: ticket.storeId,
              action: 'PRIORITY_OFFER_CANCELLED_WITH_WAIT_TICKET',
              entityType: 'priority_offer',
              entityId: offer.id,
              before: priorityOfferAuditSnapshot(offer),
              after: {
                ...priorityOfferAuditSnapshot(offer),
                status: 'cancelled',
                acceptedQuantity: 0,
                respondedAt: now.toISOString(),
                waitTicketId: ticket.id,
              },
            })),
          );
        }

        return {
          waitTicketId: ticket.id,
          status: 'cancelled',
          cancelledOfferIds,
          resolvedAt: now,
        };
      },
    );
  });
}

export async function respondPriorityOffer(
  database: Database,
  input: RespondPriorityOfferInput,
): Promise<IdempotencyResult<RespondedPriorityOffer>> {
  validatePriorityOfferResponseReason(input);
  return withIdempotency(
    database,
    {
      scope: `priority-offer.respond:${input.offerId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const responded = await respondPriorityOfferInTransaction(tx, input);
      const responseBody: JsonObject = {
        offerId: responded.offerId,
        waitTicketId: responded.waitTicketId,
        status: responded.status,
        acceptedQuantity: responded.acceptedQuantity,
        effectiveAction: responded.effectiveAction,
        respondedAt: responded.respondedAt.toISOString(),
      };
      return {
        value: responded,
        responseStatus: 200,
        responseBody,
        resourceType: 'priority_offer',
        resourceId: responded.offerId,
      };
    },
  );
}

export async function respondPriorityOfferInTransaction(
  tx: Transaction,
  input: RespondPriorityOfferTransactionInput,
): Promise<RespondedPriorityOffer> {
  validatePriorityOfferResponseReason(input);
  return withAdvisoryLock(tx, 'priority-offer', input.offerId, async () => {
    const [scope] = await tx
      .select({
        waitTicketId: dailyPriorityOffers.waitTicketId,
        storeId: dailyPriorityOffers.storeId,
        productId: dailyPriorityOffers.productId,
      })
      .from(dailyPriorityOffers)
      .where(and(eq(dailyPriorityOffers.id, input.offerId), isNull(dailyPriorityOffers.deletedAt)))
      .limit(1);
    if (!scope) {
      throw new PriorityOfferNotFoundError();
    }

    let actor: ActiveActor | null = null;
    if (input.actorUserId !== null) {
      actor = await assertActorMayAccessStore(tx, input.actorUserId, scope.storeId);
    } else if (input.action !== 'expire') {
      throw new WaitTicketAuthorizationError();
    }
    if (input.action !== 'expire' && actor?.role !== 'store') {
      throw new WaitTicketAuthorizationError();
    }

    return withAdvisoryLock(
      tx,
      'store-product-wait',
      `${scope.storeId}:${scope.productId}`,
      async () => {
        const [ticket] = await tx
          .select({
            id: waitTickets.id,
            storeId: waitTickets.storeId,
            productId: waitTickets.productId,
            status: waitTickets.status,
            remainingQuantity: waitTickets.remainingQuantity,
          })
          .from(waitTickets)
          .where(and(eq(waitTickets.id, scope.waitTicketId), isNull(waitTickets.deletedAt)))
          .for('update')
          .limit(1);
        if (!ticket) {
          throw new WaitTicketNotFoundError();
        }

        const [offer] = await tx
          .select()
          .from(dailyPriorityOffers)
          .where(
            and(eq(dailyPriorityOffers.id, input.offerId), isNull(dailyPriorityOffers.deletedAt)),
          )
          .for('update')
          .limit(1);
        if (!offer) {
          throw new PriorityOfferNotFoundError();
        }
        if (
          offer.waitTicketId !== ticket.id ||
          offer.storeId !== ticket.storeId ||
          offer.productId !== ticket.productId ||
          offer.storeId !== scope.storeId ||
          offer.productId !== scope.productId
        ) {
          throw new PriorityOfferConflictError('The priority offer scope is inconsistent.');
        }

        const respondedAt = new Date();
        const transition = planPriorityOfferResponse({
          action: input.action,
          currentStatus: offer.status,
          offeredQuantity: offer.offeredQuantity,
          ...(input.action === 'accept' ? { acceptedQuantity: input.acceptedQuantity } : {}),
          responseDeadlineAt: offer.responseDeadlineAt,
          now: respondedAt,
          waitTicketStatus: ticket.status,
          waitTicketRemainingQuantity: ticket.remainingQuantity,
        });

        const [updated] = await tx
          .update(dailyPriorityOffers)
          .set({
            status: transition.status,
            acceptedQuantity: transition.acceptedQuantity,
            respondedAt,
            updatedAt: respondedAt,
          })
          .where(
            and(
              eq(dailyPriorityOffers.id, offer.id),
              eq(dailyPriorityOffers.status, 'offered'),
              isNull(dailyPriorityOffers.deletedAt),
            ),
          )
          .returning({ id: dailyPriorityOffers.id });
        if (!updated) {
          throw new PriorityOfferConflictError('The priority offer changed during response.');
        }

        const reason = input.action === 'decline' ? (input.reason?.trim() ?? null) : null;
        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          actorStoreId: offer.storeId,
          action: priorityOfferAuditAction(transition.effectiveAction),
          entityType: 'priority_offer',
          entityId: offer.id,
          before: priorityOfferAuditSnapshot(offer),
          after: {
            ...priorityOfferAuditSnapshot(offer),
            status: transition.status,
            acceptedQuantity: transition.acceptedQuantity,
            respondedAt: respondedAt.toISOString(),
          },
          metadata: {
            requestedAction: input.action,
            effectiveAction: transition.effectiveAction,
            reason,
          },
        });

        return {
          offerId: offer.id,
          waitTicketId: offer.waitTicketId,
          status: transition.status,
          acceptedQuantity: transition.acceptedQuantity,
          effectiveAction: transition.effectiveAction,
          respondedAt,
        };
      },
    );
  });
}

export function planPriorityOfferResponse(
  input: PriorityOfferTransitionInput,
): PriorityOfferTransition {
  if (input.currentStatus !== 'offered') {
    throw new PriorityOfferConflictError('Only an offered priority offer can be responded to.');
  }
  if (
    !Number.isSafeInteger(input.offeredQuantity) ||
    input.offeredQuantity <= 0 ||
    !Number.isSafeInteger(input.waitTicketRemainingQuantity) ||
    input.waitTicketRemainingQuantity < 0
  ) {
    throw new WaitTicketValidationError('Offer and wait quantities must be safe integers.');
  }
  if (
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(input.responseDeadlineAt.getTime())
  ) {
    throw new WaitTicketValidationError('Offer response timestamps must be valid dates.');
  }

  if (input.waitTicketStatus !== 'active') {
    return { status: 'cancelled', acceptedQuantity: 0, effectiveAction: 'cancel' };
  }
  if (input.now.getTime() >= input.responseDeadlineAt.getTime()) {
    return { status: 'expired', acceptedQuantity: 0, effectiveAction: 'expire' };
  }
  if (input.action === 'expire') {
    throw new PriorityOfferConflictError('A priority offer cannot expire before its deadline.');
  }
  if (input.action === 'decline') {
    return { status: 'declined', acceptedQuantity: 0, effectiveAction: 'decline' };
  }

  if (
    !Number.isSafeInteger(input.acceptedQuantity) ||
    input.acceptedQuantity !== input.offeredQuantity
  ) {
    throw new WaitTicketValidationError(
      'An accepted priority offer must accept its complete offered quantity.',
    );
  }
  if (input.offeredQuantity > input.waitTicketRemainingQuantity) {
    throw new PriorityOfferConflictError(
      'The offered quantity exceeds the wait ticket quantity that remains open.',
    );
  }
  return {
    status: 'accepted',
    acceptedQuantity: input.offeredQuantity,
    effectiveAction: 'accept',
  };
}

export function effectivePriorityOfferStatus(
  offer: Pick<PriorityOfferRecord, 'status' | 'responseDeadlineAt'>,
  now: Date,
): PriorityOfferDatabaseStatus {
  if (offer.status === 'offered' && now.getTime() >= offer.responseDeadlineAt.getTime()) {
    return 'expired';
  }
  return offer.status;
}

async function resolveAccessibleStoreIds(
  database: Database,
  actorUserId: string,
  requestedStoreId?: string,
): Promise<readonly string[] | null> {
  const actor = await loadActiveActor(database, actorUserId);
  if (actor.role === 'admin') {
    return requestedStoreId === undefined ? null : [requestedStoreId];
  }

  let accessibleStoreIds: readonly string[];
  if (actor.role === 'store') {
    if (actor.storeId === null) {
      throw new WaitTicketAuthorizationError();
    }
    const [activeStore] = await database
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, actor.storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1);
    accessibleStoreIds = activeStore ? [activeStore.id] : [];
  } else {
    const assignments = await database
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
    accessibleStoreIds = assignments.map((assignment) => assignment.storeId);
  }

  if (requestedStoreId === undefined) {
    return accessibleStoreIds;
  }
  if (!accessibleStoreIds.includes(requestedStoreId)) {
    throw new WaitTicketAuthorizationError();
  }
  return [requestedStoreId];
}

async function loadActiveActor(database: Database, actorUserId: string): Promise<ActiveActor> {
  const [actor] = await database
    .select({ id: users.id, role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
    .limit(1);
  if (!actor || actor.status !== 'active') {
    throw new WaitTicketAuthorizationError();
  }
  return actor;
}

async function assertActorMayAccessStore(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<ActiveActor> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .for('share')
    .limit(1);
  if (!store) {
    throw new WaitTicketAuthorizationError();
  }

  const [actor] = await tx
    .select({ id: users.id, role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
    .for('share')
    .limit(1);
  if (!actor || actor.status !== 'active') {
    throw new WaitTicketAuthorizationError();
  }
  if (actor.role === 'admin' || (actor.role === 'store' && actor.storeId === storeId)) {
    return actor;
  }
  if (actor.role !== 'htkd') {
    throw new WaitTicketAuthorizationError();
  }

  const [assignment] = await tx
    .select({ id: htkdAssignments.id })
    .from(htkdAssignments)
    .where(
      and(
        eq(htkdAssignments.userId, actor.id),
        eq(htkdAssignments.storeId, storeId),
        isNull(htkdAssignments.revokedAt),
      ),
    )
    .for('share')
    .limit(1);
  if (!assignment) {
    throw new WaitTicketAuthorizationError();
  }
  return actor;
}

async function findOpenOfferTicketIds(
  database: Database,
  ticketIds: readonly string[],
  now: Date,
): Promise<ReadonlySet<string>> {
  if (ticketIds.length === 0) {
    return new Set();
  }
  const rows = await database
    .select({ waitTicketId: dailyPriorityOffers.waitTicketId })
    .from(dailyPriorityOffers)
    .where(
      and(
        inArray(dailyPriorityOffers.waitTicketId, [...ticketIds]),
        eq(dailyPriorityOffers.status, 'offered'),
        gt(dailyPriorityOffers.responseDeadlineAt, now),
        isNull(dailyPriorityOffers.deletedAt),
      ),
    );
  return new Set(rows.map((row) => row.waitTicketId));
}

function priorityOfferStatusCondition(status: PriorityOfferDatabaseStatus, now: Date): SQL {
  if (status === 'offered') {
    return and(
      eq(dailyPriorityOffers.status, 'offered'),
      gt(dailyPriorityOffers.responseDeadlineAt, now),
    )!;
  }
  if (status === 'expired') {
    return or(
      eq(dailyPriorityOffers.status, 'expired'),
      and(
        eq(dailyPriorityOffers.status, 'offered'),
        lte(dailyPriorityOffers.responseDeadlineAt, now),
      ),
    )!;
  }
  return eq(dailyPriorityOffers.status, status);
}

function appendStoreScope(
  conditions: SQL[],
  accessibleStoreIds: readonly string[] | null,
  requestedStoreId: string | undefined,
  column: typeof waitTickets.storeId | typeof dailyPriorityOffers.storeId,
): void {
  if (requestedStoreId !== undefined) {
    conditions.push(eq(column, requestedStoreId));
    return;
  }
  if (accessibleStoreIds !== null) {
    conditions.push(inArray(column, [...accessibleStoreIds]));
  }
}

function normalizePage(input: PageInput): { readonly page: number; readonly pageSize: number } {
  return {
    page: normalizeLimit(input.page, 1, Number.MAX_SAFE_INTEGER, 'page'),
    pageSize: normalizeLimit(input.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize'),
  };
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new WaitTicketValidationError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return normalized;
}

function pageMetadata(page: number, pageSize: number, totalItems: number): PageMetadata {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

function emptyPage<T>(pagination: { readonly page: number; readonly pageSize: number }): {
  readonly data: readonly T[];
  readonly pagination: PageMetadata;
} {
  return { data: [], pagination: pageMetadata(pagination.page, pagination.pageSize, 0) };
}

function waitTicketAuditSnapshot(ticket: typeof waitTickets.$inferSelect): JsonObject {
  return {
    status: ticket.status,
    priorityLevel: ticket.priorityLevel,
    originalQuantity: ticket.originalQuantity,
    remainingQuantity: ticket.remainingQuantity,
    fulfilledQuantity: ticket.fulfilledQuantity,
    queuedAt: ticket.queuedAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    resolutionReason: ticket.resolutionReason,
  };
}

function priorityOfferAuditSnapshot(offer: typeof dailyPriorityOffers.$inferSelect): JsonObject {
  return {
    waitTicketId: offer.waitTicketId,
    status: offer.status,
    offeredQuantity: offer.offeredQuantity,
    acceptedQuantity: offer.acceptedQuantity,
    responseDeadlineAt: offer.responseDeadlineAt.toISOString(),
    respondedAt: offer.respondedAt?.toISOString() ?? null,
  };
}

function priorityOfferAuditAction(action: PriorityOfferEffectiveAction): string {
  switch (action) {
    case 'accept':
      return 'PRIORITY_OFFER_ACCEPTED';
    case 'decline':
      return 'PRIORITY_OFFER_DECLINED';
    case 'expire':
      return 'PRIORITY_OFFER_EXPIRED';
    case 'cancel':
      return 'PRIORITY_OFFER_CANCELLED';
  }
}

function validatePriorityOfferResponseReason(
  input: Pick<RespondPriorityOfferTransactionInput, 'action'> & { readonly reason?: string },
): void {
  if (input.action === 'decline' && input.reason !== undefined && input.reason.trim().length < 3) {
    throw new WaitTicketValidationError('A decline reason must contain at least 3 characters.');
  }
}

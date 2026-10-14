import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  lt,
  ilike,
  sql,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  type SQL,
} from 'drizzle-orm';

import { createHash } from 'node:crypto';

import {
  planWaitTicketCancellation,
  waitTicketDisplay,
  type WaitTicketDisplayDetail,
  type WaitTicketDisplayStatus,
} from '@idosi/domain';

import { STOCK_JOBS_LOCK } from './allocation-decisions.js';
import {
  findResultShipmentId,
  lockActionableHolds,
  pendingDecisionHoldsCondition,
  revokeResultHoldsInTransaction,
  type RevocationActorRole,
} from './allocation-waitlist.js';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from './client.js';
import { applyWarehouseMovement } from './warehouse.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  allocationLineDispositions,
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  auditLogs,
  dailyPriorityOffers,
  outboundRequestLines,
  outboundRequests,
  reservations,
  reshareOrderSources,
  reshareOrders,
  waitTicketSources,
  htkdAssignments,
  mergedOrderItems,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  stores,
  products,
  users,
  waitTickets,
  orderSessions,
  type DatabaseUserRole,
  type JsonObject,
  type WaitTicketCancellationKind,
} from './schema.js';
import { livePriorityOfferCondition } from './priority-offer-state.js';
import { withAdvisoryLock, withTransaction, type Transaction } from './transaction.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;

async function releasePriorityOfferStock(
  tx: Transaction,
  offer: typeof dailyPriorityOffers.$inferSelect,
  occurredAt: Date,
): Promise<void> {
  await applyWarehouseMovement(tx, {
    productId: offer.productId,
    eventType: 'reservation_release',
    onHandDelta: 0,
    reservedDelta: -offer.stockHeldQuantity,
    sourceType: 'priority_offer',
    sourceId: offer.id,
    eventSequence: 2,
    reason: `Priority offer ${offer.id} released`,
    occurredAt,
  });
}

export type WaitTicketDatabaseStatus = typeof waitTickets.$inferSelect.status;
export type WaitTicketPriority = typeof waitTickets.$inferSelect.priorityLevel;
export type WaitTicketEffectiveStatus = 'waiting' | 'offered' | 'partially_fulfilled';
export type PriorityOfferDatabaseStatus = typeof dailyPriorityOffers.$inferSelect.status;
export type PriorityOfferResponseAction = 'accept' | 'decline' | 'expire';
export type PriorityOfferEffectiveAction = PriorityOfferResponseAction | 'cancel';
export type PriorityOfferCoverage = 'full' | 'partial';

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
  readonly q?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly storeId?: string;
  readonly productId?: string;
  readonly sessionId?: string;
  readonly status?: WaitTicketDatabaseStatus;
  readonly effectiveStatus?: WaitTicketEffectiveStatus;
  /** The three labels of the HTKD/store/wholesale list, evaluated in SQL before paging. */
  readonly displayStatus?: WaitTicketDisplayStatus;
  readonly priorityLevel?: WaitTicketPriority;
  /** Adds lineage (sources, sessions, pending/revoked bags, cancel capability) for the page. */
  readonly includeLineage?: boolean;
}

export interface WaitTicketLineageRecord {
  readonly displayStatus: WaitTicketDisplayStatus;
  readonly displayDetail: WaitTicketDisplayDetail;
  readonly pendingDecisionQuantity: number;
  readonly revokedQuantity: number;
  readonly legacyUnsourcedQuantity: number;
  readonly canCancel: boolean;
  readonly sources: readonly {
    readonly id: string;
    readonly kind: 'order_remainder' | 'result_waitlisted' | 'result_restored';
    readonly quantity: number;
    readonly createdAt: Date;
    readonly sessionId: string | null;
    readonly sessionCode: string | null;
    readonly allocationDecisionId: string | null;
    readonly allocationLineId: string | null;
    readonly sourceWaitTicketId: string | null;
    readonly sourceWaitTicketCode: string | null;
    readonly actorName: string | null;
  }[];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly sessionCode: string;
    readonly businessDate: string;
    readonly sessionAt: Date | null;
    readonly origin: boolean;
    readonly quantity: number | null;
  }[];
}

export interface WaitTicketRecord {
  readonly id: string;
  readonly code: string;
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
  readonly cancellationKind: WaitTicketCancellationKind | null;
  readonly cancelledByOfferId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly hasOpenOffer: boolean;
  readonly storeName?: string | null;
  readonly productName?: string | null;
  readonly sku?: string | null;
  readonly latestOffer?: {
    id: string;
    code: string;
    status: string;
    sessionId: string | null;
    sessionCode: string | null;
    deadline: string;
  } | null;
  readonly cancellationActor?: { accountId: string | null; role: DatabaseUserRole | null } | null;
  readonly lineage?: WaitTicketLineageRecord;
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
  readonly code: string;
  readonly businessDate: string;
  readonly storeId: string;
  readonly productId: string;
  readonly waitTicketId: string;
  readonly priorityLevel: WaitTicketPriority;
  readonly roundNumber: number;
  readonly offeredQuantity: number;
  readonly eligibleQuantityAtOffer: number | null;
  readonly coverage: PriorityOfferCoverage;
  readonly orderSessionId: string | null;
  readonly orderSessionCode: string | null;
  readonly orderSessionKind: 'default' | 'manual' | null;
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
  /** Fingerprint of the preview the account confirmed; required when goods are revoked. */
  readonly expectedFingerprint?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CancelledWaitTicket {
  readonly waitTicketId: string;
  readonly status: 'cancelled';
  readonly cancellationKind: WaitTicketCancellationKind;
  readonly cancelledOfferIds: readonly string[];
  readonly cancelledQuantity: number;
  readonly revokedQuantity: number;
  readonly revokedDecisionIds: readonly string[];
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
  /** True when the declined/expired offer was a full offer and its wait ticket was cancelled. */
  readonly waitTicketCancelled: boolean;
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

/** The confirmed preview no longer matches; the account must review the new scope. */
export class WaitTicketPreviewStaleError extends Error {
  public readonly code = 'WAIT_TICKET_PREVIEW_STALE';

  public constructor() {
    super('The cancellation scope changed since it was previewed.');
    this.name = 'WaitTicketPreviewStaleError';
  }
}

/** Cancelling would revoke allocation goods, which requires a confirmed preview. */
export class WaitTicketPreviewRequiredError extends Error {
  public readonly code = 'WAIT_TICKET_PREVIEW_REQUIRED';

  public constructor() {
    super('Cancelling this wait ticket revokes allocation goods; confirm its preview first.');
    this.name = 'WaitTicketPreviewRequiredError';
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
  if (input.displayStatus !== undefined) {
    // Same rule as waitTicketDisplay (domain): filtered before counting and paging, so the
    // totals, pages and labels always agree.
    const pending = pendingDecisionHoldsCondition(waitTickets.id);
    conditions.push(
      input.displayStatus === 'UNPROCESSED'
        ? or(eq(waitTickets.status, 'active'), and(eq(waitTickets.status, 'fulfilled'), pending))!
        : input.displayStatus === 'PROCESSED'
          ? and(eq(waitTickets.status, 'fulfilled'), sql`not ${pending}`)!
          : inArray(waitTickets.status, ['cancelled', 'expired']),
    );
  }

  if (input.createdFrom)
    conditions.push(gte(waitTickets.createdAt, new Date(`${input.createdFrom}T00:00:00+07:00`)));
  if (input.createdTo)
    conditions.push(
      lt(
        waitTickets.createdAt,
        new Date(new Date(`${input.createdTo}T00:00:00+07:00`).getTime() + 86_400_000),
      ),
    );
  if (input.q) {
    const search = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      or(
        ilike(waitTickets.code, search),
        exists(
          database
            .select({ id: dailyPriorityOffers.id })
            .from(dailyPriorityOffers)
            .where(
              and(
                eq(dailyPriorityOffers.waitTicketId, waitTickets.id),
                isNull(dailyPriorityOffers.deletedAt),
                ilike(dailyPriorityOffers.code, search),
              ),
            ),
        ),
      )!,
    );
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
        code: waitTickets.code,
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
        cancellationKind: waitTickets.cancellationKind,
        cancelledByOfferId: waitTickets.cancelledByOfferId,
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
      .orderBy(desc(waitTickets.createdAt), desc(waitTickets.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);

  const openOfferTicketIds = await findOpenOfferTicketIds(
    database,
    rows.map((row) => row.id),
    now,
  );
  // Enrich only the ticket page. DISTINCT ON selects one deterministic offer per ticket,
  // preferring an unconsumed live offer, otherwise the latest recorded offer.
  const ids = rows.map((row) => row.id);
  const [names, offers, cancellations] = ids.length
    ? await Promise.all([
        database
          .select({
            id: waitTickets.id,
            storeName: stores.name,
            productName: products.name,
            sku: products.sku,
          })
          .from(waitTickets)
          .leftJoin(stores, eq(stores.id, waitTickets.storeId))
          .leftJoin(products, eq(products.id, waitTickets.productId))
          .where(inArray(waitTickets.id, ids)),
        database
          .selectDistinctOn([dailyPriorityOffers.waitTicketId], {
            waitTicketId: dailyPriorityOffers.waitTicketId,
            id: dailyPriorityOffers.id,
            code: dailyPriorityOffers.code,
            status: dailyPriorityOffers.status,
            sessionId: dailyPriorityOffers.orderSessionId,
            sessionCode: orderSessions.code,
            deadline: dailyPriorityOffers.responseDeadlineAt,
          })
          .from(dailyPriorityOffers)
          .leftJoin(orderSessions, eq(orderSessions.id, dailyPriorityOffers.orderSessionId))
          .where(
            and(
              inArray(dailyPriorityOffers.waitTicketId, ids),
              isNull(dailyPriorityOffers.deletedAt),
            ),
          )
          .orderBy(
            dailyPriorityOffers.waitTicketId,
            desc(sql`case when ${livePriorityOfferCondition()} then 1 else 0 end`),
            desc(dailyPriorityOffers.createdAt),
            desc(dailyPriorityOffers.id),
          ),
        database
          .selectDistinctOn([auditLogs.entityId], {
            id: auditLogs.entityId,
            accountId: auditLogs.actorUserId,
            role: auditLogs.actorRole,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, 'wait_ticket'),
              inArray(auditLogs.entityId, ids),
              sql`${auditLogs.after}->>'status' = 'cancelled'`,
            ),
          )
          .orderBy(auditLogs.entityId, desc(auditLogs.createdAt), desc(auditLogs.id)),
      ])
    : [[], [], []];
  const nameById = new Map(names.map((row) => [row.id, row]));
  const offerById = new Map(offers.map((row) => [row.waitTicketId, row]));
  const actorById = new Map(cancellations.map((row) => [row.id, row]));
  const data = rows.map((row) => {
    const offer = offerById.get(row.id);
    const actor = actorById.get(row.id);
    return {
      ...row,
      ...nameById.get(row.id),
      hasOpenOffer: openOfferTicketIds.has(row.id),
      latestOffer: offer
        ? {
            id: offer.id,
            code: offer.code,
            status: offer.status,
            sessionId: offer.sessionId,
            sessionCode: offer.sessionCode,
            deadline: offer.deadline.toISOString(),
          }
        : null,
      cancellationActor: actor ? { accountId: actor.accountId, role: actor.role } : null,
    };
  });
  const totalItems = totals[0]?.value ?? 0;
  const lineage = input.includeLineage
    ? await loadWaitTicketLineage(
        database,
        rows.map((row) => ({ ...row, hasOpenOffer: openOfferTicketIds.has(row.id) })),
      )
    : new Map<string, WaitTicketLineageRecord>();
  return {
    data: data.map((row) => {
      const extra = lineage.get(row.id);
      return extra ? { ...row, lineage: extra } : row;
    }),
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

/**
 * Lineage of one page of tickets, one batched query per kind (no per-row queries). Sessions are
 * the proven ones only: the session of the order that opened the ticket and the sessions of its
 * recorded sources. Demand from before 0044 is reported as legacy, never assigned a session.
 */
async function loadWaitTicketLineage(
  database: Database,
  rows: readonly {
    readonly id: string;
    readonly status: WaitTicketDatabaseStatus;
    readonly orderSessionId: string;
    readonly fulfilledQuantity: number;
    readonly hasOpenOffer: boolean;
  }[],
): Promise<Map<string, WaitTicketLineageRecord>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.id);
  const sourceTicket = alias(waitTickets, 'source_ticket');
  const [pendingRows, revokedRows, sourceRows, legacyRows] = await Promise.all([
    database
      .select({
        waitTicketId: allocationLines.waitTicketId,
        quantity: sql<number>`sum(${reservations.quantity})`.mapWith(Number),
      })
      .from(allocationLines)
      .innerJoin(reservations, eq(reservations.allocationLineId, allocationLines.id))
      .innerJoin(
        allocationResultDecisions,
        and(
          eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
          eq(allocationResultDecisions.storeId, allocationLines.storeId),
        ),
      )
      .where(
        and(
          inArray(allocationLines.waitTicketId, ids),
          eq(reservations.status, 'active'),
          isNull(reservations.deletedAt),
          eq(allocationResultDecisions.status, 'pending'),
        ),
      )
      .groupBy(allocationLines.waitTicketId),
    database
      .select({
        waitTicketId: allocationLineDispositions.waitTicketId,
        quantity: sql<number>`sum(${allocationLineDispositions.quantity})`.mapWith(Number),
      })
      .from(allocationLineDispositions)
      .where(inArray(allocationLineDispositions.waitTicketId, ids))
      .groupBy(allocationLineDispositions.waitTicketId),
    database
      .select({
        id: waitTicketSources.id,
        waitTicketId: waitTicketSources.waitTicketId,
        kind: waitTicketSources.kind,
        quantity: waitTicketSources.quantity,
        createdAt: waitTicketSources.createdAt,
        sessionId: waitTicketSources.orderSessionId,
        sessionCode: orderSessions.code,
        allocationDecisionId: waitTicketSources.allocationDecisionId,
        allocationLineId: waitTicketSources.allocationLineId,
        sourceWaitTicketId: waitTicketSources.sourceWaitTicketId,
        sourceWaitTicketCode: sourceTicket.code,
        actorName: users.displayName,
      })
      .from(waitTicketSources)
      .leftJoin(orderSessions, eq(orderSessions.id, waitTicketSources.orderSessionId))
      .leftJoin(sourceTicket, eq(sourceTicket.id, waitTicketSources.sourceWaitTicketId))
      .leftJoin(users, eq(users.id, waitTicketSources.actorUserId))
      .where(inArray(waitTicketSources.waitTicketId, ids))
      .orderBy(asc(waitTicketSources.createdAt), asc(waitTicketSources.id)),
    database
      .select({ id: waitTickets.id, legacy: waitTickets.legacyUnsourcedQuantity })
      .from(waitTickets)
      .where(inArray(waitTickets.id, ids)),
  ]);
  const sessionIds = [
    ...new Set([
      ...rows.map((row) => row.orderSessionId),
      ...sourceRows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
    ]),
  ];
  const sessionRows = await database
    .select({
      id: orderSessions.id,
      code: orderSessions.code,
      businessDate: orderSessions.businessDate,
      requestDeadlineAt: orderSessions.requestDeadlineAt,
    })
    .from(orderSessions)
    .where(inArray(orderSessions.id, sessionIds));
  const sessionById = new Map(sessionRows.map((row) => [row.id, row]));
  const pendingById = new Map(pendingRows.map((row) => [row.waitTicketId, row.quantity]));
  const revokedById = new Map(revokedRows.map((row) => [row.waitTicketId, row.quantity]));
  const legacyById = new Map(legacyRows.map((row) => [row.id, row.legacy]));
  const result = new Map<string, WaitTicketLineageRecord>();
  for (const row of rows) {
    const pendingDecisionQuantity = pendingById.get(row.id) ?? 0;
    const display = waitTicketDisplay({
      status: row.status,
      hasOpenOffer: row.hasOpenOffer,
      fulfilledQuantity: row.fulfilledQuantity,
      pendingDecisionQuantity,
    });
    const sources = sourceRows.filter((source) => source.waitTicketId === row.id);
    const sessions = new Map<string, WaitTicketLineageRecord['sessions'][number]>();
    const origin = sessionById.get(row.orderSessionId);
    if (origin) {
      sessions.set(origin.id, {
        sessionId: origin.id,
        sessionCode: origin.code,
        businessDate: origin.businessDate,
        sessionAt: origin.requestDeadlineAt,
        origin: true,
        quantity: null,
      });
    }
    for (const source of sources) {
      if (!source.sessionId || source.kind === 'result_restored') continue;
      const session = sessionById.get(source.sessionId);
      if (!session) continue;
      const existing = sessions.get(session.id);
      sessions.set(session.id, {
        sessionId: session.id,
        sessionCode: session.code,
        businessDate: session.businessDate,
        sessionAt: session.requestDeadlineAt,
        origin: existing?.origin ?? false,
        quantity: (existing?.quantity ?? 0) + source.quantity,
      });
    }
    result.set(row.id, {
      displayStatus: display.status,
      displayDetail: display.detail,
      pendingDecisionQuantity,
      revokedQuantity: revokedById.get(row.id) ?? 0,
      legacyUnsourcedQuantity: legacyById.get(row.id) ?? 0,
      // The list is already limited to stores the actor may cancel for (Admin: every store).
      canCancel:
        row.status === 'active' || (row.status === 'fulfilled' && pendingDecisionQuantity > 0),
      sources: sources.map(({ waitTicketId: _ticket, ...source }) => source),
      sessions: [...sessions.values()].sort(
        (a, b) => Number(b.origin) - Number(a.origin) || a.sessionCode.localeCompare(b.sessionCode),
      ),
    });
  }
  return result;
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
        code: dailyPriorityOffers.code,
        businessDate: dailyPriorityOffers.businessDate,
        storeId: dailyPriorityOffers.storeId,
        productId: dailyPriorityOffers.productId,
        waitTicketId: dailyPriorityOffers.waitTicketId,
        priorityLevel: dailyPriorityOffers.priorityLevel,
        roundNumber: dailyPriorityOffers.roundNumber,
        offeredQuantity: dailyPriorityOffers.offeredQuantity,
        eligibleQuantityAtOffer: dailyPriorityOffers.eligibleQuantityAtOffer,
        orderSessionId: dailyPriorityOffers.orderSessionId,
        orderSessionCode: orderSessions.code,
        orderSessionKind: orderSessions.kind,
        acceptedQuantity: dailyPriorityOffers.acceptedQuantity,
        status: dailyPriorityOffers.status,
        responseDeadlineAt: dailyPriorityOffers.responseDeadlineAt,
        respondedAt: dailyPriorityOffers.respondedAt,
        createdAt: dailyPriorityOffers.createdAt,
        updatedAt: dailyPriorityOffers.updatedAt,
      })
      .from(dailyPriorityOffers)
      .leftJoin(orderSessions, eq(orderSessions.id, dailyPriorityOffers.orderSessionId))
      .where(predicate)
      .orderBy(desc(dailyPriorityOffers.createdAt), desc(dailyPriorityOffers.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);

  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows.map((row) => ({
      ...row,
      coverage: priorityOfferCoverage(row),
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
      code: waitTickets.code,
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
      cancellationKind: waitTickets.cancellationKind,
      cancelledByOfferId: waitTickets.cancelledByOfferId,
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
      code: dailyPriorityOffers.code,
      businessDate: dailyPriorityOffers.businessDate,
      storeId: dailyPriorityOffers.storeId,
      productId: dailyPriorityOffers.productId,
      waitTicketId: dailyPriorityOffers.waitTicketId,
      priorityLevel: dailyPriorityOffers.priorityLevel,
      roundNumber: dailyPriorityOffers.roundNumber,
      offeredQuantity: dailyPriorityOffers.offeredQuantity,
      eligibleQuantityAtOffer: dailyPriorityOffers.eligibleQuantityAtOffer,
      orderSessionId: dailyPriorityOffers.orderSessionId,
      orderSessionCode: orderSessions.code,
      orderSessionKind: orderSessions.kind,
      acceptedQuantity: dailyPriorityOffers.acceptedQuantity,
      status: dailyPriorityOffers.status,
      responseDeadlineAt: dailyPriorityOffers.responseDeadlineAt,
      respondedAt: dailyPriorityOffers.respondedAt,
      createdAt: dailyPriorityOffers.createdAt,
      updatedAt: dailyPriorityOffers.updatedAt,
    })
    .from(dailyPriorityOffers)
    .leftJoin(orderSessions, eq(orderSessions.id, dailyPriorityOffers.orderSessionId))
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
    coverage: priorityOfferCoverage(offer),
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
        cancellationKind: cancelled.cancellationKind,
        cancelledOfferIds: [...cancelled.cancelledOfferIds],
        cancelledQuantity: cancelled.cancelledQuantity,
        revokedQuantity: cancelled.revokedQuantity,
        revokedDecisionIds: [...cancelled.revokedDecisionIds],
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
    async (tx) => {
      const [ticket] = await tx
        .select({ storeId: waitTickets.storeId })
        .from(waitTickets)
        .where(and(eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)))
        .limit(1);
      if (!ticket) throw new WaitTicketNotFoundError();
      await assertActorMayCancelWaitTicket(tx, input.actorUserId, ticket.storeId);
    },
  );
}

/** One granted line of the ticket, classified for a cancellation. */
export interface WaitTicketCancellationLine {
  readonly allocationLineId: string;
  readonly reservationId: string;
  readonly allocationDecisionId: string | null;
  readonly decisionStatus: string | null;
  readonly decisionVersion: number | null;
  readonly decisionActionable: number | null;
  readonly sessionId: string;
  readonly sessionCode: string;
  readonly productId: string;
  readonly quantity: number;
  readonly shipmentNumber: string | null;
  readonly reshareOrderCode: string | null;
  readonly kind: 'REVOCABLE' | 'RESHARE_ORDER' | 'SHIPPED_OR_RECEIVED' | 'ACCEPTED_LEGACY';
}

export interface WaitTicketCancellationScope {
  readonly ticket: typeof waitTickets.$inferSelect;
  readonly offers: readonly (typeof dailyPriorityOffers.$inferSelect)[];
  readonly lines: readonly WaitTicketCancellationLine[];
  readonly plan: ReturnType<typeof planWaitTicketCancellation>;
  readonly fingerprint: string;
}

/**
 * Everything a cancellation of this ticket would touch, from the ticket's own lineage (allocation
 * lines naming it), never by product, date or store. Goods are revocable only while they sit in a
 * result still waiting for an answer, on hold, unshipped and without an RE order. Issued (RE),
 * shipped or received goods and holds of results accepted under the old rules are protected.
 * Contradicting evidence (an active hold with an RE source, a pending result whose shipment left)
 * refuses the cancellation instead of guessing.
 */
async function loadCancellationScope(
  reader: Database | Transaction,
  ticket: typeof waitTickets.$inferSelect,
  options: { readonly lock: boolean },
): Promise<WaitTicketCancellationScope> {
  const offerQuery = reader
    .select()
    .from(dailyPriorityOffers)
    .where(
      and(
        eq(dailyPriorityOffers.waitTicketId, ticket.id),
        livePriorityOfferCondition(),
        isNull(dailyPriorityOffers.deletedAt),
      ),
    )
    .orderBy(asc(dailyPriorityOffers.id));
  const offers = options.lock ? await offerQuery.for('update') : await offerQuery;
  const rows = await reader
    .select({
      allocationLineId: allocationLines.id,
      reservationId: reservations.id,
      reservationStatus: reservations.status,
      quantity: reservations.quantity,
      productId: reservations.productId,
      decisionId: allocationResultDecisions.id,
      decisionStatus: allocationResultDecisions.status,
      decisionVersion: allocationResultDecisions.version,
      granted: allocationResultDecisions.grantedQuantity,
      revoked: allocationResultDecisions.revokedQuantity,
      sessionId: allocationRuns.orderSessionId,
      sessionCode: orderSessions.code,
      shipmentNumber: outboundRequests.requestNumber,
      shipmentStatus: outboundRequests.status,
      reshareOrderCode: reshareOrders.code,
    })
    .from(allocationLines)
    .innerJoin(reservations, eq(reservations.allocationLineId, allocationLines.id))
    .innerJoin(allocationRuns, eq(allocationRuns.id, allocationLines.allocationRunId))
    .innerJoin(orderSessions, eq(orderSessions.id, allocationRuns.orderSessionId))
    .leftJoin(
      allocationResultDecisions,
      and(
        eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
        eq(allocationResultDecisions.storeId, allocationLines.storeId),
      ),
    )
    .leftJoin(outboundRequestLines, eq(outboundRequestLines.id, reservations.outboundRequestLineId))
    .leftJoin(outboundRequests, eq(outboundRequests.id, outboundRequestLines.outboundRequestId))
    .leftJoin(reshareOrderSources, eq(reshareOrderSources.reservationId, reservations.id))
    .leftJoin(reshareOrders, eq(reshareOrders.id, reshareOrderSources.reshareOrderId))
    .where(
      and(
        eq(allocationLines.waitTicketId, ticket.id),
        inArray(reservations.status, ['active', 'issued', 'consumed']),
        isNull(reservations.deletedAt),
      ),
    )
    .orderBy(asc(allocationLines.createdAt), asc(allocationLines.id), asc(reservations.id));
  const revocableByDecision = new Map<string, number>();
  const lines: WaitTicketCancellationLine[] = rows.map((row) => {
    let kind: WaitTicketCancellationLine['kind'];
    if (row.reservationStatus === 'issued' || row.reshareOrderCode !== null) {
      if (row.reservationStatus === 'active') {
        throw new WaitTicketConflictError(
          `WAIT_TICKET_INTEGRITY: hold ${row.reservationId} is active but has an RE order.`,
        );
      }
      kind = 'RESHARE_ORDER';
    } else if (row.reservationStatus === 'consumed') {
      kind = 'SHIPPED_OR_RECEIVED';
    } else if (row.decisionStatus === 'pending') {
      if (row.shipmentStatus !== null && row.shipmentStatus !== 'reserved') {
        throw new WaitTicketConflictError(
          `WAIT_TICKET_INTEGRITY: hold ${row.reservationId} of a pending result is on a ${row.shipmentStatus} shipment.`,
        );
      }
      kind = 'REVOCABLE';
      revocableByDecision.set(
        row.decisionId!,
        (revocableByDecision.get(row.decisionId!) ?? 0) + row.quantity,
      );
    } else if (row.shipmentStatus === 'dispatched' || row.shipmentStatus === 'received') {
      kind = 'SHIPPED_OR_RECEIVED';
    } else {
      kind = 'ACCEPTED_LEGACY';
    }
    return {
      allocationLineId: row.allocationLineId,
      reservationId: row.reservationId,
      allocationDecisionId: row.decisionId,
      decisionStatus: row.decisionStatus,
      decisionVersion: row.decisionVersion,
      decisionActionable: row.granted === null ? null : row.granted - (row.revoked ?? 0),
      sessionId: row.sessionId,
      sessionCode: row.sessionCode,
      productId: row.productId,
      quantity: row.quantity,
      shipmentNumber: row.shipmentNumber,
      reshareOrderCode: row.reshareOrderCode,
      kind,
    };
  });
  const revocableQuantity = lines
    .filter((line) => line.kind === 'REVOCABLE')
    .reduce((total, line) => total + line.quantity, 0);
  let plan: ReturnType<typeof planWaitTicketCancellation>;
  try {
    plan = planWaitTicketCancellation({
      status: ticket.status,
      originalQuantity: ticket.originalQuantity,
      remainingQuantity: ticket.remainingQuantity,
      fulfilledQuantity: ticket.fulfilledQuantity,
      revocableQuantity,
    });
  } catch (error: unknown) {
    throw new WaitTicketConflictError(
      `WAIT_TICKET_INTEGRITY: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        ticket: [ticket.id, ticket.status, ticket.remainingQuantity, ticket.fulfilledQuantity],
        offers: offers.map((offer) => [offer.id, offer.status, offer.stockHeldQuantity]),
        lines: lines.map((line) => [
          line.allocationLineId,
          line.reservationId,
          line.kind,
          line.quantity,
          line.allocationDecisionId,
          line.decisionVersion,
        ]),
      }),
    )
    .digest('hex');
  return { ticket, offers, lines, plan, fingerprint };
}

export interface WaitTicketCancelPreview {
  readonly waitTicketId: string;
  readonly code: string;
  readonly storeId: string;
  readonly productId: string;
  readonly scope: WaitTicketCancellationScope;
}

/**
 * Read only: what "Hủy phiếu chờ" would cancel, revoke and protect right now. The command
 * re-evaluates everything under its locks; the preview is never the deciding source.
 */
export async function previewWaitTicketCancellation(
  database: Database,
  input: { readonly actorUserId: string; readonly waitTicketId: string },
): Promise<WaitTicketCancelPreview> {
  return withTransaction(
    database,
    async (tx) => {
      const [ticket] = await tx
        .select()
        .from(waitTickets)
        .where(and(eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)))
        .limit(1);
      if (!ticket) throw new WaitTicketNotFoundError();
      try {
        await assertActorMayCancelWaitTicket(tx, input.actorUserId, ticket.storeId);
      } catch (error: unknown) {
        // Outside the actor's scope the ticket does not exist for it.
        if (error instanceof WaitTicketAuthorizationError) throw new WaitTicketNotFoundError();
        throw error;
      }
      const scope = await loadCancellationScope(tx, ticket, { lock: false });
      return {
        waitTicketId: ticket.id,
        code: ticket.code,
        storeId: ticket.storeId,
        productId: ticket.productId,
        scope,
      };
    },
    // No writes; not read-only only because authorization takes FOR SHARE row locks.
    { isolationLevel: 'repeatable read' },
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

  // Revoking result goods changes reservations: the stock-jobs lock comes first, as for every
  // answer and allocation run, so a cancellation never interleaves with a run or an answer.
  return withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, () =>
    withAdvisoryLock(tx, 'wait-ticket', input.waitTicketId, async () => {
      const [scopeRow] = await tx
        .select({ storeId: waitTickets.storeId, productId: waitTickets.productId })
        .from(waitTickets)
        .where(and(eq(waitTickets.id, input.waitTicketId), isNull(waitTickets.deletedAt)))
        .limit(1);
      if (!scopeRow) {
        throw new WaitTicketNotFoundError();
      }
      const actor = await assertActorMayCancelWaitTicket(tx, input.actorUserId, scopeRow.storeId);

      return withAdvisoryLock(
        tx,
        'store-product-wait',
        `${scopeRow.storeId}:${scopeRow.productId}`,
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
          if (ticket.storeId !== scopeRow.storeId || ticket.productId !== scopeRow.productId) {
            throw new WaitTicketConflictError('The wait ticket scope changed during cancellation.');
          }
          const scope = await loadCancellationScope(tx, ticket, { lock: true });
          if (!scope.plan.ok) {
            // A completed or already cancelled ticket is never rewritten; an exact retry of the
            // original command is answered by its idempotency record instead.
            throw new WaitTicketConflictError(
              scope.plan.reason === 'ALREADY_CANCELLED'
                ? 'The wait ticket is already cancelled.'
                : 'Nothing of this wait ticket can still be cancelled.',
            );
          }
          const revocable = scope.lines.filter((line) => line.kind === 'REVOCABLE');
          if (input.expectedFingerprint !== undefined) {
            if (input.expectedFingerprint !== scope.fingerprint) {
              throw new WaitTicketPreviewStaleError();
            }
          } else if (revocable.length > 0) {
            // Revoking allocation goods needs the confirmed preview (an older client cannot).
            throw new WaitTicketPreviewRequiredError();
          }

          const now = new Date();
          for (const offer of scope.offers) {
            if (offer.stockHeldQuantity > 0) {
              await releasePriorityOfferStock(tx, offer, now);
            }
          }
          const cancelledOfferIds = scope.offers.map((offer) => offer.id);
          if (cancelledOfferIds.length > 0) {
            const updatedOffers = await tx
              .update(dailyPriorityOffers)
              .set({
                status: 'cancelled',
                acceptedQuantity: 0,
                stockHeldQuantity: 0,
                respondedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  inArray(dailyPriorityOffers.id, cancelledOfferIds),
                  inArray(dailyPriorityOffers.status, ['offered', 'accepted']),
                ),
              )
              .returning({ id: dailyPriorityOffers.id });
            if (updatedOffers.length !== cancelledOfferIds.length) {
              throw new WaitTicketConflictError('A priority offer changed during cancellation.');
            }
          }

          // Granted bags of this ticket still waiting in results: revoked result by result, each
          // under its shipment lock and decision row lock (the order of every answer).
          const decisionIds = [
            ...new Set(revocable.map((line) => line.allocationDecisionId!)),
          ].sort();
          const revokedDecisions: JsonObject[] = [];
          for (const decisionId of decisionIds) {
            const expected = revocable.filter((line) => line.allocationDecisionId === decisionId);
            const [located] = await tx
              .select({
                allocationRunId: allocationResultDecisions.allocationRunId,
                storeId: allocationResultDecisions.storeId,
              })
              .from(allocationResultDecisions)
              .where(eq(allocationResultDecisions.id, decisionId))
              .limit(1);
            if (!located) throw new WaitTicketConflictError('A result of the ticket is missing.');
            const shipmentId = await findResultShipmentId(tx, located);
            const revoke = async () => {
              const [decision] = await tx
                .select()
                .from(allocationResultDecisions)
                .where(eq(allocationResultDecisions.id, decisionId))
                .for('update')
                .limit(1);
              if (!decision || decision.status !== 'pending') {
                throw new WaitTicketConflictError('A result of the ticket changed meanwhile.');
              }
              const [shipment] = shipmentId
                ? await tx
                    .select()
                    .from(outboundRequests)
                    .where(eq(outboundRequests.id, shipmentId))
                    .for('update')
                    .limit(1)
                : [];
              const holds = await lockActionableHolds(tx, decision, { waitTicketId: ticket.id });
              const holdIds = holds.map((hold) => hold.reservation.id).sort();
              const expectedIds = expected.map((line) => line.reservationId).sort();
              if (JSON.stringify(holdIds) !== JSON.stringify(expectedIds)) {
                throw new WaitTicketConflictError(
                  'Holds of the ticket changed during cancellation.',
                );
              }
              const revoked = await revokeResultHoldsInTransaction(tx, {
                decision,
                shipment: shipment ?? null,
                holds,
                kind: 'wait_ticket_cancelled',
                actor: { id: actor.id, role: revocationRole(actor.role) },
                requestId: input.requestId ?? null,
                occurredAt: now,
              });
              revokedDecisions.push({
                allocationDecisionId: decisionId,
                revokedQuantity: revoked.releasedQuantity,
                status: revoked.decision.status,
                version: revoked.decision.version,
                cancelledOutboundRequestId: revoked.cancelledOutboundRequestId,
              });
            };
            if (shipmentId) {
              await withAdvisoryLock(tx, 'warehouse-outbound', shipmentId, revoke);
            } else {
              await revoke();
            }
          }

          const cancellationKind: WaitTicketCancellationKind =
            actor.role === 'admin'
              ? 'admin_cancelled'
              : actor.role === 'htkd'
                ? 'htkd_cancelled'
                : 'store_cancelled';
          const plan = scope.plan;
          const [updated] = await tx
            .update(waitTickets)
            .set({
              status: 'cancelled',
              // remaining keeps the cancelled demand: what waited plus the revoked grants;
              // fulfilled keeps only grants protected by an RE order, shipment or legacy rule.
              remainingQuantity: plan.remainingAfter,
              fulfilledQuantity: plan.fulfilledAfter,
              resolvedAt: now,
              resolutionReason: normalizedReason,
              cancellationKind,
              updatedAt: now,
            })
            .where(
              and(
                eq(waitTickets.id, ticket.id),
                inArray(waitTickets.status, ['active', 'fulfilled']),
              ),
            )
            .returning({ id: waitTickets.id });
          if (!updated) {
            throw new WaitTicketConflictError('The wait ticket changed during cancellation.');
          }

          const revokedQuantity = revocable.reduce((total, line) => total + line.quantity, 0);
          await tx.insert(auditLogs).values({
            requestId: input.requestId ?? null,
            actorUserId: actor.id,
            actorRole: actor.role,
            actorStoreId: ticket.storeId,
            action:
              actor.role === 'admin'
                ? 'WAIT_TICKET_ADMIN_CANCELLED'
                : actor.role === 'htkd'
                  ? 'WAIT_TICKET_HTKD_CANCELLED'
                  : 'WAIT_TICKET_STORE_CANCELLED',
            entityType: 'wait_ticket',
            entityId: ticket.id,
            before: waitTicketAuditSnapshot(ticket),
            after: {
              ...waitTicketAuditSnapshot(ticket),
              status: 'cancelled',
              remainingQuantity: plan.remainingAfter,
              fulfilledQuantity: plan.fulfilledAfter,
              resolvedAt: now.toISOString(),
              resolutionReason: normalizedReason,
              cancellationKind,
            },
            metadata: {
              cancellationKind,
              cancelledOfferIds,
              cancelledQuantity: plan.cancelledQuantity,
              waitingQuantity: ticket.remainingQuantity,
              revokedQuantity,
              revokedDecisions,
              retainedFulfilledQuantity: plan.fulfilledAfter,
              protected: scope.lines
                .filter((line) => line.kind !== 'REVOCABLE')
                .map((line) => ({
                  allocationLineId: line.allocationLineId,
                  kind: line.kind,
                  quantity: line.quantity,
                  reshareOrderCode: line.reshareOrderCode,
                })),
              fingerprint: scope.fingerprint,
            },
          });

          if (scope.offers.length > 0) {
            await tx.insert(auditLogs).values(
              scope.offers.map((offer) => ({
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
                  stockHeldQuantity: 0,
                  respondedAt: now.toISOString(),
                },
                metadata: {
                  waitTicketId: ticket.id,
                  orderSessionId: offer.orderSessionId,
                  previousStatus: offer.status,
                  releasedHoldQuantity: offer.stockHeldQuantity,
                },
              })),
            );
          }

          return {
            waitTicketId: ticket.id,
            status: 'cancelled',
            cancellationKind,
            cancelledOfferIds,
            cancelledQuantity: plan.cancelledQuantity,
            revokedQuantity,
            revokedDecisionIds: decisionIds,
            resolvedAt: now,
          };
        },
      );
    }),
  );
}

function revocationRole(role: DatabaseUserRole): RevocationActorRole {
  if (role === 'admin' || role === 'htkd' || role === 'store' || role === 'wholesale') return role;
  throw new WaitTicketAuthorizationError();
}

/**
 * Whether an offer proves the store was offered everything it was still waiting for.
 *
 * The basis is the quantity recorded when the offer was created, never the stock at the deadline.
 * A legacy offer without a basis, or a ticket whose demand grew beyond the offer afterwards, is
 * partial: the policy cancels a ticket only when the offer is proven to cover all of it.
 */
export function priorityOfferCoverage(
  offer: { readonly offeredQuantity: number; readonly eligibleQuantityAtOffer: number | null },
  ticketRemainingQuantity?: number,
): PriorityOfferCoverage {
  if (offer.eligibleQuantityAtOffer === null) return 'partial';
  if (offer.offeredQuantity < offer.eligibleQuantityAtOffer) return 'partial';
  if (ticketRemainingQuantity !== undefined && ticketRemainingQuantity > offer.offeredQuantity) {
    return 'partial';
  }
  return 'full';
}

export interface CancelWaitTicketForFullOfferInput {
  /** Locked by the caller (FOR UPDATE) in this transaction. */
  readonly ticket: typeof waitTickets.$inferSelect;
  /** The offer as it was before it was declined or expired. */
  readonly offer: typeof dailyPriorityOffers.$inferSelect;
  readonly kind: 'full_offer_declined' | 'full_offer_timeout';
  readonly actor: {
    readonly id: string;
    readonly role: DatabaseUserRole;
  } | null;
  readonly occurredAt: Date;
  readonly requestId?: string | null;
  readonly auditId?: string;
}

/**
 * Shared by the API (decline, late answer) and the worker (deadline): cancels the ticket of a
 * declined or unanswered full offer in the caller's transaction. The caller has already moved the
 * offer to declined/expired and returned its hold. Returns false, changing nothing, when the
 * ticket is no longer active or the offer cannot be proven to cover its whole demand.
 */
export async function cancelWaitTicketForFullOfferInTransaction(
  tx: Transaction,
  input: CancelWaitTicketForFullOfferInput,
): Promise<boolean> {
  const { ticket, offer } = input;
  if (ticket.id !== offer.waitTicketId) {
    throw new PriorityOfferConflictError('The priority offer does not belong to the wait ticket.');
  }
  if (ticket.status !== 'active') return false;
  if (priorityOfferCoverage(offer, ticket.remainingQuantity) !== 'full') return false;
  // Another live claim on the same ticket means this offer no longer stands for the whole demand.
  const [otherLive] = await tx
    .select({ id: dailyPriorityOffers.id })
    .from(dailyPriorityOffers)
    .where(
      and(
        eq(dailyPriorityOffers.waitTicketId, ticket.id),
        livePriorityOfferCondition(),
        isNull(dailyPriorityOffers.deletedAt),
      ),
    )
    .limit(1);
  if (otherLive && otherLive.id !== offer.id) return false;

  const reason =
    input.kind === 'full_offer_declined'
      ? 'Cửa hàng từ chối đề nghị nhận đủ toàn bộ hàng đang chờ'
      : 'Quá hạn phản hồi đề nghị nhận đủ toàn bộ hàng đang chờ';
  const [updated] = await tx
    .update(waitTickets)
    .set({
      status: 'cancelled',
      resolvedAt: input.occurredAt,
      resolutionReason: reason,
      cancellationKind: input.kind,
      cancelledByOfferId: offer.id,
      updatedAt: input.occurredAt,
    })
    .where(and(eq(waitTickets.id, ticket.id), eq(waitTickets.status, 'active')))
    .returning({ id: waitTickets.id });
  if (!updated) return false;

  await tx.insert(auditLogs).values({
    ...(input.auditId ? { id: input.auditId } : {}),
    requestId: input.requestId ?? null,
    actorUserId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? null,
    actorStoreId: ticket.storeId,
    action:
      input.kind === 'full_offer_declined'
        ? 'WAIT_TICKET_STORE_DECLINED_FULL_PRIORITY'
        : 'WAIT_TICKET_PRIORITY_RESPONSE_TIMEOUT',
    entityType: 'wait_ticket',
    entityId: ticket.id,
    before: waitTicketAuditSnapshot(ticket),
    after: {
      ...waitTicketAuditSnapshot(ticket),
      status: 'cancelled',
      resolvedAt: input.occurredAt.toISOString(),
      resolutionReason: reason,
      cancellationKind: input.kind,
    },
    metadata: {
      cancellationKind: input.kind,
      offerId: offer.id,
      orderSessionId: offer.orderSessionId,
      responseDeadlineAt: offer.responseDeadlineAt.toISOString(),
      basis: {
        offeredQuantity: offer.offeredQuantity,
        eligibleQuantityAtOffer: offer.eligibleQuantityAtOffer,
        ticketRemainingQuantity: ticket.remainingQuantity,
      },
    },
    createdAt: input.occurredAt,
  });
  return true;
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
        waitTicketCancelled: responded.waitTicketCancelled,
      };
      return {
        value: responded,
        responseStatus: 200,
        responseBody,
        resourceType: 'priority_offer',
        resourceId: responded.offerId,
      };
    },
    async (tx) => {
      const [offer] = await tx
        .select({ storeId: dailyPriorityOffers.storeId })
        .from(dailyPriorityOffers)
        .where(
          and(eq(dailyPriorityOffers.id, input.offerId), isNull(dailyPriorityOffers.deletedAt)),
        )
        .limit(1);
      if (!offer) throw new PriorityOfferNotFoundError();
      if (input.actorUserId !== null) {
        const actor = await assertActorMayAccessStore(tx, input.actorUserId, offer.storeId);
        if (input.action !== 'expire' && !['store', 'htkd', 'wholesale'].includes(actor.role))
          throw new WaitTicketAuthorizationError();
      } else if (input.action !== 'expire') throw new WaitTicketAuthorizationError();
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
    if (
      input.action !== 'expire' &&
      actor?.role !== 'store' &&
      actor?.role !== 'htkd' &&
      actor?.role !== 'wholesale'
    ) {
      throw new WaitTicketAuthorizationError();
    }

    return withAdvisoryLock(
      tx,
      'store-product-wait',
      `${scope.storeId}:${scope.productId}`,
      async () => {
        const [ticket] = await tx
          .select()
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

        if (transition.status !== 'accepted' && offer.stockHeldQuantity > 0) {
          await releasePriorityOfferStock(tx, offer, respondedAt);
        }

        const [updated] = await tx
          .update(dailyPriorityOffers)
          .set({
            status: transition.status,
            acceptedQuantity: transition.acceptedQuantity,
            stockHeldQuantity: transition.status === 'accepted' ? offer.stockHeldQuantity : 0,
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
        const coverage = priorityOfferCoverage(offer, ticket.remainingQuantity);
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
            stockHeldQuantity: transition.status === 'accepted' ? offer.stockHeldQuantity : 0,
            respondedAt: respondedAt.toISOString(),
          },
          metadata: {
            requestedAction: input.action,
            effectiveAction: transition.effectiveAction,
            reason,
            orderSessionId: offer.orderSessionId,
            coverage,
            eligibleQuantityAtOffer: offer.eligibleQuantityAtOffer,
            ticketRemainingQuantity: ticket.remainingQuantity,
          },
        });

        // Declining or letting a full offer lapse ends the wait in this same transaction; a
        // partial offer only gives its quantity back and the ticket keeps waiting.
        const waitTicketCancelled =
          transition.status === 'declined' || transition.status === 'expired'
            ? await cancelWaitTicketForFullOfferInTransaction(tx, {
                ticket,
                offer,
                kind:
                  transition.status === 'declined' ? 'full_offer_declined' : 'full_offer_timeout',
                actor: actor ? { id: actor.id, role: actor.role } : null,
                occurredAt: respondedAt,
                requestId: input.requestId ?? null,
              })
            : false;

        return {
          offerId: offer.id,
          waitTicketId: offer.waitTicketId,
          status: transition.status,
          acceptedQuantity: transition.acceptedQuantity,
          effectiveAction: transition.effectiveAction,
          respondedAt,
          waitTicketCancelled,
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
  } else if (actor.role === 'wholesale') {
    const wholesaleStores = await database
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(eq(stores.kind, 'wholesale'), eq(stores.isActive, true), isNull(stores.deletedAt)),
      );
    accessibleStoreIds = wholesaleStores.map((store) => store.id);
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
    .select({ id: stores.id, kind: stores.kind })
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
  if (
    actor.role === 'admin' ||
    (actor.role === 'store' && actor.storeId === storeId) ||
    (actor.role === 'wholesale' && store.kind === 'wholesale')
  ) {
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

/**
 * Cancelling a wait is a store decision: the store (or wholesale account) for its own store and
 * an Admin for every store, including an inactive one whose stale demand must still be closable.
 * HTKD may cancel active waits of currently assigned, active stores with its own audit identity.
 */
async function assertActorMayCancelWaitTicket(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<ActiveActor> {
  const [actor] = await tx
    .select({ id: users.id, role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
    .for('share')
    .limit(1);
  if (!actor || actor.status !== 'active') {
    throw new WaitTicketAuthorizationError();
  }
  const [store] = await tx
    .select({ id: stores.id, kind: stores.kind, isActive: stores.isActive })
    .from(stores)
    .where(and(eq(stores.id, storeId), isNull(stores.deletedAt)))
    .for('share')
    .limit(1);
  if (!store) {
    throw new WaitTicketAuthorizationError();
  }
  if (actor.role === 'admin') return actor;
  if (!store.isActive) throw new WaitTicketAuthorizationError();
  if (actor.role === 'store' && actor.storeId === storeId) return actor;
  if (actor.role === 'wholesale' && store.kind === 'wholesale') return actor;
  if (actor.role === 'htkd') return assertActorMayAccessStore(tx, actorUserId, storeId);
  throw new WaitTicketAuthorizationError();
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
    cancellationKind: ticket.cancellationKind,
  };
}

function priorityOfferAuditSnapshot(offer: typeof dailyPriorityOffers.$inferSelect): JsonObject {
  return {
    waitTicketId: offer.waitTicketId,
    status: offer.status,
    orderSessionId: offer.orderSessionId,
    offeredQuantity: offer.offeredQuantity,
    eligibleQuantityAtOffer: offer.eligibleQuantityAtOffer,
    stockHeldQuantity: offer.stockHeldQuantity,
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

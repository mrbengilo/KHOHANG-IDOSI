import { createHash } from 'node:crypto';

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
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  allocationLines,
  allocationResultDecisions,
  dailyPriorityOffers,
  orderSessions,
  products,
  reservations,
  reshareOrders,
  storeReceipts,
  stores,
  storeWaitDocumentEvents,
  storeWaitDocumentLines,
  storeWaitDocumentMembers,
  storeWaitDocuments,
  waitTickets,
  type DatabaseUserRole,
  type JsonObject,
  type StoreWaitDocumentDatabaseStatus,
  type StoreWaitDocumentEventKind,
} from './schema.js';
import {
  loadStoreWaitLiveTickets,
  reconcileStoreWaitDocumentsInTransaction,
  type StoreWaitLiveTicket,
} from './store-wait-documents.js';
import { STOCK_JOBS_LOCK } from './allocation-decisions.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';
import {
  assertActorMayCancelWaitTicket,
  cancelWaitTicketInTransaction,
  loadCancellationScope,
  resolveAccessibleStoreIds,
  WaitTicketAuthorizationError,
  WaitTicketConflictError,
  WaitTicketPreviewStaleError,
  WaitTicketValidationError,
  type WaitTicketCancellationScope,
} from './wait-ticket-operations.js';

/**
 * Read model and whole-document cancellation of the store wait document ("phiếu chờ",
 * docs/store-active-wait-document.md). Scope is resolved from the database on every call
 * (Admin: every store; HTKD: live assignments to active stores; store: its own active store;
 * wholesale desk: active wholesale stores) and applied before counting, paging and enrichment.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type StoreWaitDocumentView = 'ACTIVE' | 'HISTORY' | 'ALL';

export class StoreWaitDocumentNotFoundError extends Error {
  public readonly code = 'WAIT_DOCUMENT_NOT_FOUND';

  public constructor() {
    super('The wait document does not exist or is unavailable.');
    this.name = 'StoreWaitDocumentNotFoundError';
  }
}

/** A command named a document that is no longer the store's current one. */
export class StoreWaitDocumentSupersededError extends Error {
  public readonly code = 'WAIT_DOCUMENT_SUPERSEDED';

  public constructor(public readonly currentDocumentId: string | null) {
    super('The wait document was already processed; open the current document instead.');
    this.name = 'StoreWaitDocumentSupersededError';
  }
}

export interface ListStoreWaitDocumentsInput {
  readonly actorUserId: string;
  readonly view?: StoreWaitDocumentView;
  readonly status?: StoreWaitDocumentDatabaseStatus;
  readonly storeId?: string;
  readonly productId?: string;
  /** Document code, ticket code (PC), priority offer code (PUT), product name or SKU. */
  readonly q?: string;
  /** Inclusive Vietnam calendar dates of the opening. */
  readonly openedFrom?: string;
  readonly openedTo?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface StoreWaitDocumentEventRecord {
  readonly id: string;
  readonly kind: StoreWaitDocumentEventKind;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRole: DatabaseUserRole | null;
  readonly actorDisplayName: string | null;
  readonly reason: string | null;
  readonly orderSessionId: string | null;
  readonly orderSessionCode: string | null;
  readonly allocationRunId: string | null;
  readonly allocationDecisionId: string | null;
  readonly reshareOrderCode: string | null;
  readonly waitTicketId: string | null;
  readonly waitTicketCode: string | null;
  readonly priorityOfferId: string | null;
  readonly priorityOfferCode: string | null;
  readonly storeReceiptId: string | null;
  readonly storeReceiptNumber: string | null;
  readonly metadata: JsonObject;
}

export interface StoreWaitDocumentLineRecord {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly unit: string;
  readonly carriedInQuantity: number;
  readonly addedQuantity: number;
  readonly openingRemainingQuantity: number;
  readonly openingPendingQuantity: number;
  readonly confirmedQuantity: number | null;
  readonly cancelledQuantity: number | null;
  readonly adjustedQuantity: number | null;
  readonly carriedOutQuantity: number | null;
  /** Live split of a current document (null once it closed). */
  readonly remainingQuantity: number | null;
  readonly pendingQuantity: number | null;
}

export interface StoreWaitDocumentLinkRecord {
  readonly id: string;
  readonly code: string;
}

export interface StoreWaitDocumentRecord {
  readonly id: string;
  readonly code: string;
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly status: StoreWaitDocumentDatabaseStatus;
  readonly version: number;
  readonly chainId: string;
  readonly chainSequence: number;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly waitingSince: Date;
  readonly predecessor: StoreWaitDocumentLinkRecord | null;
  readonly successor: StoreWaitDocumentLinkRecord | null;
  readonly openedEvent: StoreWaitDocumentEventRecord;
  readonly closedEvent: StoreWaitDocumentEventRecord | null;
  readonly lines: readonly StoreWaitDocumentLineRecord[];
}

export interface StoreWaitDocumentPage {
  readonly data: readonly StoreWaitDocumentRecord[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export interface StoreWaitDocumentMemberRecord {
  readonly waitTicketId: string;
  readonly code: string;
  readonly productId: string;
  readonly status: string;
  readonly originalQuantity: number;
  readonly remainingQuantity: number;
  readonly fulfilledQuantity: number;
  readonly queuedAt: Date;
  readonly cancellationKind: string | null;
}

export interface StoreWaitDocumentPendingResultRecord {
  readonly allocationDecisionId: string;
  readonly decisionVersion: number;
  readonly orderSessionId: string;
  readonly orderSessionCode: string;
  readonly productId: string;
  readonly quantity: number;
}

export interface StoreWaitDocumentChainRecord {
  readonly id: string;
  readonly code: string;
  readonly status: StoreWaitDocumentDatabaseStatus;
  readonly chainSequence: number;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly openedEventKind: StoreWaitDocumentEventKind;
  readonly closedEventKind: StoreWaitDocumentEventKind | null;
}

export interface StoreWaitDocumentDetail extends StoreWaitDocumentRecord {
  readonly members: readonly StoreWaitDocumentMemberRecord[];
  readonly pendingResults: readonly StoreWaitDocumentPendingResultRecord[];
  readonly chain: readonly StoreWaitDocumentChainRecord[];
  /** The store's current document, so a processed document links to where its demand went. */
  readonly currentDocument: StoreWaitDocumentLinkRecord | null;
}

function normalizePage(input: { page?: number; pageSize?: number }) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new WaitTicketValidationError('page must be a positive integer.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new WaitTicketValidationError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize };
}

function vietnamDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

export async function listStoreWaitDocuments(
  database: Database,
  input: ListStoreWaitDocumentsInput,
): Promise<StoreWaitDocumentPage> {
  const pagination = normalizePage(input);
  const accessible = await resolveAccessibleStoreIds(database, input.actorUserId, input.storeId);
  const empty = (totalItems: number): StoreWaitDocumentPage => ({
    data: [],
    pagination: {
      ...pagination,
      totalItems,
      totalPages: Math.ceil(totalItems / pagination.pageSize),
    },
  });
  if (accessible !== null && accessible.length === 0) return empty(0);

  const view = input.view ?? 'ACTIVE';
  const conditions: SQL[] = [];
  if (accessible !== null) conditions.push(inArray(storeWaitDocuments.storeId, [...accessible]));
  if (input.status !== undefined) conditions.push(eq(storeWaitDocuments.status, input.status));
  else if (view === 'ACTIVE') conditions.push(eq(storeWaitDocuments.status, 'current'));
  else if (view === 'HISTORY') conditions.push(ne(storeWaitDocuments.status, 'current'));
  if (input.productId !== undefined) {
    conditions.push(
      exists(
        database
          .select({ id: storeWaitDocumentLines.id })
          .from(storeWaitDocumentLines)
          .where(
            and(
              eq(storeWaitDocumentLines.documentId, storeWaitDocuments.id),
              eq(storeWaitDocumentLines.productId, input.productId),
            ),
          ),
      ),
    );
  }
  if (input.openedFrom) {
    conditions.push(gte(storeWaitDocuments.openedAt, vietnamDayStart(input.openedFrom)));
  }
  if (input.openedTo) {
    conditions.push(
      lt(
        storeWaitDocuments.openedAt,
        new Date(vietnamDayStart(input.openedTo).getTime() + 86_400_000),
      ),
    );
  }
  const q = input.q?.trim();
  if (q) {
    const search = `%${escapeLike(q)}%`;
    conditions.push(
      or(
        ilike(storeWaitDocuments.code, search),
        exists(
          database
            .select({ id: storeWaitDocumentMembers.waitTicketId })
            .from(storeWaitDocumentMembers)
            .innerJoin(waitTickets, eq(waitTickets.id, storeWaitDocumentMembers.waitTicketId))
            .where(
              and(
                eq(storeWaitDocumentMembers.documentId, storeWaitDocuments.id),
                or(
                  ilike(waitTickets.code, search),
                  exists(
                    database
                      .select({ id: dailyPriorityOffers.id })
                      .from(dailyPriorityOffers)
                      .where(
                        and(
                          eq(dailyPriorityOffers.waitTicketId, waitTickets.id),
                          ilike(dailyPriorityOffers.code, search),
                        ),
                      ),
                  ),
                ),
              ),
            ),
        ),
        exists(
          database
            .select({ id: storeWaitDocumentLines.id })
            .from(storeWaitDocumentLines)
            .innerJoin(products, eq(products.id, storeWaitDocumentLines.productId))
            .where(
              and(
                eq(storeWaitDocumentLines.documentId, storeWaitDocuments.id),
                or(ilike(products.name, search), ilike(products.sku, search)),
              ),
            ),
        ),
      )!,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Count, page and enrichment read one snapshot, so totals, rows and lines always agree.
  return database.transaction(
    async (tx) => {
      const [total] = await tx.select({ value: count() }).from(storeWaitDocuments).where(where);
      const totalItems = total?.value ?? 0;
      const order =
        view === 'ACTIVE' && input.status === undefined
          ? [asc(stores.code), asc(storeWaitDocuments.id)]
          : [desc(storeWaitDocuments.openedAt), desc(storeWaitDocuments.id)];
      const headers = await tx
        .select({ id: storeWaitDocuments.id })
        .from(storeWaitDocuments)
        .innerJoin(stores, eq(stores.id, storeWaitDocuments.storeId))
        .where(where)
        .orderBy(...order)
        .limit(pagination.pageSize)
        .offset((pagination.page - 1) * pagination.pageSize);
      if (headers.length === 0) return empty(totalItems);
      const records = await loadDocumentRecords(
        tx,
        headers.map((row) => row.id),
      );
      return {
        data: records,
        pagination: {
          ...pagination,
          totalItems,
          totalPages: Math.ceil(totalItems / pagination.pageSize),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

type Reader = Pick<Transaction, 'select' | 'execute' | 'selectDistinct'>;

/** Full records of the given documents, in the given order, with a fixed number of queries. */
async function loadDocumentRecords(
  reader: Reader,
  ids: readonly string[],
): Promise<StoreWaitDocumentRecord[]> {
  const successorDocuments = alias(storeWaitDocuments, 'successor_documents');
  const predecessorDocuments = alias(storeWaitDocuments, 'predecessor_documents');
  const rows = await reader
    .select({
      document: storeWaitDocuments,
      storeCode: stores.code,
      storeName: stores.name,
      predecessorCode: predecessorDocuments.code,
      successorId: successorDocuments.id,
      successorCode: successorDocuments.code,
    })
    .from(storeWaitDocuments)
    .innerJoin(stores, eq(stores.id, storeWaitDocuments.storeId))
    .leftJoin(predecessorDocuments, eq(predecessorDocuments.id, storeWaitDocuments.predecessorId))
    .leftJoin(successorDocuments, eq(successorDocuments.predecessorId, storeWaitDocuments.id))
    .where(inArray(storeWaitDocuments.id, [...ids]));
  const lines = await reader
    .select({
      documentId: storeWaitDocumentLines.documentId,
      productId: storeWaitDocumentLines.productId,
      sku: products.sku,
      productName: products.name,
      unit: products.unit,
      carriedInQuantity: storeWaitDocumentLines.carriedInQuantity,
      addedQuantity: storeWaitDocumentLines.addedQuantity,
      openingRemainingQuantity: storeWaitDocumentLines.openingRemainingQuantity,
      openingPendingQuantity: storeWaitDocumentLines.openingPendingQuantity,
      confirmedQuantity: storeWaitDocumentLines.confirmedQuantity,
      cancelledQuantity: storeWaitDocumentLines.cancelledQuantity,
      adjustedQuantity: storeWaitDocumentLines.adjustedQuantity,
      carriedOutQuantity: storeWaitDocumentLines.carriedOutQuantity,
    })
    .from(storeWaitDocumentLines)
    .innerJoin(products, eq(products.id, storeWaitDocumentLines.productId))
    .where(inArray(storeWaitDocumentLines.documentId, [...ids]))
    .orderBy(asc(products.displayOrder), asc(products.sku), asc(products.id));
  const eventIds = rows.flatMap((row) =>
    row.document.closedEventId
      ? [row.document.openedEventId, row.document.closedEventId]
      : [row.document.openedEventId],
  );
  const events = await loadEvents(reader, eventIds);
  const currentStoreIds = [
    ...new Set(
      rows.filter((row) => row.document.status === 'current').map((row) => row.document.storeId),
    ),
  ];
  const live = await loadStoreWaitLiveTickets(reader, currentStoreIds);
  const liveByStoreProduct = new Map<string, { remaining: number; pending: number }>();
  for (const ticket of live) {
    const key = `${ticket.storeId}:${ticket.productId}`;
    const total = liveByStoreProduct.get(key) ?? { remaining: 0, pending: 0 };
    total.remaining += ticket.remainingQuantity;
    total.pending += ticket.pendingQuantity;
    liveByStoreProduct.set(key, total);
  }
  const byId = new Map(
    rows.map((row) => {
      const document = row.document;
      const current = document.status === 'current';
      const record: StoreWaitDocumentRecord = {
        id: document.id,
        code: document.code,
        storeId: document.storeId,
        storeCode: row.storeCode,
        storeName: row.storeName,
        status: document.status,
        version: document.version,
        chainId: document.chainId,
        chainSequence: document.chainSequence,
        openedAt: document.openedAt,
        closedAt: document.closedAt,
        waitingSince: document.waitingSince,
        predecessor:
          document.predecessorId && row.predecessorCode
            ? { id: document.predecessorId, code: row.predecessorCode }
            : null,
        successor:
          row.successorId && row.successorCode
            ? { id: row.successorId, code: row.successorCode }
            : null,
        openedEvent: events.get(document.openedEventId)!,
        closedEvent: document.closedEventId ? (events.get(document.closedEventId) ?? null) : null,
        lines: lines
          .filter((line) => line.documentId === document.id)
          .map(({ documentId: _documentId, ...line }) => {
            const now = current
              ? liveByStoreProduct.get(`${document.storeId}:${line.productId}`)
              : null;
            return {
              ...line,
              remainingQuantity: current ? (now?.remaining ?? 0) : null,
              pendingQuantity: current ? (now?.pending ?? 0) : null,
            };
          }),
      };
      return [document.id, record] as const;
    }),
  );
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });
}

async function loadEvents(
  reader: Reader,
  ids: readonly string[],
): Promise<Map<string, StoreWaitDocumentEventRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await reader
    .select({
      event: storeWaitDocumentEvents,
      orderSessionCode: orderSessions.code,
      waitTicketCode: waitTickets.code,
      priorityOfferCode: dailyPriorityOffers.code,
      storeReceiptNumber: storeReceipts.receiptNumber,
      reshareOrderCode: reshareOrders.code,
    })
    .from(storeWaitDocumentEvents)
    .leftJoin(orderSessions, eq(orderSessions.id, storeWaitDocumentEvents.orderSessionId))
    .leftJoin(waitTickets, eq(waitTickets.id, storeWaitDocumentEvents.waitTicketId))
    .leftJoin(
      dailyPriorityOffers,
      eq(dailyPriorityOffers.id, storeWaitDocumentEvents.priorityOfferId),
    )
    .leftJoin(storeReceipts, eq(storeReceipts.id, storeWaitDocumentEvents.storeReceiptId))
    .leftJoin(
      reshareOrders,
      eq(reshareOrders.allocationDecisionId, storeWaitDocumentEvents.allocationDecisionId),
    )
    .where(inArray(storeWaitDocumentEvents.id, [...new Set(ids)]));
  return new Map(
    rows.map(({ event, ...joined }) => [
      event.id,
      {
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        actorRole: event.actorRole,
        actorDisplayName: event.actorDisplayName,
        reason: event.reason,
        orderSessionId: event.orderSessionId,
        orderSessionCode: joined.orderSessionCode,
        allocationRunId: event.allocationRunId,
        allocationDecisionId: event.allocationDecisionId,
        reshareOrderCode: event.kind === 'result_accepted' ? joined.reshareOrderCode : null,
        waitTicketId: event.waitTicketId,
        waitTicketCode: joined.waitTicketCode,
        priorityOfferId: event.priorityOfferId,
        priorityOfferCode: joined.priorityOfferCode,
        storeReceiptId: event.storeReceiptId,
        storeReceiptNumber: joined.storeReceiptNumber,
        metadata: event.metadata,
      },
    ]),
  );
}

/**
 * One document with its tickets, the PENDING results still holding its goods (current document
 * only), its whole chain and the store's current document. Outside the actor's scope a document
 * does not exist (404), so existence never leaks.
 */
export async function getStoreWaitDocument(
  database: Database,
  input: { readonly actorUserId: string; readonly documentId: string },
): Promise<StoreWaitDocumentDetail> {
  const [located] = await database
    .select({ storeId: storeWaitDocuments.storeId })
    .from(storeWaitDocuments)
    .where(eq(storeWaitDocuments.id, input.documentId))
    .limit(1);
  if (!located) throw new StoreWaitDocumentNotFoundError();
  try {
    await resolveAccessibleStoreIds(database, input.actorUserId, located.storeId);
  } catch (error: unknown) {
    if (error instanceof WaitTicketAuthorizationError) throw new StoreWaitDocumentNotFoundError();
    throw error;
  }
  return database.transaction(
    async (tx) => {
      const [record] = await loadDocumentRecords(tx, [input.documentId]);
      if (!record) throw new StoreWaitDocumentNotFoundError();
      const members = await tx
        .select({
          waitTicketId: waitTickets.id,
          code: waitTickets.code,
          productId: waitTickets.productId,
          status: waitTickets.status,
          originalQuantity: waitTickets.originalQuantity,
          remainingQuantity: waitTickets.remainingQuantity,
          fulfilledQuantity: waitTickets.fulfilledQuantity,
          queuedAt: waitTickets.queuedAt,
          cancellationKind: waitTickets.cancellationKind,
        })
        .from(storeWaitDocumentMembers)
        .innerJoin(waitTickets, eq(waitTickets.id, storeWaitDocumentMembers.waitTicketId))
        .where(eq(storeWaitDocumentMembers.documentId, record.id))
        .orderBy(asc(waitTickets.queuedAt), asc(waitTickets.id));
      const pendingResults =
        record.status === 'current'
          ? await tx
              .select({
                allocationDecisionId: allocationResultDecisions.id,
                decisionVersion: allocationResultDecisions.version,
                orderSessionId: allocationResultDecisions.orderSessionId,
                orderSessionCode: orderSessions.code,
                productId: allocationLines.productId,
                quantity: sql<number>`sum(${reservations.quantity})`.mapWith(Number),
              })
              .from(allocationResultDecisions)
              .innerJoin(
                allocationLines,
                and(
                  eq(allocationLines.allocationRunId, allocationResultDecisions.allocationRunId),
                  eq(allocationLines.storeId, allocationResultDecisions.storeId),
                  sql`${allocationLines.waitTicketId} IS NOT NULL`,
                ),
              )
              .innerJoin(
                reservations,
                and(
                  eq(reservations.allocationLineId, allocationLines.id),
                  eq(reservations.status, 'active'),
                  sql`${reservations.deletedAt} IS NULL`,
                ),
              )
              .innerJoin(
                orderSessions,
                eq(orderSessions.id, allocationResultDecisions.orderSessionId),
              )
              .where(
                and(
                  eq(allocationResultDecisions.storeId, record.storeId),
                  eq(allocationResultDecisions.status, 'pending'),
                ),
              )
              .groupBy(
                allocationResultDecisions.id,
                allocationResultDecisions.version,
                allocationResultDecisions.orderSessionId,
                orderSessions.code,
                allocationLines.productId,
              )
              .orderBy(asc(orderSessions.code), asc(allocationLines.productId))
          : [];
      const chainRows = await tx
        .select({
          id: storeWaitDocuments.id,
          code: storeWaitDocuments.code,
          status: storeWaitDocuments.status,
          chainSequence: storeWaitDocuments.chainSequence,
          openedAt: storeWaitDocuments.openedAt,
          closedAt: storeWaitDocuments.closedAt,
          openedEventId: storeWaitDocuments.openedEventId,
          closedEventId: storeWaitDocuments.closedEventId,
        })
        .from(storeWaitDocuments)
        .where(eq(storeWaitDocuments.chainId, record.chainId))
        .orderBy(asc(storeWaitDocuments.chainSequence));
      const chainEventKinds = new Map(
        (
          await tx
            .select({ id: storeWaitDocumentEvents.id, kind: storeWaitDocumentEvents.kind })
            .from(storeWaitDocumentEvents)
            .where(
              inArray(
                storeWaitDocumentEvents.id,
                chainRows.flatMap((row) =>
                  row.closedEventId ? [row.openedEventId, row.closedEventId] : [row.openedEventId],
                ),
              ),
            )
        ).map((row) => [row.id, row.kind]),
      );
      const [current] = await tx
        .select({ id: storeWaitDocuments.id, code: storeWaitDocuments.code })
        .from(storeWaitDocuments)
        .where(
          and(
            eq(storeWaitDocuments.storeId, record.storeId),
            eq(storeWaitDocuments.status, 'current'),
          ),
        )
        .limit(1);
      return {
        ...record,
        members,
        pendingResults,
        chain: chainRows.map((row) => ({
          id: row.id,
          code: row.code,
          status: row.status,
          chainSequence: row.chainSequence,
          openedAt: row.openedAt,
          closedAt: row.closedAt,
          openedEventKind: chainEventKinds.get(row.openedEventId)!,
          closedEventKind: row.closedEventId
            ? (chainEventKinds.get(row.closedEventId) ?? null)
            : null,
        })),
        currentDocument: current ?? null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export interface StoreWaitDocumentCancellationScope {
  readonly document: typeof storeWaitDocuments.$inferSelect;
  /** Tickets this cancellation cancels, each with its own revocation scope. */
  readonly tickets: readonly WaitTicketCancellationScope[];
  /**
   * Open goods it cannot cancel: bags granted from tickets that were already cancelled (a lapsed
   * full offer) and still wait for the store's answer on their result.
   */
  readonly awaitingAnswer: readonly StoreWaitLiveTicket[];
  readonly fingerprint: string;
}

async function loadDocumentCancellationScope(
  reader: Database | Transaction,
  document: typeof storeWaitDocuments.$inferSelect,
): Promise<StoreWaitDocumentCancellationScope> {
  const live = await loadStoreWaitLiveTickets(reader, document.storeId);
  const ticketIds = [...new Set(live.map((ticket) => ticket.waitTicketId))].sort();
  const ticketRows =
    ticketIds.length === 0
      ? []
      : await reader
          .select()
          .from(waitTickets)
          .where(inArray(waitTickets.id, ticketIds))
          .orderBy(asc(waitTickets.id));
  const tickets: WaitTicketCancellationScope[] = [];
  const awaitingAnswer: StoreWaitLiveTicket[] = [];
  for (const ticket of ticketRows) {
    const scope = await loadCancellationScope(reader, ticket, { lock: false });
    if (scope.plan.ok) tickets.push(scope);
    else awaitingAnswer.push(...live.filter((row) => row.waitTicketId === ticket.id));
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        document: [document.id, document.status, document.version],
        tickets: tickets.map((scope) => [scope.ticket.id, scope.fingerprint]),
        awaitingAnswer: awaitingAnswer.map((row) => [row.waitTicketId, row.pendingQuantity]),
      }),
    )
    .digest('hex');
  return { document, tickets, awaitingAnswer, fingerprint };
}

async function locateDocumentForCancellation(
  reader: Database | Transaction,
  actorUserId: string,
  documentId: string,
): Promise<typeof storeWaitDocuments.$inferSelect> {
  const [document] = await reader
    .select()
    .from(storeWaitDocuments)
    .where(eq(storeWaitDocuments.id, documentId))
    .limit(1);
  if (!document) throw new StoreWaitDocumentNotFoundError();
  try {
    await assertActorMayCancelWaitTicket(reader as Transaction, actorUserId, document.storeId);
  } catch (error: unknown) {
    if (error instanceof WaitTicketAuthorizationError) throw new StoreWaitDocumentNotFoundError();
    throw error;
  }
  if (document.status !== 'current') {
    const [current] = await reader
      .select({ id: storeWaitDocuments.id })
      .from(storeWaitDocuments)
      .where(
        and(
          eq(storeWaitDocuments.storeId, document.storeId),
          eq(storeWaitDocuments.status, 'current'),
        ),
      )
      .limit(1);
    throw new StoreWaitDocumentSupersededError(current?.id ?? null);
  }
  return document;
}

/**
 * Read only: what cancelling the whole document would cancel, revoke and protect, ticket by
 * ticket, and what it cannot cancel because it already waits only for the store's answer.
 */
export async function previewStoreWaitDocumentCancellation(
  database: Database,
  input: { readonly actorUserId: string; readonly documentId: string },
): Promise<StoreWaitDocumentCancellationScope> {
  return withSerializableTransaction(database, async (tx) => {
    const document = await locateDocumentForCancellation(tx, input.actorUserId, input.documentId);
    return loadDocumentCancellationScope(tx, document);
  });
}

export interface CancelStoreWaitDocumentInput {
  readonly documentId: string;
  readonly actorUserId: string;
  readonly reason: string;
  /** Fingerprint of the preview the account confirmed; always required for a whole document. */
  readonly expectedFingerprint: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface CancelledStoreWaitDocument {
  readonly documentId: string;
  readonly storeId: string;
  readonly cancelledTicketIds: readonly string[];
  readonly cancelledQuantity: number;
  readonly revokedQuantity: number;
  /** The document holding what is left (goods awaiting an answer), or null when none is left. */
  readonly currentDocumentId: string | null;
}

/**
 * "Hủy phiếu chờ" of a whole store document: every cancellable ticket line is cancelled with the
 * per-ticket rules (offers cancelled, revocable PENDING goods revoked, RE/shipped/received goods
 * protected), in one transaction, after the confirmed preview is re-checked; then the document
 * closes once. A document that is no longer current is refused (409 with the current document):
 * the target is never silently switched to its successor.
 */
export async function cancelStoreWaitDocument(
  database: Database,
  input: CancelStoreWaitDocumentInput,
): Promise<IdempotencyResult<CancelledStoreWaitDocument>> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new WaitTicketValidationError(
      'A cancellation reason must contain at least 3 characters.',
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedFingerprint)) {
    throw new WaitTicketValidationError('expectedFingerprint must be the preview fingerprint.');
  }
  return withIdempotency(
    database,
    {
      scope: `wait-document.cancel:${input.documentId}:${input.actorUserId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const cancelled = await withAdvisoryLock(
        tx,
        STOCK_JOBS_LOCK.namespace,
        STOCK_JOBS_LOCK.key,
        async () => {
          const document = await locateDocumentForCancellation(
            tx,
            input.actorUserId,
            input.documentId,
          );
          const scope = await loadDocumentCancellationScope(tx, document);
          if (scope.fingerprint !== input.expectedFingerprint) {
            throw new WaitTicketPreviewStaleError();
          }
          if (scope.tickets.length === 0) {
            throw new WaitTicketConflictError(
              'Nothing of this wait document can be cancelled; it only waits for result answers.',
            );
          }
          const declared = new Map<string, number>();
          let cancelledQuantity = 0;
          let revokedQuantity = 0;
          for (const ticketScope of scope.tickets) {
            // Each ticket re-reads its scope under its own locks and compares this fingerprint.
            const ticket = await cancelWaitTicketInTransaction(
              tx,
              {
                waitTicketId: ticketScope.ticket.id,
                actorUserId: input.actorUserId,
                reason,
                expectedFingerprint: ticketScope.fingerprint,
                ...(input.requestId ? { requestId: input.requestId } : {}),
              },
              reason,
            );
            declared.set(
              ticket.productId,
              (declared.get(ticket.productId) ?? 0) + ticket.cancelledQuantity,
            );
            cancelledQuantity += ticket.cancelledQuantity;
            revokedQuantity += ticket.revokedQuantity;
          }
          return {
            document,
            declared,
            cancelledQuantity,
            revokedQuantity,
            cancelledTicketIds: scope.tickets.map((ticketScope) => ticketScope.ticket.id),
          };
        },
      );
      const [result] = await reconcileStoreWaitDocumentsInTransaction(tx, [
        {
          storeId: cancelled.document.storeId,
          declared: [...cancelled.declared].map(([productId, quantity]) => ({
            productId,
            category: 'cancelled' as const,
            quantity,
          })),
          event: {
            kind: 'wait_document_cancelled',
            sourceKey: `wait-document-cancel:${cancelled.document.id}`,
            actorUserId: input.actorUserId,
            requestId: input.requestId ?? null,
            occurredAt: new Date(),
            reason,
            metadata: {
              documentId: cancelled.document.id,
              cancelledTicketIds: cancelled.cancelledTicketIds,
              revokedQuantity: cancelled.revokedQuantity,
            },
          },
        },
      ]);
      if (result?.closedDocumentId !== cancelled.document.id) {
        throw new StoreWaitDocumentSupersededError(result?.currentDocumentId ?? null);
      }
      const value: CancelledStoreWaitDocument = {
        documentId: cancelled.document.id,
        storeId: cancelled.document.storeId,
        cancelledTicketIds: cancelled.cancelledTicketIds,
        cancelledQuantity: cancelled.cancelledQuantity,
        revokedQuantity: cancelled.revokedQuantity,
        currentDocumentId: result.currentDocumentId,
      };
      return {
        value,
        responseStatus: 200,
        responseBody: { ...value, cancelledTicketIds: [...value.cancelledTicketIds] },
        resourceType: 'store_wait_document',
        resourceId: value.documentId,
      };
    },
    async (tx) => {
      // A replay is answered only while the account may still act on the store.
      const [document] = await tx
        .select({ storeId: storeWaitDocuments.storeId })
        .from(storeWaitDocuments)
        .where(eq(storeWaitDocuments.id, input.documentId))
        .limit(1);
      if (!document) throw new StoreWaitDocumentNotFoundError();
      await assertActorMayCancelWaitTicket(tx, input.actorUserId, document.storeId);
    },
  );
}

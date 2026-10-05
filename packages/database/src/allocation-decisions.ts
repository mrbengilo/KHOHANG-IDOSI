import {
  normalizeAllocationDecisionReason,
  partitionRejectedShipmentSources,
  transitionAllocationDecision,
  type AllocationDecisionAction,
  type AllocationDecisionStatus,
} from '@idosi/domain';
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';

import {
  SHIPPABLE_DECISION_STATUSES,
  type AllocationDecisionDatabaseStatus,
} from './allocation-decision-gate.js';
import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import { dispatchWarehouseOutboundInTransaction } from './outbound-requests.js';
import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  auditLogs,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  reservations,
  storeReceipts,
  stores,
  users,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, withTransaction, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

/**
 * Every job and command that changes which warehouse goods are reserved for whom takes this one
 * transaction lock first: the 08:00 snapshot, the 09:00 allocation and a store answering its
 * result. A rejection releasing goods can therefore never interleave with a run planning on them.
 */
export const STOCK_JOBS_LOCK = { namespace: 'idosi-allocation-worker', key: 'stock-jobs' } as const;

export const ALLOCATION_RESULT_REJECTED_RELEASE_REASON = 'allocation_result_rejected';
export const ALLOCATION_RESULT_DETACHED_REASON = 'detached_from_rejected_shipment';

const DATABASE_STATUS: Record<AllocationDecisionDatabaseStatus, AllocationDecisionStatus> = {
  pending: 'PENDING',
  accepted: 'ACCEPTED',
  rejected: 'REJECTED',
  not_required: 'NOT_REQUIRED',
  legacy: 'LEGACY',
};

export function domainDecisionStatus(
  status: AllocationDecisionDatabaseStatus,
): AllocationDecisionStatus {
  return DATABASE_STATUS[status];
}

export function databaseDecisionStatus(
  status: AllocationDecisionStatus,
): AllocationDecisionDatabaseStatus {
  const entry = Object.entries(DATABASE_STATUS).find(([, value]) => value === status);
  if (!entry) throw new RangeError(`Unknown allocation decision status ${status}.`);
  return entry[0] as AllocationDecisionDatabaseStatus;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class AllocationDecisionNotFoundError extends Error {
  public readonly code = 'ALLOCATION_DECISION_NOT_FOUND';

  public constructor() {
    super('Allocation result decision does not exist.');
    this.name = 'AllocationDecisionNotFoundError';
  }
}

export class AllocationDecisionForbiddenError extends Error {
  public readonly code = 'ALLOCATION_DECISION_FORBIDDEN';

  public constructor() {
    super('Only the receiving store account may answer this allocation result.');
    this.name = 'AllocationDecisionForbiddenError';
  }
}

export class AllocationDecisionValidationError extends Error {
  public readonly code = 'ALLOCATION_DECISION_VALIDATION_ERROR';

  public constructor(message: string) {
    super(message);
    this.name = 'AllocationDecisionValidationError';
  }
}

export class AllocationDecisionConflictError extends Error {
  public readonly code = 'ALLOCATION_DECISION_CONFLICT';
  public readonly reason: 'ALREADY_ANSWERED' | 'NOT_ANSWERABLE' | 'STALE_VERSION';
  public readonly currentStatus: AllocationDecisionStatus;
  public readonly currentVersion: number;

  public constructor(
    reason: 'ALREADY_ANSWERED' | 'NOT_ANSWERABLE' | 'STALE_VERSION',
    currentStatus: AllocationDecisionStatus,
    currentVersion: number,
  ) {
    super(`Allocation result decision is ${currentStatus} (version ${currentVersion}).`);
    this.name = 'AllocationDecisionConflictError';
    this.reason = reason;
    this.currentStatus = currentStatus;
    this.currentVersion = currentVersion;
  }
}

/** Data that should be impossible; the command refuses instead of guessing. */
export class AllocationDecisionIntegrityError extends Error {
  public readonly code = 'ALLOCATION_DECISION_INTEGRITY';

  public constructor(message: string) {
    super(message);
    this.name = 'AllocationDecisionIntegrityError';
  }
}

// ---------------------------------------------------------------------------------------------
// Publication (worker, inside the allocation transaction)
// ---------------------------------------------------------------------------------------------

export interface PublishedAllocationDecision {
  readonly id: string;
  readonly storeId: string;
  readonly status: AllocationDecisionDatabaseStatus;
  readonly grantedQuantity: number;
}

/**
 * Records one decision per store the run allocated to, in the run's own transaction, so no store
 * can see a result that is not committed and a replayed run cannot publish twice. A store with
 * granted goods waits for its answer; a store granted nothing has nothing to answer.
 * `extraStoreIds` are stores that get a shipment from this run without a line of their own
 * (carried goods only); they are recorded as not_required so the shipment has a result record.
 */
export async function publishAllocationDecisionsInTransaction(
  tx: Transaction,
  input: {
    readonly allocationRunId: string;
    readonly orderSessionId: string;
    readonly publishedAt: Date;
    readonly extraStoreIds?: readonly string[];
  },
): Promise<readonly PublishedAllocationDecision[]> {
  const granted = await tx
    .select({
      storeId: allocationLines.storeId,
      grantedQuantity: sql<number>`coalesce(sum(${allocationLines.allocatedQuantity}), 0)`.mapWith(
        Number,
      ),
    })
    .from(allocationLines)
    .where(eq(allocationLines.allocationRunId, input.allocationRunId))
    .groupBy(allocationLines.storeId)
    .orderBy(asc(allocationLines.storeId));
  const byStore = new Map(granted.map((row) => [row.storeId, row.grantedQuantity]));
  for (const storeId of input.extraStoreIds ?? []) {
    if (!byStore.has(storeId)) byStore.set(storeId, 0);
  }
  if (byStore.size === 0) return [];
  const rows = [...byStore].map(([storeId, grantedQuantity]) => ({
    allocationRunId: input.allocationRunId,
    orderSessionId: input.orderSessionId,
    storeId,
    status: (grantedQuantity > 0 ? 'pending' : 'not_required') as AllocationDecisionDatabaseStatus,
    version: 1,
    grantedQuantity,
    origin: 'allocation_run',
    createdAt: input.publishedAt,
    updatedAt: input.publishedAt,
  }));
  const inserted = await tx
    .insert(allocationResultDecisions)
    .values(rows)
    .onConflictDoNothing({
      target: [allocationResultDecisions.allocationRunId, allocationResultDecisions.storeId],
    })
    .returning();
  if (inserted.length > 0) {
    await tx.insert(auditLogs).values(
      inserted.map((decision) => ({
        actorStoreId: decision.storeId,
        action: 'ALLOCATION_RESULT_PUBLISHED',
        entityType: 'allocation_result_decision',
        entityId: decision.id,
        after: {
          status: decision.status,
          version: decision.version,
          grantedQuantity: decision.grantedQuantity,
          allocationRunId: decision.allocationRunId,
          orderSessionId: decision.orderSessionId,
          storeId: decision.storeId,
        },
        createdAt: input.publishedAt,
      })),
    );
  }
  const all = await tx
    .select()
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.allocationRunId, input.allocationRunId));
  return all.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    grantedQuantity: row.grantedQuantity,
  }));
}

/** SQL predicate: the result behind (run, store) columns may ship. */
export function shippableResultCondition(runColumn: SQL | unknown, storeColumn: SQL | unknown) {
  return sql`exists (select 1 from ${allocationResultDecisions} where ${allocationResultDecisions.allocationRunId} = ${runColumn} and ${allocationResultDecisions.storeId} = ${storeColumn} and ${allocationResultDecisions.status} in (${sql.join(
    SHIPPABLE_DECISION_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}))`;
}

// ---------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------

export interface AllocationDecisionLineRecord {
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly allocatedQuantity: number;
  readonly waitlistedQuantity: number;
}

export interface AllocationDecisionCarriedRecord {
  readonly reservationId: string;
  readonly allocationLineId: string;
  readonly allocationRunId: string;
  readonly orderSessionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly reservationStatus: (typeof reservations.$inferSelect)['status'];
  readonly waitTicketId: string | null;
  readonly sourceDecisionStatus: AllocationDecisionDatabaseStatus | null;
}

export interface AllocationDecisionShipmentRecord {
  readonly outboundRequestId: string;
  readonly requestNumber: string;
  readonly status: (typeof outboundRequests.$inferSelect)['status'];
  readonly dispatchedAt: Date | null;
  readonly receiptId: string | null;
  readonly receiptNumber: string | null;
  readonly receiptStatus: (typeof storeReceipts.$inferSelect)['status'] | null;
}

export interface AllocationDecisionSourceRecord {
  readonly allocationLineId: string;
  readonly productId: string;
  readonly priorityLevel: (typeof allocationLines.$inferSelect)['priorityLevel'];
  readonly requestedQuantity: number;
  readonly allocatedQuantity: number;
  readonly waitlistedQuantity: number;
  readonly orderRequestId: string | null;
  readonly orderRequestCode: string | null;
  readonly waitTicketId: string | null;
  readonly priorityOfferId: string | null;
}

export interface AllocationDecisionRecord {
  readonly id: string;
  readonly allocationRunId: string;
  readonly runNumber: number;
  readonly orderSessionId: string;
  readonly sessionCode: string;
  readonly businessDate: string;
  readonly storeId: string;
  readonly status: AllocationDecisionDatabaseStatus;
  readonly version: number;
  readonly grantedQuantity: number;
  readonly origin: 'allocation_run' | 'legacy_backfill';
  readonly respondedAt: Date | null;
  readonly respondedByUserId: string | null;
  readonly respondedByName: string | null;
  readonly responseReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lines: readonly AllocationDecisionLineRecord[];
  readonly carried: readonly AllocationDecisionCarriedRecord[];
  /** Goods of this result still reserved for the store and not yet on a shipment. */
  readonly heldQuantity: number;
  /** Goods of this result given back to the warehouse by the store's rejection. */
  readonly releasedQuantity: number;
  readonly shipment: AllocationDecisionShipmentRecord | null;
}

export interface AllocationDecisionDetailRecord extends AllocationDecisionRecord {
  readonly sources: readonly AllocationDecisionSourceRecord[];
}

export interface ListAllocationDecisionsInput {
  readonly page: number;
  readonly pageSize: number;
  /** Server-authorized store scope; undefined means every store. */
  readonly storeIds?: readonly string[];
  readonly status?: AllocationDecisionDatabaseStatus;
  readonly sessionId?: string;
  readonly allocationRunId?: string;
  readonly outboundRequestId?: string;
}

export interface AllocationDecisionPage {
  readonly data: readonly AllocationDecisionRecord[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

type Reader = Database | Transaction;

const headerColumns = {
  decision: allocationResultDecisions,
  runNumber: allocationRuns.runNumber,
  sessionCode: orderSessions.code,
  businessDate: orderSessions.businessDate,
  respondedByName: users.displayName,
};

function headerQuery(reader: Reader) {
  return reader
    .select(headerColumns)
    .from(allocationResultDecisions)
    .innerJoin(allocationRuns, eq(allocationRuns.id, allocationResultDecisions.allocationRunId))
    .innerJoin(orderSessions, eq(orderSessions.id, allocationResultDecisions.orderSessionId))
    .leftJoin(users, eq(users.id, allocationResultDecisions.respondedByUserId));
}

type HeaderRow = Awaited<ReturnType<ReturnType<typeof headerQuery>['execute']>>[number];

/**
 * Paged by decision header, then one batched query per detail kind for the selected page, all
 * in one repeatable-read snapshot. Read only; never touches stock.
 */
export async function listAllocationDecisions(
  database: Database,
  input: ListAllocationDecisionsInput,
): Promise<AllocationDecisionPage> {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100
  ) {
    throw new RangeError('Invalid allocation decision pagination.');
  }
  const empty = { page: input.page, pageSize: input.pageSize, totalItems: 0, totalPages: 0 };
  if (input.storeIds?.length === 0) return { data: [], pagination: empty };
  return withTransaction(
    database,
    async (tx) => {
      const predicates: SQL[] = [];
      if (input.storeIds) {
        predicates.push(inArray(allocationResultDecisions.storeId, [...new Set(input.storeIds)]));
      }
      if (input.status) predicates.push(eq(allocationResultDecisions.status, input.status));
      if (input.sessionId) {
        predicates.push(eq(allocationResultDecisions.orderSessionId, input.sessionId));
      }
      if (input.allocationRunId) {
        predicates.push(eq(allocationResultDecisions.allocationRunId, input.allocationRunId));
      }
      if (input.outboundRequestId) {
        predicates.push(sql`exists (select 1 from ${outboundRequests}
          where ${outboundRequests.id} = ${input.outboundRequestId}
          and ${outboundRequests.allocationRunId} = ${allocationResultDecisions.allocationRunId}
          and ${outboundRequests.storeId} = ${allocationResultDecisions.storeId}
          and ${outboundRequests.deletedAt} is null)`);
      }
      const where = predicates.length === 0 ? undefined : and(...predicates);
      const [totalRow] = await tx
        .select({ value: count() })
        .from(allocationResultDecisions)
        .where(where);
      const headers = await headerQuery(tx)
        .where(where)
        .orderBy(desc(allocationResultDecisions.createdAt), desc(allocationResultDecisions.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const totalItems = totalRow?.value ?? 0;
      return {
        data: await assembleDecisionRecords(tx, headers),
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

export async function getAllocationDecision(
  database: Database,
  decisionId: string,
): Promise<AllocationDecisionDetailRecord> {
  return withTransaction(
    database,
    async (tx) => {
      const [header] = await headerQuery(tx)
        .where(eq(allocationResultDecisions.id, decisionId))
        .limit(1);
      if (!header) throw new AllocationDecisionNotFoundError();
      const [record] = await assembleDecisionRecords(tx, [header]);
      if (!record) throw new AllocationDecisionNotFoundError();
      const sources = await tx
        .select({
          line: allocationLines,
          orderRequestId: orderRequests.id,
          orderRequestCode: orderRequests.code,
        })
        .from(allocationLines)
        .leftJoin(orderRequestItems, eq(orderRequestItems.id, allocationLines.orderRequestItemId))
        .leftJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
        .where(
          and(
            eq(allocationLines.allocationRunId, record.allocationRunId),
            eq(allocationLines.storeId, record.storeId),
          ),
        )
        .orderBy(asc(allocationLines.productId), asc(allocationLines.id));
      return {
        ...record,
        sources: sources.map(({ line, orderRequestId, orderRequestCode }) => ({
          allocationLineId: line.id,
          productId: line.productId,
          priorityLevel: line.priorityLevel,
          requestedQuantity: line.requestedQuantity,
          allocatedQuantity: line.allocatedQuantity,
          waitlistedQuantity: line.waitlistedQuantity,
          orderRequestId,
          orderRequestCode,
          waitTicketId: line.waitTicketId,
          priorityOfferId: line.priorityOfferId,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Decision summaries for (run, store) pairs, used by the session-document projection. */
export async function loadAllocationDecisionsForResults(
  reader: Reader,
  pairs: readonly { readonly allocationRunId: string; readonly storeId: string }[],
): Promise<readonly AllocationDecisionRecord[]> {
  if (pairs.length === 0) return [];
  const headers = await headerQuery(reader).where(
    or(
      ...pairs.map((pair) =>
        and(
          eq(allocationResultDecisions.allocationRunId, pair.allocationRunId),
          eq(allocationResultDecisions.storeId, pair.storeId),
        ),
      ),
    ),
  );
  return assembleDecisionRecords(reader, headers);
}

async function assembleDecisionRecords(
  reader: Reader,
  headers: readonly HeaderRow[],
): Promise<readonly AllocationDecisionRecord[]> {
  if (headers.length === 0) return [];
  const pairKey = (runId: string, storeId: string) => `${runId}:${storeId}`;
  const runIds = [...new Set(headers.map((header) => header.decision.allocationRunId))];
  const storeIds = [...new Set(headers.map((header) => header.decision.storeId))];
  const wanted = new Set(
    headers.map((header) => pairKey(header.decision.allocationRunId, header.decision.storeId)),
  );

  // One transaction client: queries run one after another, never interleaved on it.
  const lineRows = await reader
    .select({
      allocationRunId: allocationLines.allocationRunId,
      storeId: allocationLines.storeId,
      productId: allocationLines.productId,
      requestedQuantity: sql<number>`sum(${allocationLines.requestedQuantity})`.mapWith(Number),
      allocatedQuantity: sql<number>`sum(${allocationLines.allocatedQuantity})`.mapWith(Number),
      waitlistedQuantity: sql<number>`sum(${allocationLines.waitlistedQuantity})`.mapWith(Number),
    })
    .from(allocationLines)
    .where(
      and(
        inArray(allocationLines.allocationRunId, runIds),
        inArray(allocationLines.storeId, storeIds),
      ),
    )
    .groupBy(allocationLines.allocationRunId, allocationLines.storeId, allocationLines.productId)
    .orderBy(asc(allocationLines.productId));
  const reservationRows = await reader
    .select({
      allocationRunId: allocationLines.allocationRunId,
      storeId: allocationLines.storeId,
      held: sql<number>`coalesce(sum(${reservations.quantity}) filter (where ${reservations.status} = 'active' and ${reservations.outboundRequestLineId} is null), 0)`.mapWith(
        Number,
      ),
      released:
        sql<number>`coalesce(sum(${reservations.quantity}) filter (where ${reservations.status} = 'released' and ${reservations.releaseReason} = ${ALLOCATION_RESULT_REJECTED_RELEASE_REASON}), 0)`.mapWith(
          Number,
        ),
    })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .where(
      and(
        inArray(allocationLines.allocationRunId, runIds),
        inArray(allocationLines.storeId, storeIds),
        isNull(reservations.deletedAt),
      ),
    )
    .groupBy(allocationLines.allocationRunId, allocationLines.storeId);
  const shipmentRows = await reader
    .select({
      allocationRunId: outboundRequests.allocationRunId,
      storeId: outboundRequests.storeId,
      outboundRequestId: outboundRequests.id,
      requestNumber: outboundRequests.requestNumber,
      status: outboundRequests.status,
      dispatchedAt: outboundRequests.dispatchedAt,
      receiptId: storeReceipts.id,
      receiptNumber: storeReceipts.receiptNumber,
      receiptStatus: storeReceipts.status,
    })
    .from(outboundRequests)
    .leftJoin(
      storeReceipts,
      and(
        eq(storeReceipts.outboundRequestId, outboundRequests.id),
        isNull(storeReceipts.deletedAt),
      ),
    )
    .where(
      and(
        inArray(outboundRequests.allocationRunId, runIds),
        inArray(outboundRequests.storeId, storeIds),
        isNull(outboundRequests.deletedAt),
      ),
    )
    .orderBy(asc(outboundRequests.createdAt), asc(outboundRequests.id));
  const shipmentIds = shipmentRows
    .filter((row) => row.allocationRunId !== null)
    .filter((row) => wanted.has(pairKey(row.allocationRunId!, row.storeId)))
    .map((row) => row.outboundRequestId);
  const sourceDecision = allocationResultDecisions;
  const carriedRows =
    shipmentIds.length === 0
      ? []
      : await reader
          .select({
            outboundRequestId: outboundRequestLines.outboundRequestId,
            reservationId: reservations.id,
            allocationLineId: allocationLines.id,
            allocationRunId: allocationLines.allocationRunId,
            orderSessionId: allocationRuns.orderSessionId,
            productId: reservations.productId,
            quantity: reservations.quantity,
            reservationStatus: reservations.status,
            waitTicketId: allocationLines.waitTicketId,
            sourceDecisionStatus: sourceDecision.status,
          })
          .from(reservations)
          .innerJoin(
            outboundRequestLines,
            eq(outboundRequestLines.id, reservations.outboundRequestLineId),
          )
          .innerJoin(
            outboundRequests,
            eq(outboundRequests.id, outboundRequestLines.outboundRequestId),
          )
          .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
          .innerJoin(allocationRuns, eq(allocationRuns.id, allocationLines.allocationRunId))
          .leftJoin(
            sourceDecision,
            and(
              eq(sourceDecision.allocationRunId, allocationLines.allocationRunId),
              eq(sourceDecision.storeId, allocationLines.storeId),
            ),
          )
          .where(
            and(
              inArray(outboundRequests.id, shipmentIds),
              ne(allocationLines.allocationRunId, outboundRequests.allocationRunId),
              isNull(reservations.deletedAt),
            ),
          )
          .orderBy(asc(reservations.productId), asc(reservations.createdAt), asc(reservations.id));

  return headers.map((header) => {
    const { decision } = header;
    const key = pairKey(decision.allocationRunId, decision.storeId);
    const shipment =
      shipmentRows.find(
        (row) => row.allocationRunId !== null && pairKey(row.allocationRunId, row.storeId) === key,
      ) ?? null;
    const amounts = reservationRows.find(
      (row) => pairKey(row.allocationRunId, row.storeId) === key,
    );
    return {
      id: decision.id,
      allocationRunId: decision.allocationRunId,
      runNumber: header.runNumber,
      orderSessionId: decision.orderSessionId,
      sessionCode: header.sessionCode,
      businessDate: header.businessDate,
      storeId: decision.storeId,
      status: decision.status,
      version: decision.version,
      grantedQuantity: decision.grantedQuantity,
      origin: decision.origin === 'legacy_backfill' ? 'legacy_backfill' : 'allocation_run',
      respondedAt: decision.respondedAt,
      respondedByUserId: decision.respondedByUserId,
      respondedByName: header.respondedByName,
      responseReason: decision.responseReason,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
      lines: lineRows
        .filter((row) => pairKey(row.allocationRunId, row.storeId) === key)
        .map(({ allocationRunId: _run, storeId: _store, ...line }) => line),
      carried: shipment
        ? carriedRows
            .filter((row) => row.outboundRequestId === shipment.outboundRequestId)
            .map(({ outboundRequestId: _outbound, ...row }) => row)
        : [],
      heldQuantity: amounts?.held ?? 0,
      releasedQuantity: amounts?.released ?? 0,
      shipment: shipment
        ? {
            outboundRequestId: shipment.outboundRequestId,
            requestNumber: shipment.requestNumber,
            status: shipment.status,
            dispatchedAt: shipment.dispatchedAt,
            receiptId: shipment.receiptId,
            receiptNumber: shipment.receiptNumber,
            receiptStatus: shipment.receiptStatus,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------------------------

export interface RespondAllocationDecisionInput {
  readonly decisionId: string;
  readonly action: AllocationDecisionAction;
  readonly expectedVersion: number;
  readonly reason?: string | null;
  readonly actorUserId: string;
  readonly requestId?: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly respondedAt?: Date;
}

export interface RespondAllocationDecisionResult {
  readonly decisionId: string;
  readonly status: AllocationDecisionDatabaseStatus;
  readonly version: number;
  readonly releasedQuantity: number;
  readonly keptHeldQuantity: number;
  readonly dispatchedOutboundRequestId: string | null;
  readonly cancelledOutboundRequestId: string | null;
}

/**
 * Read-only authorization before any replay or mutation, so an idempotency replay can never
 * answer for an account that lost the right to the store; the transaction checks again.
 */
export async function authorizeAllocationDecisionResponder(
  database: Database,
  decisionId: string,
  actorUserId: string,
): Promise<void> {
  const [decision] = await database
    .select({ storeId: allocationResultDecisions.storeId })
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, decisionId))
    .limit(1);
  if (!decision) throw new AllocationDecisionNotFoundError();
  await assertResponderMayAnswer(database, actorUserId, decision.storeId);
}

export async function respondAllocationDecision(
  database: Database,
  input: RespondAllocationDecisionInput,
): Promise<IdempotencyResult<RespondAllocationDecisionResult>> {
  if (input.action !== 'ACCEPT' && input.action !== 'REJECT') {
    throw new AllocationDecisionValidationError('action must be ACCEPT or REJECT.');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AllocationDecisionValidationError('expectedVersion must be a positive integer.');
  }
  let reason: string | null;
  try {
    reason = normalizeAllocationDecisionReason(input.action, input.reason);
  } catch (error: unknown) {
    throw new AllocationDecisionValidationError(
      error instanceof Error ? error.message : 'Invalid reason.',
    );
  }
  await authorizeAllocationDecisionResponder(database, input.decisionId, input.actorUserId);
  return withIdempotency(
    database,
    {
      // Per account: a key replays only for the account that sent it.
      scope: `allocation-decision.respond:${input.decisionId}:${input.actorUserId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const result = await respondAllocationDecisionInTransaction(tx, { ...input, reason });
      return {
        value: result,
        responseStatus: 200,
        responseBody: { ...result },
        resourceType: 'allocation_result_decision',
        resourceId: result.decisionId,
      };
    },
  );
}

async function respondAllocationDecisionInTransaction(
  tx: Transaction,
  input: RespondAllocationDecisionInput & { readonly reason: string | null },
): Promise<RespondAllocationDecisionResult> {
  return withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, async () => {
    const [located] = await tx
      .select({
        allocationRunId: allocationResultDecisions.allocationRunId,
        storeId: allocationResultDecisions.storeId,
      })
      .from(allocationResultDecisions)
      .where(eq(allocationResultDecisions.id, input.decisionId))
      .limit(1);
    if (!located) throw new AllocationDecisionNotFoundError();
    const actorRole = await assertResponderMayAnswer(tx, input.actorUserId, located.storeId);

    const [shipmentHeader] = await tx
      .select({ id: outboundRequests.id })
      .from(outboundRequests)
      .where(
        and(
          eq(outboundRequests.allocationRunId, located.allocationRunId),
          eq(outboundRequests.storeId, located.storeId),
          isNull(outboundRequests.deletedAt),
          ne(outboundRequests.status, 'cancelled'),
        ),
      )
      .limit(1);
    // Same order as every dispatch: shipment lock, then shipment row, then reservations.
    const run = () => respondLocked(tx, input, actorRole, shipmentHeader?.id ?? null);
    return shipmentHeader
      ? withAdvisoryLock(tx, 'warehouse-outbound', shipmentHeader.id, run)
      : run();
  });
}

async function respondLocked(
  tx: Transaction,
  input: RespondAllocationDecisionInput & { readonly reason: string | null },
  actorRole: 'store' | 'wholesale',
  shipmentId: string | null,
): Promise<RespondAllocationDecisionResult> {
  const [decision] = await tx
    .select()
    .from(allocationResultDecisions)
    .where(eq(allocationResultDecisions.id, input.decisionId))
    .for('update')
    .limit(1);
  if (!decision) throw new AllocationDecisionNotFoundError();
  const transition = transitionAllocationDecision({
    status: domainDecisionStatus(decision.status),
    version: decision.version,
    expectedVersion: input.expectedVersion,
    action: input.action,
  });
  if (!transition.ok) {
    throw new AllocationDecisionConflictError(
      transition.reason,
      domainDecisionStatus(decision.status),
      decision.version,
    );
  }
  const respondedAt = input.respondedAt ?? new Date();
  const [shipment] = shipmentId
    ? await tx
        .select()
        .from(outboundRequests)
        .where(eq(outboundRequests.id, shipmentId))
        .for('update')
        .limit(1)
    : [];
  if (shipment && shipment.status !== 'reserved') {
    throw new AllocationDecisionIntegrityError(
      `Shipment ${shipment.id} of an unanswered result is already ${shipment.status}.`,
    );
  }

  const [updated] = await tx
    .update(allocationResultDecisions)
    .set({
      status: transition.next === 'ACCEPTED' ? 'accepted' : 'rejected',
      version: decision.version + 1,
      respondedAt,
      respondedByUserId: input.actorUserId,
      responseReason: input.reason,
      updatedAt: respondedAt,
    })
    .where(
      and(
        eq(allocationResultDecisions.id, decision.id),
        eq(allocationResultDecisions.status, 'pending'),
        eq(allocationResultDecisions.version, decision.version),
      ),
    )
    .returning();
  if (!updated) {
    throw new AllocationDecisionConflictError(
      'STALE_VERSION',
      domainDecisionStatus(decision.status),
      decision.version,
    );
  }
  const auditBase = {
    requestId: input.requestId ?? null,
    actorUserId: input.actorUserId,
    actorRole,
    actorStoreId: decision.storeId,
    entityType: 'allocation_result_decision',
    entityId: decision.id,
    before: decisionAuditSnapshot(decision),
    createdAt: respondedAt,
  } as const;

  if (transition.next === 'ACCEPTED') {
    let dispatchedOutboundRequestId: string | null = null;
    if (shipment) {
      // The store's acceptance is the release trigger. Stock stays on hand and reserved until
      // HTKD finalizes the actual receipt; nothing is added to the store here.
      const dispatched = await dispatchWarehouseOutboundInTransaction(tx, {
        outboundRequestId: shipment.id,
        expectedVersion: shipment.version,
        dispatcher: {
          kind: 'allocation-decision',
          decisionId: decision.id,
          acceptedByUserId: input.actorUserId,
          acceptedByRole: actorRole,
        },
        requestId: input.requestId ?? null,
        dispatchedAt: respondedAt,
      });
      dispatchedOutboundRequestId = dispatched.id;
    }
    await tx.insert(auditLogs).values({
      ...auditBase,
      action: 'ALLOCATION_RESULT_ACCEPTED',
      after: decisionAuditSnapshot(updated),
      metadata: {
        allocationRunId: decision.allocationRunId,
        orderSessionId: decision.orderSessionId,
        grantedQuantity: decision.grantedQuantity,
        dispatchedOutboundRequestId,
        heldUntilNextOrdinaryShipment: shipment === undefined,
      },
    });
    return {
      decisionId: updated.id,
      status: updated.status,
      version: updated.version,
      releasedQuantity: 0,
      keptHeldQuantity: 0,
      dispatchedOutboundRequestId,
      cancelledOutboundRequestId: null,
    };
  }

  // REJECT -------------------------------------------------------------------------------
  const shipmentLines = shipment
    ? await tx
        .select()
        .from(outboundRequestLines)
        .where(eq(outboundRequestLines.outboundRequestId, shipment.id))
        .orderBy(asc(outboundRequestLines.productId), asc(outboundRequestLines.id))
        .for('update')
    : [];
  const shipmentLineIds = new Set(shipmentLines.map((line) => line.id));
  const sourceConditions: SQL[] = [
    and(
      eq(allocationLines.allocationRunId, decision.allocationRunId),
      eq(allocationLines.storeId, decision.storeId),
    )!,
  ];
  if (shipmentLines.length > 0) {
    sourceConditions.push(inArray(reservations.outboundRequestLineId, [...shipmentLineIds]));
  }
  const activeSources = await tx
    .select({
      reservation: reservations,
      sourceAllocationRunId: allocationLines.allocationRunId,
    })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .where(
      and(
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
        or(...sourceConditions),
      ),
    )
    .orderBy(asc(reservations.id))
    .for('update', { of: reservations });
  const { release, keepHeld } = partitionRejectedShipmentSources(
    activeSources.map((row) => ({ ...row, storeId: row.reservation.storeId })),
    { allocationRunId: decision.allocationRunId, storeId: decision.storeId },
  );
  for (const source of release) {
    const link = source.reservation.outboundRequestLineId;
    if (link !== null && !shipmentLineIds.has(link)) {
      throw new AllocationDecisionIntegrityError(
        `Reservation ${source.reservation.id} of an unanswered result rides another shipment.`,
      );
    }
  }
  const releasedQuantity = release.reduce((total, row) => total + row.reservation.quantity, 0);
  if (releasedQuantity !== decision.grantedQuantity) {
    throw new AllocationDecisionIntegrityError(
      `Result ${decision.id} reserves ${releasedQuantity} of its ${decision.grantedQuantity} granted goods.`,
    );
  }
  if (release.length > 0) {
    const releasedRows = await tx
      .update(reservations)
      .set({
        status: 'released',
        releasedAt: respondedAt,
        releaseReason: ALLOCATION_RESULT_REJECTED_RELEASE_REASON,
        updatedAt: respondedAt,
      })
      .where(
        and(
          inArray(
            reservations.id,
            release.map((row) => row.reservation.id),
          ),
          eq(reservations.status, 'active'),
        ),
      )
      .returning({ id: reservations.id });
    if (releasedRows.length !== release.length) {
      throw new AllocationDecisionIntegrityError('Reservations changed during the rejection.');
    }
  }
  const releasedByProduct = new Map<string, number>();
  for (const row of release) {
    releasedByProduct.set(
      row.reservation.productId,
      (releasedByProduct.get(row.reservation.productId) ?? 0) + row.reservation.quantity,
    );
  }
  for (const [productId, quantity] of [...releasedByProduct].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // The goods never left the warehouse (dispatch moves no stock), so only the reservation
    // is given back: on-hand is unchanged and the goods are available again.
    await applyWarehouseMovement(tx, {
      productId,
      eventType: 'reservation_release',
      onHandDelta: 0,
      reservedDelta: -quantity,
      sourceType: 'allocation_result_decision',
      sourceId: decision.id,
      eventSequence: 1,
      reason: 'Cửa hàng từ chối nhận kết quả phân bổ',
      metadata: {
        allocationRunId: decision.allocationRunId,
        orderSessionId: decision.orderSessionId,
        storeId: decision.storeId,
      },
      actorUserId: input.actorUserId,
      occurredAt: respondedAt,
    });
  }

  // Goods from earlier accepted results that rode this shipment stay held for the store. The
  // old reservation row keeps its link to the cancelled shipment (history); a new active row
  // with the same source and quantity is the hold that the next ordinary shipment picks up.
  // The total reserved quantity does not change, so there is no ledger movement.
  const detached: JsonObject[] = [];
  for (const row of keepHeld) {
    const old = row.reservation;
    const [cancelled] = await tx
      .update(reservations)
      .set({
        status: 'cancelled',
        releasedAt: respondedAt,
        releaseReason: ALLOCATION_RESULT_DETACHED_REASON,
        updatedAt: respondedAt,
      })
      .where(and(eq(reservations.id, old.id), eq(reservations.status, 'active')))
      .returning({ id: reservations.id });
    if (!cancelled) throw new AllocationDecisionIntegrityError('A carried hold changed.');
    const [replacement] = await tx
      .insert(reservations)
      .values({
        productId: old.productId,
        storeId: old.storeId,
        allocationLineId: old.allocationLineId,
        outboundRequestLineId: null,
        quantity: old.quantity,
        status: 'active',
        createdByUserId: old.createdByUserId,
        createdAt: old.createdAt,
        updatedAt: respondedAt,
      })
      .returning({ id: reservations.id });
    detached.push({
      previousReservationId: old.id,
      reservationId: replacement!.id,
      allocationLineId: old.allocationLineId,
      allocationRunId: row.sourceAllocationRunId,
      productId: old.productId,
      quantity: old.quantity,
      fromOutboundRequestLineId: old.outboundRequestLineId,
    });
  }
  const keptHeldQuantity = keepHeld.reduce((total, row) => total + row.reservation.quantity, 0);

  let cancelledOutboundRequestId: string | null = null;
  if (shipment) {
    // The representative pointer is cleared so a later shipment can name the carried source;
    // the full provenance stays on the reservation rows and in this audit.
    await tx
      .update(outboundRequestLines)
      .set({ allocationLineId: null, updatedAt: respondedAt })
      .where(eq(outboundRequestLines.outboundRequestId, shipment.id));
    const [cancelledShipment] = await tx
      .update(outboundRequests)
      .set({ status: 'cancelled', version: shipment.version + 1, updatedAt: respondedAt })
      .where(
        and(
          eq(outboundRequests.id, shipment.id),
          eq(outboundRequests.status, 'reserved'),
          eq(outboundRequests.version, shipment.version),
        ),
      )
      .returning({ id: outboundRequests.id });
    if (!cancelledShipment) {
      throw new AllocationDecisionIntegrityError('The shipment changed during the rejection.');
    }
    cancelledOutboundRequestId = shipment.id;
    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.actorUserId,
      actorRole,
      actorStoreId: shipment.storeId,
      action: 'OUTBOUND_REQUEST_CANCELLED',
      entityType: 'outbound_request',
      entityId: shipment.id,
      before: {
        requestNumber: shipment.requestNumber,
        status: shipment.status,
        version: shipment.version,
        lines: shipmentLines.map((line) => ({
          id: line.id,
          productId: line.productId,
          allocationLineId: line.allocationLineId,
          approvedQuantity: line.approvedQuantity,
          reservedQuantity: line.reservedQuantity,
        })),
        sources: activeSources.map((row) => ({
          reservationId: row.reservation.id,
          allocationLineId: row.reservation.allocationLineId,
          allocationRunId: row.sourceAllocationRunId,
          outboundRequestLineId: row.reservation.outboundRequestLineId,
          productId: row.reservation.productId,
          quantity: row.reservation.quantity,
        })),
      },
      after: { status: 'cancelled', version: shipment.version + 1 },
      metadata: {
        trigger: 'allocation-result-rejected',
        allocationDecisionId: decision.id,
      },
      createdAt: respondedAt,
    });
  }

  await tx.insert(auditLogs).values({
    ...auditBase,
    action: 'ALLOCATION_RESULT_REJECTED',
    after: decisionAuditSnapshot(updated),
    metadata: {
      allocationRunId: decision.allocationRunId,
      orderSessionId: decision.orderSessionId,
      grantedQuantity: decision.grantedQuantity,
      releasedQuantity,
      released: release.map((row) => ({
        reservationId: row.reservation.id,
        allocationLineId: row.reservation.allocationLineId,
        productId: row.reservation.productId,
        quantity: row.reservation.quantity,
      })),
      keptHeldQuantity,
      keptHeld: detached,
      cancelledOutboundRequestId,
    },
  });
  return {
    decisionId: updated.id,
    status: updated.status,
    version: updated.version,
    releasedQuantity,
    keptHeldQuantity,
    dispatchedOutboundRequestId: null,
    cancelledOutboundRequestId,
  };
}

/**
 * The receiving side of the store answers: a store account for its own store, and the wholesale
 * desk for a wholesale store (the same parties that declare receipts). Admin and HTKD read only.
 */
async function assertResponderMayAnswer(
  reader: Reader,
  userId: string,
  storeId: string,
): Promise<'store' | 'wholesale'> {
  const [user] = await reader
    .select({ role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const [store] = await reader
    .select({ kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active' || !store) throw new AllocationDecisionForbiddenError();
  if (user.role === 'store' && user.storeId === storeId && store.kind === 'retail') return 'store';
  if (user.role === 'wholesale' && store.kind === 'wholesale') return 'wholesale';
  throw new AllocationDecisionForbiddenError();
}

function decisionAuditSnapshot(row: typeof allocationResultDecisions.$inferSelect): JsonObject {
  return {
    status: row.status,
    version: row.version,
    grantedQuantity: row.grantedQuantity,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    respondedByUserId: row.respondedByUserId,
    responseReason: row.responseReason,
  };
}

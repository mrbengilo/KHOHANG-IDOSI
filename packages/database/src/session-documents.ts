import {
  and,
  asc,
  count,
  desc,
  getTableColumns,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AllocationDecisionDatabaseStatus } from './allocation-decision-gate.js';
import {
  loadAllocationDecisionsForResults,
  type AllocationDecisionRecord,
} from './allocation-decisions.js';
import type { Database } from './client.js';
import {
  allocationLines,
  allocationResultDecisions,
  allocationRuns,
  orderRequestItems,
  orderRequests,
  reservations,
  outboundRequestLines,
  outboundRequests,
  storeWaitDocumentEvents,
  storeWaitDocumentLines,
  storeWaitDocuments,
} from './schema.js';
import type { Transaction } from './transaction.js';
import { withTransaction } from './transaction.js';
import {
  allocationRoundsFromMetadata,
  allocationResultMetadata,
  type ListAllocationResultsInput,
} from './allocation-results.js';

export interface ListSessionDocumentsInput extends ListAllocationResultsInput {
  /** Attach the store decision (and shipment progress) of every document header. */
  readonly includeDecision?: boolean;
  readonly decisionStatus?:
    AllocationDecisionDatabaseStatus | readonly AllocationDecisionDatabaseStatus[];
  /** Attach the store wait documents (PCT) before and after every document's run. */
  readonly includeWaitDocuments?: boolean;
}

export interface SessionWaitDocumentSnapshot {
  readonly id: string;
  readonly code: string;
  /** Opening snapshot of each product: total open bags, split waiting / granted awaiting answer. */
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly remainingQuantity: number;
    readonly pendingQuantity: number;
  }[];
}

export interface SessionWaitDocuments {
  /** The store's wait document just before the run ("phiếu chờ cũ"). */
  readonly before: SessionWaitDocumentSnapshot | null;
  /** The store's wait document right after the run ("phiếu chờ mới"). */
  readonly after: SessionWaitDocumentSnapshot | null;
  /** The run closed/opened the store's document; false when it left the open demand unchanged. */
  readonly changed: boolean;
}

/**
 * The store wait documents around each (run, store) document. A run that changed a store's open
 * demand wrote one immutable `allocation_run` event: the document it closed is the old one and the
 * document it opened is the new one. A run that left the open demand unchanged wrote nothing, so
 * the document current when the run finished is both. Documents are immutable snapshots, so the
 * answer never drifts with later events. Runs older than 0045 find no document at all.
 */
async function loadRunWaitDocuments(
  tx: Transaction,
  headers: readonly { readonly allocationRunId: string; readonly storeId: string }[],
): Promise<Map<string, SessionWaitDocuments>> {
  const key = (runId: string, storeId: string) => `${runId}:${storeId}`;
  const result = new Map<string, SessionWaitDocuments>();
  if (headers.length === 0) return result;
  const events = await tx
    .select({
      id: storeWaitDocumentEvents.id,
      allocationRunId: storeWaitDocumentEvents.allocationRunId,
      storeId: storeWaitDocumentEvents.storeId,
    })
    .from(storeWaitDocumentEvents)
    .where(
      and(
        eq(storeWaitDocumentEvents.kind, 'allocation_run'),
        or(
          ...headers.map((header) =>
            and(
              eq(storeWaitDocumentEvents.storeId, header.storeId),
              eq(storeWaitDocumentEvents.allocationRunId, header.allocationRunId),
            ),
          ),
        ),
      ),
    );
  const eventByHeader = new Map(
    events.map((event) => [key(event.allocationRunId ?? '', event.storeId), event.id]),
  );
  const unchanged = headers.filter(
    (header) => !eventByHeader.has(key(header.allocationRunId, header.storeId)),
  );
  const runTimes = unchanged.length
    ? await tx
        .select({
          id: allocationRuns.id,
          at: sql<Date>`coalesce(${allocationRuns.finishedAt}, ${allocationRuns.createdAt})`.mapWith(
            (value: string | Date) => new Date(value),
          ),
        })
        .from(allocationRuns)
        .where(inArray(allocationRuns.id, [...new Set(unchanged.map((h) => h.allocationRunId))]))
    : [];
  const runTime = new Map(runTimes.map((run) => [run.id, run.at]));
  const eventIds = events.map((event) => event.id);
  const documentPredicates: SQL[] = [];
  if (eventIds.length) {
    documentPredicates.push(inArray(storeWaitDocuments.closedEventId, eventIds));
    documentPredicates.push(inArray(storeWaitDocuments.openedEventId, eventIds));
  }
  for (const header of unchanged) {
    const at = runTime.get(header.allocationRunId);
    if (!at) continue;
    documentPredicates.push(
      and(
        eq(storeWaitDocuments.storeId, header.storeId),
        sql`${storeWaitDocuments.openedAt} <= ${at}`,
        sql`(${storeWaitDocuments.closedAt} is null or ${storeWaitDocuments.closedAt} > ${at})`,
      )!,
    );
  }
  const documents = documentPredicates.length
    ? await tx
        .select({
          id: storeWaitDocuments.id,
          code: storeWaitDocuments.code,
          storeId: storeWaitDocuments.storeId,
          openedEventId: storeWaitDocuments.openedEventId,
          closedEventId: storeWaitDocuments.closedEventId,
          openedAt: storeWaitDocuments.openedAt,
          closedAt: storeWaitDocuments.closedAt,
        })
        .from(storeWaitDocuments)
        .where(or(...documentPredicates))
    : [];
  const lines = documents.length
    ? await tx
        .select({
          documentId: storeWaitDocumentLines.documentId,
          productId: storeWaitDocumentLines.productId,
          carriedIn: storeWaitDocumentLines.carriedInQuantity,
          added: storeWaitDocumentLines.addedQuantity,
          remaining: storeWaitDocumentLines.openingRemainingQuantity,
          pending: storeWaitDocumentLines.openingPendingQuantity,
        })
        .from(storeWaitDocumentLines)
        .where(
          inArray(
            storeWaitDocumentLines.documentId,
            documents.map((document) => document.id),
          ),
        )
        .orderBy(asc(storeWaitDocumentLines.productId))
    : [];
  const snapshot = (
    document: (typeof documents)[number] | undefined,
  ): SessionWaitDocumentSnapshot | null =>
    document
      ? {
          id: document.id,
          code: document.code,
          lines: lines
            .filter((line) => line.documentId === document.id)
            .map((line) => ({
              productId: line.productId,
              quantity: line.carriedIn + line.added,
              remainingQuantity: line.remaining,
              pendingQuantity: line.pending,
            })),
        }
      : null;
  for (const header of headers) {
    const eventId = eventByHeader.get(key(header.allocationRunId, header.storeId));
    if (eventId) {
      result.set(key(header.allocationRunId, header.storeId), {
        before: snapshot(documents.find((document) => document.closedEventId === eventId)),
        after: snapshot(documents.find((document) => document.openedEventId === eventId)),
        changed: true,
      });
      continue;
    }
    const at = runTime.get(header.allocationRunId);
    const current = at
      ? documents.find(
          (document) =>
            document.storeId === header.storeId &&
            document.openedAt <= at &&
            (document.closedAt === null || document.closedAt > at),
        )
      : undefined;
    result.set(key(header.allocationRunId, header.storeId), {
      before: snapshot(current),
      after: snapshot(current),
      changed: false,
    });
  }
  return result;
}

/** Header pagination followed by complete sources in the same MVCC snapshot. No writes. */
export async function listSessionDocuments(database: Database, input: ListSessionDocumentsInput) {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100 ||
    !Number.isSafeInteger((input.page - 1) * input.pageSize)
  )
    throw new RangeError('Invalid document pagination');
  const empty = {
    data: [],
    pagination: { page: input.page, pageSize: input.pageSize, totalItems: 0, totalPages: 0 },
  };
  if (input.storeIds?.length === 0) return empty;
  return withTransaction(
    database,
    async (tx) => {
      const predicates: SQL[] = [
        eq(allocationRuns.status, 'completed'),
        isNull(allocationRuns.deletedAt),
        // A version replaces only its own store/session document. Historical rows remain intact.
        sql`not exists (select 1 from allocation_runs newer join allocation_lines nl on nl.allocation_run_id = newer.id where newer.order_session_id = ${allocationRuns.orderSessionId} and nl.store_id = ${allocationLines.storeId} and newer.status = 'completed' and newer.deleted_at is null and newer.run_number > ${allocationRuns.runNumber})`,
      ];
      if (input.storeIds) predicates.push(inArray(allocationLines.storeId, [...input.storeIds]));
      if (input.sessionId) predicates.push(eq(allocationRuns.orderSessionId, input.sessionId));
      // Matching a source selects its whole header; filters never truncate a document's lines.
      if (input.status) predicates.push(eq(allocationLines.status, input.status));
      if (input.productId) predicates.push(eq(allocationLines.productId, input.productId));
      if (input.priority) predicates.push(eq(allocationLines.priorityLevel, input.priority));
      if (input.decisionStatus) {
        const statuses =
          typeof input.decisionStatus === 'string'
            ? [input.decisionStatus]
            : [...input.decisionStatus];
        // One decision per (run, store) header: a filter, never a join that multiplies rows.
        predicates.push(
          sql`exists (select 1 from ${allocationResultDecisions} where ${allocationResultDecisions.allocationRunId} = ${allocationRuns.id} and ${allocationResultDecisions.storeId} = ${allocationLines.storeId} and ${inArray(allocationResultDecisions.status, statuses)})`,
        );
      }
      const headers = tx
        .select({
          allocationRunId: allocationRuns.id,
          sessionId: allocationRuns.orderSessionId,
          storeId: allocationLines.storeId,
          version: allocationRuns.runNumber,
          createdAt: allocationRuns.createdAt,
        })
        .from(allocationRuns)
        .innerJoin(allocationLines, eq(allocationLines.allocationRunId, allocationRuns.id))
        .where(and(...predicates))
        .groupBy(allocationRuns.id, allocationLines.storeId)
        .as('document_headers');
      const totals = await tx.select({ value: count() }).from(headers);
      const selected = await tx
        .select()
        .from(headers)
        .orderBy(desc(headers.createdAt), desc(headers.allocationRunId), asc(headers.storeId))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const totalItems = totals[0]?.value ?? 0;
      if (!selected.length)
        return {
          ...empty,
          pagination: {
            ...empty.pagination,
            totalItems,
            totalPages: Math.ceil(totalItems / input.pageSize),
          },
        };
      const sources = await tx
        .select({
          line: { ...getTableColumns(allocationLines), decisionMetadata: allocationResultMetadata },
          orderRequestId: orderRequests.id,
          orderRequestCode: orderRequests.code,
          submittedAt: orderRequests.submittedAt,
        })
        .from(allocationLines)
        .leftJoin(orderRequestItems, eq(orderRequestItems.id, allocationLines.orderRequestItemId))
        .leftJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
        .where(
          or(
            ...selected.map((header) =>
              and(
                eq(allocationLines.allocationRunId, header.allocationRunId),
                eq(allocationLines.storeId, header.storeId),
              ),
            ),
          ),
        )
        .orderBy(asc(allocationLines.productId), asc(allocationLines.id));
      // Reservation links survive dispatch/receipt. Read the original quantity, never count it
      // as a new grant in this run, and never infer held goods from today's ticket balance.
      const carried = await tx
        .select({
          targetRunId: outboundRequests.allocationRunId,
          storeId: outboundRequests.storeId,
          allocationLineId: allocationLines.id,
          allocationRunId: allocationLines.allocationRunId,
          productId: allocationLines.productId,
          quantity: reservations.quantity,
          waitTicketId: allocationLines.waitTicketId,
        })
        .from(reservations)
        .innerJoin(allocationLines, eq(reservations.allocationLineId, allocationLines.id))
        .innerJoin(
          outboundRequestLines,
          eq(reservations.outboundRequestLineId, outboundRequestLines.id),
        )
        .innerJoin(
          outboundRequests,
          eq(outboundRequestLines.outboundRequestId, outboundRequests.id),
        )
        .where(
          and(
            ne(allocationLines.allocationRunId, outboundRequests.allocationRunId),
            or(
              ...selected.map((header) =>
                and(
                  eq(outboundRequests.allocationRunId, header.allocationRunId),
                  eq(outboundRequests.storeId, header.storeId),
                ),
              ),
            ),
          ),
        );
      const decisions: readonly AllocationDecisionRecord[] = input.includeDecision
        ? await loadAllocationDecisionsForResults(tx, selected)
        : [];
      const waitDocuments = input.includeWaitDocuments
        ? await loadRunWaitDocuments(tx, selected)
        : null;
      return {
        data: selected.map((header) => ({
          ...header,
          ...(input.includeDecision
            ? {
                decision:
                  decisions.find(
                    (decision) =>
                      decision.allocationRunId === header.allocationRunId &&
                      decision.storeId === header.storeId,
                  ) ?? null,
              }
            : {}),
          ...(waitDocuments
            ? {
                waitDocuments:
                  waitDocuments.get(`${header.allocationRunId}:${header.storeId}`) ?? null,
              }
            : {}),
          carriedAllocations: carried
            .filter(
              (line) =>
                line.targetRunId === header.allocationRunId && line.storeId === header.storeId,
            )
            .map(({ targetRunId: _target, storeId: _store, ...line }) => line),
          sources: sources
            .filter(
              ({ line }) =>
                line.allocationRunId === header.allocationRunId && line.storeId === header.storeId,
            )
            .map(({ line, ...source }) => ({
              ...source,
              orderRequestItemId: line.orderRequestItemId,
              waitTicketId: line.waitTicketId,
              priorityOfferId: line.priorityOfferId,
              result: {
                ...line,
                sessionId: header.sessionId,
                priority: line.priorityLevel,
                appliedPriority: ['P0A', 'P0B', 'P1', 'P2', 'P3'].includes(
                  String(line.decisionMetadata.appliedPriority),
                )
                  ? (line.decisionMetadata.appliedPriority as 'P0A' | 'P0B' | 'P1' | 'P2' | 'P3')
                  : null,
                rounds: allocationRoundsFromMetadata(line.decisionMetadata, line.allocatedQuantity),
                roundsOmitted: line.decisionMetadata.roundsOmitted === true,
              },
            })),
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

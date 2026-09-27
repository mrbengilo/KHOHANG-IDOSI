import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  allocationLines,
  allocationRuns,
  orderRequestItems,
  orderRequests,
  reservations,
  outboundRequestLines,
  outboundRequests,
} from './schema.js';
import { withTransaction } from './transaction.js';
import {
  allocationRoundsFromMetadata,
  type ListAllocationResultsInput,
} from './allocation-results.js';

/** Header pagination followed by complete sources in the same MVCC snapshot. No writes. */
export async function listSessionDocuments(database: Database, input: ListAllocationResultsInput) {
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
          line: allocationLines,
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
      return {
        data: selected.map((header) => ({
          ...header,
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
                roundsOmitted:
                  line.decisionMetadata.policyRoundsVersion === 1 &&
                  Array.isArray(line.decisionMetadata.policyRounds) &&
                  line.decisionMetadata.policyRounds.length > 100 &&
                  line.decisionMetadata.policyRounds.length === line.allocatedQuantity,
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

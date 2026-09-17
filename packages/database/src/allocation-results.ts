import { and, asc, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { allocationLines, allocationRuns } from './schema.js';

export type AllocationResultDatabaseStatus = 'allocated' | 'partial' | 'waitlisted' | 'skipped';

export type AllocationResultPriority = 'P0A' | 'P0B' | 'P1' | 'P2' | 'P3';

export interface AllocationResultRecord {
  readonly id: string;
  readonly allocationRunId: string;
  readonly sessionId: string;
  readonly mergedOrderId: string | null;
  readonly storeId: string;
  readonly productId: string;
  readonly priority: AllocationResultPriority;
  readonly roundNumber: number;
  readonly sequenceInRound: number;
  readonly requestedQuantity: number;
  readonly allocatedQuantity: number;
  readonly waitlistedQuantity: number;
  readonly status: AllocationResultDatabaseStatus;
  readonly reasonCode: string;
  readonly createdAt: Date;
}

export interface ListAllocationResultsInput {
  readonly page: number;
  readonly pageSize: number;
  /** Undefined means all stores; an empty list intentionally means no visible stores. */
  readonly storeIds?: readonly string[];
  readonly sessionId?: string;
  readonly productId?: string;
  readonly status?: AllocationResultDatabaseStatus;
  readonly priority?: AllocationResultPriority;
}

export interface AllocationResultPage {
  readonly data: readonly AllocationResultRecord[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export async function listAllocationResults(
  database: Database,
  input: ListAllocationResultsInput,
): Promise<AllocationResultPage> {
  validatePagination(input.page, input.pageSize);
  if (input.storeIds?.length === 0) return emptyPage(input.page, input.pageSize);

  const predicates: SQL[] = [isNull(allocationRuns.deletedAt)];
  if (input.storeIds !== undefined) {
    predicates.push(inArray(allocationLines.storeId, [...new Set(input.storeIds)]));
  }
  if (input.sessionId !== undefined) {
    predicates.push(eq(allocationRuns.orderSessionId, input.sessionId));
  }
  if (input.productId !== undefined) {
    predicates.push(eq(allocationLines.productId, input.productId));
  }
  if (input.status !== undefined) predicates.push(eq(allocationLines.status, input.status));
  if (input.priority !== undefined) {
    predicates.push(eq(allocationLines.priorityLevel, input.priority));
  }
  const where = and(...predicates);

  const baseQuery = () =>
    database
      .select({
        id: allocationLines.id,
        allocationRunId: allocationLines.allocationRunId,
        sessionId: allocationRuns.orderSessionId,
        mergedOrderId: allocationLines.mergedOrderId,
        storeId: allocationLines.storeId,
        productId: allocationLines.productId,
        priority: allocationLines.priorityLevel,
        roundNumber: allocationLines.roundNumber,
        sequenceInRound: allocationLines.sequenceInRound,
        requestedQuantity: allocationLines.requestedQuantity,
        allocatedQuantity: allocationLines.allocatedQuantity,
        waitlistedQuantity: allocationLines.waitlistedQuantity,
        status: allocationLines.status,
        reasonCode: allocationLines.reasonCode,
        createdAt: allocationLines.createdAt,
      })
      .from(allocationLines)
      .innerJoin(allocationRuns, eq(allocationLines.allocationRunId, allocationRuns.id));

  const [totalRows, data] = await Promise.all([
    database
      .select({ value: count() })
      .from(allocationLines)
      .innerJoin(allocationRuns, eq(allocationLines.allocationRunId, allocationRuns.id))
      .where(where),
    baseQuery()
      .where(where)
      .orderBy(
        desc(allocationRuns.createdAt),
        desc(allocationRuns.id),
        asc(allocationLines.roundNumber),
        asc(allocationLines.sequenceInRound),
        asc(allocationLines.id),
      )
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);
  const totalItems = totalRows[0]?.value ?? 0;
  return {
    data,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize),
    },
  };
}

function emptyPage(page: number, pageSize: number): AllocationResultPage {
  return { data: [], pagination: { page, pageSize, totalItems: 0, totalPages: 0 } };
}

function validatePagination(page: number, pageSize: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('pageSize must be between 1 and 100.');
  }
}

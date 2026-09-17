import { and, asc, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { allocationLines, allocationRuns, type JsonObject } from './schema.js';
import { withTransaction } from './transaction.js';

export type AllocationResultDatabaseStatus = 'allocated' | 'partial' | 'waitlisted' | 'skipped';

export type AllocationResultPriority = 'P0A' | 'P0B' | 'P1' | 'P2' | 'P3';

export interface AllocationResultRoundRecord {
  readonly roundNumber: number;
  readonly allocatedQuantity: number;
}

export interface AllocationResultRecord {
  readonly id: string;
  readonly allocationRunId: string;
  readonly sessionId: string;
  readonly mergedOrderId: string | null;
  readonly storeId: string;
  readonly productId: string;
  readonly priority: AllocationResultPriority;
  /** @deprecated Persistence coordinate only; use `rounds` for policy-round audit data. */
  readonly roundNumber: number;
  /** @deprecated Persistence coordinate only; use `rounds` for policy-round audit data. */
  readonly sequenceInRound: number;
  readonly rounds: readonly AllocationResultRoundRecord[];
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
  const offset = validatePagination(input.page, input.pageSize);
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

  return withTransaction(
    database,
    async (tx) => {
      const totalRows = await tx
        .select({ value: count() })
        .from(allocationLines)
        .innerJoin(allocationRuns, eq(allocationLines.allocationRunId, allocationRuns.id))
        .where(where);
      const rows = await tx
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
          decisionMetadata: allocationLines.decisionMetadata,
          createdAt: allocationLines.createdAt,
        })
        .from(allocationLines)
        .innerJoin(allocationRuns, eq(allocationLines.allocationRunId, allocationRuns.id))
        .where(where)
        .orderBy(desc(allocationLines.createdAt), asc(allocationLines.id))
        .limit(input.pageSize)
        .offset(offset);
      const totalItems = totalRows[0]?.value ?? 0;
      return {
        data: rows.map(({ decisionMetadata, ...row }) => ({
          ...row,
          rounds: allocationRoundsFromMetadata(decisionMetadata, row.allocatedQuantity),
        })),
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

export function allocationRoundsFromMetadata(
  metadata: JsonObject,
  allocatedQuantity: number,
): readonly AllocationResultRoundRecord[] {
  const policyRounds = metadata.policyRounds;
  if (
    !Array.isArray(policyRounds) ||
    !Number.isSafeInteger(allocatedQuantity) ||
    allocatedQuantity < 0 ||
    policyRounds.length !== allocatedQuantity
  ) {
    return [];
  }

  const quantityByRound = new Map<number, number>();
  for (const round of policyRounds) {
    if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 1) return [];
    quantityByRound.set(round, (quantityByRound.get(round) ?? 0) + 1);
  }
  return [...quantityByRound.entries()]
    .sort(([left], [right]) => left - right)
    .map(([roundNumber, roundAllocatedQuantity]) => ({
      roundNumber,
      allocatedQuantity: roundAllocatedQuantity,
    }));
}

function emptyPage(page: number, pageSize: number): AllocationResultPage {
  return { data: [], pagination: { page, pageSize, totalItems: 0, totalPages: 0 } };
}

function validatePagination(page: number, pageSize: number): number {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('pageSize must be between 1 and 100.');
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new RangeError('pagination offset must be a non-negative safe integer.');
  }
  return offset;
}

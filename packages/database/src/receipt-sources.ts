import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  type SQL,
} from 'drizzle-orm';

import type { Database } from './client.js';
import { outboundRequestLines, outboundRequests, storeReceipts } from './schema.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface StoreReceiptSourceListInput {
  readonly page?: number;
  readonly pageSize?: number;
  /** A server-authorized store scope. Authorization itself belongs in the API layer. */
  readonly storeId?: string;
}

export interface StoreReceiptSourceLineRecord {
  readonly productId: string;
  readonly approvedUnits: number;
  readonly dispatchedUnits: number;
}

export interface StoreReceiptSourceRecord {
  readonly id: string;
  readonly requestNumber: string;
  readonly storeId: string;
  readonly dispatchedAt: Date;
  readonly lines: readonly StoreReceiptSourceLineRecord[];
}

export interface StoreReceiptSourcePage {
  readonly data: readonly StoreReceiptSourceRecord[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

interface StoreReceiptSourceHeaderRow {
  readonly id: string;
  readonly requestNumber: string;
  readonly storeId: string;
  readonly dispatchedAt: Date | null;
}

interface StoreReceiptSourceLineRow extends StoreReceiptSourceLineRecord {
  readonly outboundRequestId: string;
  readonly id: string;
}

/**
 * Lists dispatched requests that still have no live receipt declaration.
 * The header page is selected first, followed by one batched line query, so pagination is by
 * outbound request rather than by product line and never creates an N+1 query.
 */
export async function listStoreReceiptSources(
  database: Database,
  input: StoreReceiptSourceListInput,
): Promise<StoreReceiptSourcePage> {
  const pagination = normalizePagination(input);
  const queries = buildStoreReceiptSourcePageQueries(database, input);

  const [totals, headers] = await Promise.all([queries.total, queries.headers]);

  const totalItems = totals[0]?.value ?? 0;
  if (headers.length === 0) {
    return {
      data: [],
      pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
    };
  }

  const lines = await database
    .select({
      id: outboundRequestLines.id,
      outboundRequestId: outboundRequestLines.outboundRequestId,
      productId: outboundRequestLines.productId,
      approvedUnits: outboundRequestLines.approvedQuantity,
      dispatchedUnits: outboundRequestLines.dispatchedQuantity,
    })
    .from(outboundRequestLines)
    .where(
      and(
        inArray(
          outboundRequestLines.outboundRequestId,
          headers.map((header) => header.id),
        ),
        gt(outboundRequestLines.dispatchedQuantity, 0),
      ),
    )
    .orderBy(
      outboundRequestLines.outboundRequestId,
      outboundRequestLines.productId,
      outboundRequestLines.id,
    );

  return {
    data: assembleStoreReceiptSources(headers, lines),
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

/** Builds both header-page queries from one eligibility predicate for SQL-level tests. */
export function buildStoreReceiptSourcePageQueries(
  database: Database,
  input: StoreReceiptSourceListInput,
) {
  const pagination = normalizePagination(input);
  const predicate = eligibleSourcePredicate(database, input.storeId);
  return {
    total: database.select({ value: count() }).from(outboundRequests).where(predicate),
    headers: database
      .select({
        id: outboundRequests.id,
        requestNumber: outboundRequests.requestNumber,
        storeId: outboundRequests.storeId,
        dispatchedAt: outboundRequests.dispatchedAt,
      })
      .from(outboundRequests)
      .where(predicate)
      .orderBy(desc(outboundRequests.dispatchedAt), desc(outboundRequests.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  };
}

/** Kept separate from the query so deterministic aggregate assembly is directly testable. */
export function assembleStoreReceiptSources(
  headers: readonly StoreReceiptSourceHeaderRow[],
  lineRows: readonly StoreReceiptSourceLineRow[],
): readonly StoreReceiptSourceRecord[] {
  const linesBySource = new Map<string, StoreReceiptSourceLineRecord[]>();
  for (const row of lineRows) {
    const lines = linesBySource.get(row.outboundRequestId) ?? [];
    lines.push({
      productId: row.productId,
      approvedUnits: row.approvedUnits,
      dispatchedUnits: row.dispatchedUnits,
    });
    linesBySource.set(row.outboundRequestId, lines);
  }

  return headers.map((header) => {
    if (header.dispatchedAt === null) {
      throw new Error('A receipt source must have a dispatch timestamp.');
    }
    const lines = linesBySource.get(header.id) ?? [];
    lines.sort(
      (left, right) =>
        left.productId.localeCompare(right.productId) ||
        left.approvedUnits - right.approvedUnits ||
        left.dispatchedUnits - right.dispatchedUnits,
    );
    if (lines.length === 0) {
      throw new Error('A receipt source must have at least one dispatched line.');
    }
    return {
      id: header.id,
      requestNumber: header.requestNumber,
      storeId: header.storeId,
      dispatchedAt: header.dispatchedAt,
      lines,
    };
  });
}

function eligibleSourcePredicate(database: Database, storeId: string | undefined): SQL {
  const existingReceipt = database
    .select({ id: storeReceipts.id })
    .from(storeReceipts)
    .where(
      and(
        eq(storeReceipts.outboundRequestId, outboundRequests.id),
        isNull(storeReceipts.deletedAt),
      ),
    );
  const dispatchedLine = database
    .select({ id: outboundRequestLines.id })
    .from(outboundRequestLines)
    .where(
      and(
        eq(outboundRequestLines.outboundRequestId, outboundRequests.id),
        gt(outboundRequestLines.dispatchedQuantity, 0),
      ),
    );
  const incompleteApprovedLine = database
    .select({ id: outboundRequestLines.id })
    .from(outboundRequestLines)
    .where(
      and(
        eq(outboundRequestLines.outboundRequestId, outboundRequests.id),
        gt(outboundRequestLines.approvedQuantity, 0),
        ne(outboundRequestLines.approvedQuantity, outboundRequestLines.dispatchedQuantity),
      ),
    );
  const conditions: SQL[] = [
    eq(outboundRequests.status, 'dispatched'),
    isNull(outboundRequests.deletedAt),
    isNotNull(outboundRequests.dispatchedAt),
    exists(dispatchedLine),
    notExists(incompleteApprovedLine),
    notExists(existingReceipt),
  ];
  if (storeId !== undefined) {
    conditions.push(eq(outboundRequests.storeId, storeId));
  }
  const predicate = and(...conditions);
  if (predicate === undefined) {
    throw new Error('A receipt source predicate could not be constructed.');
  }
  return predicate;
}

function normalizePagination(input: StoreReceiptSourceListInput): {
  readonly page: number;
  readonly pageSize: number;
} {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize };
}

function pageMetadata(
  page: number,
  pageSize: number,
  totalItems: number,
): StoreReceiptSourcePage['pagination'] {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

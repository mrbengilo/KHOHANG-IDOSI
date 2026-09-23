import { and, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  htkdAssignments,
  outboundRequestLines,
  outboundRequests,
  reservations,
  users,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

export type WarehouseOutboundDatabaseStatus =
  'reserved' | 'dispatched' | 'partially_received' | 'received' | 'completed' | 'cancelled';

export interface WarehouseOutboundRequestLineRecord {
  readonly id: string;
  readonly allocationLineId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly approvedQuantity: number;
  readonly reservedQuantity: number;
  readonly dispatchedQuantity: number;
  readonly receivedQuantity: number;
}

export interface WarehouseOutboundRequestRecord {
  readonly id: string;
  readonly requestNumber: string;
  readonly storeId: string;
  readonly orderSessionId: string | null;
  readonly allocationRunId: string | null;
  readonly status: WarehouseOutboundDatabaseStatus;
  readonly requestedByUserId: string;
  readonly dispatchedByUserId: string | null;
  readonly lines: readonly WarehouseOutboundRequestLineRecord[];
  readonly version: number;
  readonly notes: string | null;
  readonly dispatchedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListWarehouseOutboundRequestsInput {
  readonly page: number;
  readonly pageSize: number;
  readonly storeIds?: readonly string[];
  readonly status?: WarehouseOutboundDatabaseStatus;
  readonly allocationRunId?: string;
}

export interface WarehouseOutboundRequestPage {
  readonly data: readonly WarehouseOutboundRequestRecord[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export interface DispatchWarehouseOutboundRequestInput {
  readonly outboundRequestId: string;
  readonly expectedVersion: number;
  readonly dispatchedByUserId: string;
  readonly dispatchNote?: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
  readonly dispatchedAt?: Date;
}

export class WarehouseOutboundAuthorizationError extends Error {
  public readonly code = 'WAREHOUSE_OUTBOUND_FORBIDDEN';

  public constructor() {
    super('The dispatcher is not allowed to manage this store.');
    this.name = 'WarehouseOutboundAuthorizationError';
  }
}

export class WarehouseOutboundConflictError extends Error {
  public readonly code = 'WAREHOUSE_OUTBOUND_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'WarehouseOutboundConflictError';
  }
}

export class WarehouseOutboundNotFoundError extends Error {
  public readonly code = 'WAREHOUSE_OUTBOUND_NOT_FOUND';

  public constructor() {
    super('Warehouse outbound request does not exist.');
    this.name = 'WarehouseOutboundNotFoundError';
  }
}

export class WarehouseOutboundValidationError extends Error {
  public readonly code = 'WAREHOUSE_OUTBOUND_VALIDATION_ERROR';

  public constructor(message: string) {
    super(message);
    this.name = 'WarehouseOutboundValidationError';
  }
}

export async function listWarehouseOutboundRequests(
  database: Database,
  input: ListWarehouseOutboundRequestsInput,
): Promise<WarehouseOutboundRequestPage> {
  validatePagination(input.page, input.pageSize);
  if (input.storeIds?.length === 0) {
    return {
      data: [],
      pagination: { page: input.page, pageSize: input.pageSize, totalItems: 0, totalPages: 0 },
    };
  }
  const predicates: SQL[] = [
    isNull(outboundRequests.deletedAt),
    inArray(outboundRequests.status, [
      'reserved',
      'dispatched',
      'partially_received',
      'received',
      'completed',
      'cancelled',
    ]),
  ];
  if (input.storeIds !== undefined) {
    predicates.push(inArray(outboundRequests.storeId, [...input.storeIds]));
  }
  if (input.status !== undefined) predicates.push(eq(outboundRequests.status, input.status));
  if (input.allocationRunId !== undefined) {
    predicates.push(eq(outboundRequests.allocationRunId, input.allocationRunId));
  }
  const where = and(...predicates);
  const [totalRows, headers] = await Promise.all([
    database.select({ value: count() }).from(outboundRequests).where(where),
    database
      .select()
      .from(outboundRequests)
      .where(where)
      .orderBy(desc(outboundRequests.createdAt), desc(outboundRequests.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);
  const data = await assembleRecords(database, headers);
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

export async function getWarehouseOutboundRequest(
  database: Database,
  outboundRequestId: string,
): Promise<WarehouseOutboundRequestRecord> {
  const [header] = await database
    .select()
    .from(outboundRequests)
    .where(and(eq(outboundRequests.id, outboundRequestId), isNull(outboundRequests.deletedAt)))
    .limit(1);
  if (!header) throw new WarehouseOutboundNotFoundError();
  const [record] = await assembleRecords(database, [header]);
  if (!record) throw new WarehouseOutboundNotFoundError();
  return record;
}

export async function dispatchWarehouseOutboundRequest(
  database: Database,
  input: DispatchWarehouseOutboundRequestInput,
): Promise<IdempotencyResult<WarehouseOutboundRequestRecord>> {
  validateDispatchInput(input);
  return withIdempotency(
    database,
    {
      scope: `warehouse-outbound.dispatch:${input.outboundRequestId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const record = await dispatchWarehouseOutboundInTransaction(tx, {
        outboundRequestId: input.outboundRequestId,
        expectedVersion: input.expectedVersion,
        dispatcher: { kind: 'user', userId: input.dispatchedByUserId },
        dispatchNote: input.dispatchNote ?? null,
        requestId: input.requestId ?? null,
        ...(input.dispatchedAt === undefined ? {} : { dispatchedAt: input.dispatchedAt }),
      });
      return {
        value: record,
        responseStatus: 200,
        responseBody: {
          outboundRequestId: record.id,
          status: record.status,
          version: record.version,
          dispatchedAt: record.dispatchedAt?.toISOString() ?? null,
        },
        resourceType: 'outbound_request',
        resourceId: record.id,
      };
    },
  );
}

/**
 * Who releases a shipment. A user dispatch is authorized against the store; a system dispatch
 * is only reachable from server-side code (the 09:00 worker and the audited backfill), never
 * from an HTTP request, so it carries no account and records why it ran instead.
 */
export type WarehouseOutboundDispatcher =
  | { readonly kind: 'user'; readonly userId: string }
  | {
      readonly kind: 'system';
      readonly trigger: 'allocation-finalize' | 'stranded-outbound-backfill';
    };

export interface DispatchWarehouseOutboundInTransactionInput {
  readonly outboundRequestId: string;
  readonly expectedVersion: number;
  readonly dispatcher: WarehouseOutboundDispatcher;
  readonly dispatchNote?: string | null;
  readonly requestId?: string | null;
  readonly dispatchedAt?: Date;
  /** Deterministic audit id so a replayed system dispatch cannot write a second audit row. */
  readonly auditId?: string;
}

/**
 * The only place a warehouse outbound moves from reserved to dispatched. Dispatch releases the
 * shipment to the store; it does not move warehouse stock. On-hand stock leaves the warehouse
 * once, when HTKD finalizes the store receipt, and the reservation keeps it out of other
 * allocations until then.
 */
export async function dispatchWarehouseOutboundInTransaction(
  tx: Transaction,
  input: DispatchWarehouseOutboundInTransactionInput,
): Promise<WarehouseOutboundRequestRecord> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new WarehouseOutboundValidationError(
      'expectedVersion must be a non-negative safe integer.',
    );
  }
  if (input.dispatchedAt !== undefined && Number.isNaN(input.dispatchedAt.getTime())) {
    throw new WarehouseOutboundValidationError('dispatchedAt must be a valid instant.');
  }
  const dispatchNote = normalizeDispatchNote(input.dispatchNote);

  return withAdvisoryLock(tx, 'warehouse-outbound', input.outboundRequestId, async () => {
    const [outbound] = await tx
      .select()
      .from(outboundRequests)
      .where(
        and(eq(outboundRequests.id, input.outboundRequestId), isNull(outboundRequests.deletedAt)),
      )
      .for('update')
      .limit(1);
    if (!outbound) throw new WarehouseOutboundNotFoundError();
    const dispatcherRole =
      input.dispatcher.kind === 'user'
        ? await assertDispatcherMayAccessStore(tx, input.dispatcher.userId, outbound.storeId)
        : null;
    if (outbound.status !== 'reserved' || outbound.version !== input.expectedVersion) {
      throw new WarehouseOutboundConflictError(
        'Warehouse outbound is stale or is not ready for dispatch.',
      );
    }

    const lines = await tx
      .select()
      .from(outboundRequestLines)
      .where(eq(outboundRequestLines.outboundRequestId, outbound.id))
      .orderBy(outboundRequestLines.productId, outboundRequestLines.id)
      .for('update');
    if (lines.length === 0) {
      throw new WarehouseOutboundValidationError('Warehouse outbound has no product lines.');
    }
    if (
      lines.some(
        (line) =>
          line.allocationLineId === null ||
          line.approvedQuantity <= 0 ||
          line.reservedQuantity !== line.approvedQuantity ||
          line.dispatchedQuantity !== 0 ||
          line.receivedQuantity !== 0,
      )
    ) {
      throw new WarehouseOutboundValidationError(
        'Warehouse outbound line quantities are not fully reserved for dispatch.',
      );
    }

    const lineIds = lines.map((line) => line.id);
    const activeReservations = await tx
      .select({
        outboundRequestLineId: reservations.outboundRequestLineId,
        quantity: reservations.quantity,
      })
      .from(reservations)
      .where(
        and(
          inArray(reservations.outboundRequestLineId, lineIds),
          eq(reservations.status, 'active'),
          isNull(reservations.deletedAt),
        ),
      )
      .for('update');
    const reservedByLine = new Map<string, number>();
    for (const reservation of activeReservations) {
      if (reservation.outboundRequestLineId === null) continue;
      reservedByLine.set(
        reservation.outboundRequestLineId,
        (reservedByLine.get(reservation.outboundRequestLineId) ?? 0) + reservation.quantity,
      );
    }
    if (lines.some((line) => reservedByLine.get(line.id) !== line.reservedQuantity)) {
      throw new WarehouseOutboundValidationError(
        'Active reservations do not conserve the outbound dispatch quantity.',
      );
    }

    const dispatchedAt = input.dispatchedAt ?? new Date();
    for (const line of lines) {
      await tx
        .update(outboundRequestLines)
        .set({ dispatchedQuantity: line.approvedQuantity, updatedAt: dispatchedAt })
        .where(
          and(eq(outboundRequestLines.id, line.id), eq(outboundRequestLines.dispatchedQuantity, 0)),
        );
    }
    const [updated] = await tx
      .update(outboundRequests)
      .set({
        status: 'dispatched',
        dispatchedByUserId: input.dispatcher.kind === 'user' ? input.dispatcher.userId : null,
        dispatchedAt,
        notes: dispatchNote ?? outbound.notes,
        version: outbound.version + 1,
        updatedAt: dispatchedAt,
      })
      .where(
        and(
          eq(outboundRequests.id, outbound.id),
          eq(outboundRequests.version, input.expectedVersion),
          eq(outboundRequests.status, 'reserved'),
          isNull(outboundRequests.deletedAt),
        ),
      )
      .returning();
    if (!updated) {
      throw new WarehouseOutboundConflictError('Warehouse outbound changed during dispatch.');
    }

    const dispatchedLines: WarehouseOutboundRequestLineRecord[] = lines.map((line) => ({
      id: line.id,
      allocationLineId: line.allocationLineId!,
      productId: line.productId,
      requestedQuantity: line.requestedQuantity,
      approvedQuantity: line.approvedQuantity,
      reservedQuantity: line.reservedQuantity,
      dispatchedQuantity: line.approvedQuantity,
      receivedQuantity: line.receivedQuantity,
    }));
    const metadata: JsonObject = {
      ...(dispatchNote ? { dispatchNote } : {}),
      ...(input.dispatcher.kind === 'system'
        ? { dispatchedBy: 'system', trigger: input.dispatcher.trigger }
        : {}),
    };
    await tx.insert(auditLogs).values({
      ...(input.auditId === undefined ? {} : { id: input.auditId }),
      requestId: input.requestId ?? null,
      actorUserId: input.dispatcher.kind === 'user' ? input.dispatcher.userId : null,
      actorRole: dispatcherRole,
      actorStoreId: outbound.storeId,
      action: 'OUTBOUND_REQUEST_DISPATCHED',
      entityType: 'outbound_request',
      entityId: outbound.id,
      before: outboundAuditSnapshot(outbound, lines),
      after: outboundAuditSnapshot(updated, dispatchedLines),
      metadata,
      createdAt: dispatchedAt,
    });

    return recordFromRows(updated, dispatchedLines);
  });
}

async function assembleRecords(
  database: Database,
  headers: readonly (typeof outboundRequests.$inferSelect)[],
): Promise<readonly WarehouseOutboundRequestRecord[]> {
  if (headers.length === 0) return [];
  const lines = await database
    .select()
    .from(outboundRequestLines)
    .where(
      inArray(
        outboundRequestLines.outboundRequestId,
        headers.map((header) => header.id),
      ),
    )
    .orderBy(
      outboundRequestLines.outboundRequestId,
      outboundRequestLines.productId,
      outboundRequestLines.id,
    );
  const linesByRequest = new Map<string, WarehouseOutboundRequestLineRecord[]>();
  for (const line of lines) {
    if (line.allocationLineId === null) {
      throw new WarehouseOutboundValidationError(
        `Outbound request line ${line.id} has no allocation provenance.`,
      );
    }
    const group = linesByRequest.get(line.outboundRequestId) ?? [];
    group.push({
      id: line.id,
      allocationLineId: line.allocationLineId,
      productId: line.productId,
      requestedQuantity: line.requestedQuantity,
      approvedQuantity: line.approvedQuantity,
      reservedQuantity: line.reservedQuantity,
      dispatchedQuantity: line.dispatchedQuantity,
      receivedQuantity: line.receivedQuantity,
    });
    linesByRequest.set(line.outboundRequestId, group);
  }
  return headers.map((header) => {
    const requestLines = linesByRequest.get(header.id) ?? [];
    if (requestLines.length === 0) {
      throw new WarehouseOutboundValidationError(
        `Outbound request ${header.id} has no product lines.`,
      );
    }
    return recordFromRows(header, requestLines);
  });
}

function recordFromRows(
  header: typeof outboundRequests.$inferSelect,
  lines: readonly WarehouseOutboundRequestLineRecord[],
): WarehouseOutboundRequestRecord {
  if (header.status === 'draft' || header.status === 'submitted' || header.status === 'approved') {
    throw new WarehouseOutboundValidationError(
      `Outbound request ${header.id} is not materialized for warehouse dispatch.`,
    );
  }
  return {
    id: header.id,
    requestNumber: header.requestNumber,
    storeId: header.storeId,
    orderSessionId: header.orderSessionId,
    allocationRunId: header.allocationRunId,
    status: header.status,
    requestedByUserId: header.requestedByUserId,
    dispatchedByUserId: header.dispatchedByUserId,
    lines,
    version: header.version,
    notes: header.notes,
    dispatchedAt: header.dispatchedAt,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
  };
}

async function assertDispatcherMayAccessStore(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<'admin' | 'htkd'> {
  const [user] = await tx
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  // Only warehouse roles release shipments; store and wholesale-desk accounts receive them.
  if (!user || user.status !== 'active' || (user.role !== 'admin' && user.role !== 'htkd')) {
    throw new WarehouseOutboundAuthorizationError();
  }
  if (user.role === 'admin') return 'admin';
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
  if (!assignment) throw new WarehouseOutboundAuthorizationError();
  return 'htkd';
}

function validateDispatchInput(input: DispatchWarehouseOutboundRequestInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new WarehouseOutboundValidationError(
      'expectedVersion must be a non-negative safe integer.',
    );
  }
  normalizeDispatchNote(input.dispatchNote);
  if (input.dispatchedAt !== undefined && Number.isNaN(input.dispatchedAt.getTime())) {
    throw new WarehouseOutboundValidationError('dispatchedAt must be a valid instant.');
  }
}

function normalizeDispatchNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 500) {
    throw new WarehouseOutboundValidationError(
      'dispatchNote must contain between 3 and 500 characters.',
    );
  }
  return normalized;
}

function validatePagination(page: number, pageSize: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('page must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('pageSize must be between 1 and 100.');
  }
}

function outboundAuditSnapshot(
  header: typeof outboundRequests.$inferSelect,
  lines: readonly {
    readonly id: string;
    readonly approvedQuantity: number;
    readonly dispatchedQuantity: number;
  }[],
): JsonObject {
  return {
    requestNumber: header.requestNumber,
    status: header.status,
    storeId: header.storeId,
    version: header.version,
    dispatchedAt: header.dispatchedAt?.toISOString() ?? null,
    lines: lines.map((line) => ({
      id: line.id,
      approvedQuantity: line.approvedQuantity,
      dispatchedQuantity: line.dispatchedQuantity,
    })),
  };
}

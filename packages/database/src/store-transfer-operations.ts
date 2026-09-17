import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  withIdempotency,
  type IdempotencyResult,
  type IdempotentOperationResult,
} from './idempotency.js';
import {
  auditLogs,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  stores,
  storeTransfers,
  users,
  type JsonObject,
} from './schema.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationConflictError,
  StoreOperationValidationError,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

type TransferStatus = typeof storeTransfers.$inferSelect.status;
type TransferRow = typeof storeTransfers.$inferSelect;

export interface StoreTransferPageInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly storeId?: string;
  readonly storeIds?: readonly string[];
  readonly sourceStoreId?: string;
  readonly destinationStoreId?: string;
  readonly productId?: string;
  readonly status?: TransferStatus;
}

export interface StoreTransferPage {
  readonly data: readonly TransferRow[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export interface CreateStoreTransferInput {
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly sourceInventoryBagId: string;
  readonly weightKg: string;
  readonly expectedSourceBagVersion: number;
  readonly note: string | null;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface DispatchStoreTransferInput {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly expectedSourceBagVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface ReceiveStoreTransferInput {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CancelStoreTransferInput {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface StoreTransferMutationResult {
  readonly transferId: string;
  readonly status: TransferStatus;
  readonly version: number;
  readonly sourceInventoryBagVersion: number | null;
  readonly destinationInventoryBagId: string | null;
}

export class StoreTransferAuthorizationError extends Error {
  public readonly code = 'STORE_TRANSFER_FORBIDDEN';

  public constructor(message = 'The account cannot mutate this store transfer.') {
    super(message);
    this.name = 'StoreTransferAuthorizationError';
  }
}

export class StoreTransferNotFoundError extends Error {
  public readonly code = 'STORE_TRANSFER_NOT_FOUND';

  public constructor() {
    super('Store transfer was not found.');
    this.name = 'StoreTransferNotFoundError';
  }
}

export async function listStoreTransfers(
  database: Database,
  input: StoreTransferPageInput,
): Promise<StoreTransferPage> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  validatePage(page, pageSize);
  const predicates: SQL[] = [];
  if (input.storeId !== undefined) {
    predicates.push(
      or(
        eq(storeTransfers.sourceStoreId, input.storeId),
        eq(storeTransfers.destinationStoreId, input.storeId),
      )!,
    );
  }
  if (input.storeIds !== undefined) {
    if (input.storeIds.length === 0) {
      return {
        data: [],
        pagination: { page, pageSize, totalItems: 0, totalPages: 0 },
      };
    }
    predicates.push(
      or(
        inArray(storeTransfers.sourceStoreId, [...input.storeIds]),
        inArray(storeTransfers.destinationStoreId, [...input.storeIds]),
      )!,
    );
  }
  if (input.sourceStoreId !== undefined) {
    predicates.push(eq(storeTransfers.sourceStoreId, input.sourceStoreId));
  }
  if (input.destinationStoreId !== undefined) {
    predicates.push(eq(storeTransfers.destinationStoreId, input.destinationStoreId));
  }
  if (input.productId !== undefined) predicates.push(eq(storeTransfers.productId, input.productId));
  if (input.status !== undefined) predicates.push(eq(storeTransfers.status, input.status));
  const where = predicates.length === 0 ? undefined : and(...predicates);
  const [totals, rows] = await Promise.all([
    database.select({ value: count() }).from(storeTransfers).where(where),
    database
      .select()
      .from(storeTransfers)
      .where(where)
      .orderBy(desc(storeTransfers.createdAt), asc(storeTransfers.transferNumber))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
    },
  };
}

export async function createStoreTransfer(
  database: Database,
  input: CreateStoreTransferInput,
): Promise<IdempotencyResult<StoreTransferMutationResult>> {
  validateCreate(input);
  return withIdempotency(
    database,
    {
      scope: `store-transfer.create:${input.sourceStoreId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-inventory-bag', input.sourceInventoryBagId, async () => {
        await assertActiveRetailStoreActor(tx, input.actorUserId, input.sourceStoreId);
        await assertActiveRetailDestination(tx, input.destinationStoreId);
        const [bag] = await tx
          .select()
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.id, input.sourceInventoryBagId))
          .for('update')
          .limit(1);
        if (!bag || bag.storeId !== input.sourceStoreId) {
          throw new StoreTransferAuthorizationError();
        }
        if (
          bag.version !== input.expectedSourceBagVersion ||
          (bag.status !== 'available' && bag.status !== 'opened')
        ) {
          throw new StoreOperationConflictError('Source inventory bag is stale or unavailable.');
        }
        if (kilogramsToGramsExact(input.weightKg) > kilogramsToGramsExact(bag.currentWeightKg)) {
          throw new StoreOperationValidationError('Transfer weight exceeds available inventory.');
        }
        const now = new Date();
        const [created] = await tx
          .insert(storeTransfers)
          .values({
            transferNumber: transferNumber(now),
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            sourceInventoryBagId: bag.id,
            productId: bag.productId,
            weightKg: input.weightKg,
            note: input.note,
            createdByUserId: input.actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storeTransfers.id, version: storeTransfers.version });
        if (!created) throw new Error('Store transfer insert did not return a row.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.sourceStoreId,
          action: 'STORE_TRANSFER_CREATED',
          entityType: 'store_transfer',
          entityId: created.id,
          after: {
            status: 'draft',
            version: created.version,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            sourceInventoryBagId: bag.id,
            sourceInventoryBagVersion: bag.version,
            productId: bag.productId,
            weightKg: input.weightKg,
          },
        });
        return mutationResult(created.id, 'draft', created.version, null, null, 201);
      }),
  );
}

export async function dispatchStoreTransfer(
  database: Database,
  input: DispatchStoreTransferInput,
): Promise<IdempotencyResult<StoreTransferMutationResult>> {
  validateVersion(input.expectedVersion);
  validateVersion(input.expectedSourceBagVersion);
  return withIdempotency(
    database,
    {
      scope: `store-transfer.dispatch:${input.transferId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-transfer', input.transferId, async () => {
        const [transfer] = await tx
          .select()
          .from(storeTransfers)
          .where(eq(storeTransfers.id, input.transferId))
          .for('update')
          .limit(1);
        if (!transfer) throw new StoreTransferNotFoundError();
        await assertActiveRetailStoreActor(tx, input.actorUserId, transfer.sourceStoreId);
        if (transfer.status !== 'draft' || transfer.version !== input.expectedVersion) {
          throw new StoreOperationConflictError('Transfer is stale or cannot be dispatched.');
        }
        return withAdvisoryLock(
          tx,
          'store-inventory-bag',
          transfer.sourceInventoryBagId,
          async () => {
            const [bag] = await tx
              .select()
              .from(storeInventoryBags)
              .where(eq(storeInventoryBags.id, transfer.sourceInventoryBagId))
              .for('update')
              .limit(1);
            if (
              !bag ||
              bag.storeId !== transfer.sourceStoreId ||
              bag.productId !== transfer.productId
            ) {
              throw new StoreOperationValidationError('Transfer source provenance is invalid.');
            }
            if (
              bag.version !== input.expectedSourceBagVersion ||
              (bag.status !== 'available' && bag.status !== 'opened')
            ) {
              throw new StoreOperationConflictError(
                'Source inventory bag is stale or unavailable.',
              );
            }
            const beforeGrams = kilogramsToGramsExact(bag.currentWeightKg);
            const movedGrams = kilogramsToGramsExact(transfer.weightKg);
            if (movedGrams <= 0n || movedGrams > beforeGrams) {
              throw new StoreOperationValidationError(
                'Transfer weight exceeds available inventory.',
              );
            }
            const afterGrams = beforeGrams - movedGrams;
            const { movedCostVnd, remainingCostVnd } = allocateTransferCostVnd(
              bag.costVnd,
              beforeGrams,
              movedGrams,
            );
            if (movedCostVnd > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new StoreOperationValidationError(
                'Transfer cost exceeds the safe API VND range.',
              );
            }
            const now = new Date();
            const [updatedBag] = await tx
              .update(storeInventoryBags)
              .set({
                currentWeightKg: gramsToKilogramsExact(afterGrams),
                costVnd: remainingCostVnd,
                status: afterGrams === 0n ? 'depleted' : 'opened',
                openedAt: bag.openedAt ?? now,
                depletedAt: afterGrams === 0n ? now : null,
                version: bag.version + 1,
                updatedAt: now,
              })
              .where(
                and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)),
              )
              .returning({ version: storeInventoryBags.version });
            if (!updatedBag)
              throw new StoreOperationConflictError('Source bag changed during dispatch.');
            const [updatedTransfer] = await tx
              .update(storeTransfers)
              .set({
                status: 'in_transit',
                costVnd: movedCostVnd,
                dispatchedByUserId: input.actorUserId,
                dispatchedAt: now,
                version: transfer.version + 1,
                updatedAt: now,
              })
              .where(
                and(
                  eq(storeTransfers.id, transfer.id),
                  eq(storeTransfers.version, input.expectedVersion),
                  eq(storeTransfers.status, 'draft'),
                ),
              )
              .returning({ version: storeTransfers.version });
            if (!updatedTransfer)
              throw new StoreOperationConflictError('Transfer changed during dispatch.');
            await tx.insert(storeInventoryLedgerEntries).values({
              storeInventoryBagId: bag.id,
              storeId: bag.storeId,
              productId: bag.productId,
              eventType: 'consume',
              weightBeforeKg: bag.currentWeightKg,
              weightAfterKg: gramsToKilogramsExact(afterGrams),
              sourceType: 'store_transfer_dispatch',
              sourceId: transfer.id,
              reason: `Transfer dispatched to store ${transfer.destinationStoreId}`,
              metadata: {
                transferCostVnd: movedCostVnd.toString(),
                remainingCostVnd: remainingCostVnd.toString(),
              },
              actorUserId: input.actorUserId,
              occurredAt: now,
            });
            await tx.insert(auditLogs).values({
              requestId: input.requestId,
              actorUserId: input.actorUserId,
              actorRole: 'store',
              actorStoreId: transfer.sourceStoreId,
              action: 'STORE_TRANSFER_DISPATCHED',
              entityType: 'store_transfer',
              entityId: transfer.id,
              before: transferSnapshot(transfer),
              after: {
                ...transferSnapshot(transfer),
                status: 'in_transit',
                version: updatedTransfer.version,
                costVnd: movedCostVnd.toString(),
                sourceInventoryBagVersion: updatedBag.version,
              },
            });
            return mutationResult(
              transfer.id,
              'in_transit',
              updatedTransfer.version,
              updatedBag.version,
              null,
            );
          },
        );
      }),
  );
}

export async function receiveStoreTransfer(
  database: Database,
  input: ReceiveStoreTransferInput,
): Promise<IdempotencyResult<StoreTransferMutationResult>> {
  validateVersion(input.expectedVersion);
  return withIdempotency(
    database,
    {
      scope: `store-transfer.receive:${input.transferId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-transfer', input.transferId, async () => {
        const [transfer] = await tx
          .select()
          .from(storeTransfers)
          .where(eq(storeTransfers.id, input.transferId))
          .for('update')
          .limit(1);
        if (!transfer) throw new StoreTransferNotFoundError();
        await assertActiveRetailStoreActor(tx, input.actorUserId, transfer.destinationStoreId);
        if (
          transfer.status !== 'in_transit' ||
          transfer.version !== input.expectedVersion ||
          transfer.costVnd === null
        ) {
          throw new StoreOperationConflictError('Transfer is stale or cannot be received.');
        }
        const now = new Date();
        const destinationBagId = randomUUID();
        const bagCode = `TR-${transfer.transferNumber}-${destinationBagId.slice(0, 8).toUpperCase()}`;
        await tx.insert(storeInventoryBags).values({
          id: destinationBagId,
          bagCode,
          storeId: transfer.destinationStoreId,
          productId: transfer.productId,
          sourceStoreReceiptBagId: null,
          sourceTransferId: transfer.id,
          sourceInventoryBagId: transfer.sourceInventoryBagId,
          outboundRequestLineId: null,
          sourceReceiptBagWeightId: null,
          status: 'available',
          initialWeightKg: transfer.weightKg,
          currentWeightKg: transfer.weightKg,
          costVnd: transfer.costVnd,
          receivedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const [updated] = await tx
          .update(storeTransfers)
          .set({
            status: 'received',
            destinationInventoryBagId: destinationBagId,
            receivedByUserId: input.actorUserId,
            receivedAt: now,
            version: transfer.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(storeTransfers.id, transfer.id),
              eq(storeTransfers.version, input.expectedVersion),
              eq(storeTransfers.status, 'in_transit'),
            ),
          )
          .returning({ version: storeTransfers.version });
        if (!updated) throw new StoreOperationConflictError('Transfer changed during receipt.');
        await tx.insert(storeInventoryLedgerEntries).values({
          storeInventoryBagId: destinationBagId,
          storeId: transfer.destinationStoreId,
          productId: transfer.productId,
          eventType: 'receive',
          weightBeforeKg: '0.000',
          weightAfterKg: transfer.weightKg,
          sourceType: 'store_transfer_receive',
          sourceId: transfer.id,
          reason: `Transfer received from store ${transfer.sourceStoreId}`,
          metadata: {
            sourceInventoryBagId: transfer.sourceInventoryBagId,
            transferCostVnd: transfer.costVnd.toString(),
          },
          actorUserId: input.actorUserId,
          occurredAt: now,
        });
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: transfer.destinationStoreId,
          action: 'STORE_TRANSFER_RECEIVED',
          entityType: 'store_transfer',
          entityId: transfer.id,
          before: transferSnapshot(transfer),
          after: {
            ...transferSnapshot(transfer),
            status: 'received',
            version: updated.version,
            destinationInventoryBagId: destinationBagId,
          },
        });
        return mutationResult(transfer.id, 'received', updated.version, null, destinationBagId);
      }),
  );
}

export async function cancelStoreTransfer(
  database: Database,
  input: CancelStoreTransferInput,
): Promise<IdempotencyResult<StoreTransferMutationResult>> {
  validateVersion(input.expectedVersion);
  if (input.reason.trim().length < 3)
    throw new StoreOperationValidationError('Cancellation reason is required.');
  return withIdempotency(
    database,
    {
      scope: `store-transfer.cancel:${input.transferId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-transfer', input.transferId, async () => {
        const [transfer] = await tx
          .select()
          .from(storeTransfers)
          .where(eq(storeTransfers.id, input.transferId))
          .for('update')
          .limit(1);
        if (!transfer) throw new StoreTransferNotFoundError();
        await assertActiveRetailStoreActor(tx, input.actorUserId, transfer.sourceStoreId);
        if (transfer.status !== 'draft' || transfer.version !== input.expectedVersion) {
          throw new StoreOperationConflictError(
            'Only the current draft transfer can be cancelled.',
          );
        }
        const now = new Date();
        const [updated] = await tx
          .update(storeTransfers)
          .set({
            status: 'cancelled',
            cancellationReason: input.reason,
            cancelledAt: now,
            version: transfer.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(storeTransfers.id, transfer.id),
              eq(storeTransfers.version, input.expectedVersion),
              eq(storeTransfers.status, 'draft'),
            ),
          )
          .returning({ version: storeTransfers.version });
        if (!updated)
          throw new StoreOperationConflictError('Transfer changed during cancellation.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: transfer.sourceStoreId,
          action: 'STORE_TRANSFER_CANCELLED',
          entityType: 'store_transfer',
          entityId: transfer.id,
          before: transferSnapshot(transfer),
          after: {
            ...transferSnapshot(transfer),
            status: 'cancelled',
            version: updated.version,
            cancellationReason: input.reason,
          },
        });
        return mutationResult(transfer.id, 'cancelled', updated.version, null, null);
      }),
  );
}

async function assertActiveRetailStoreActor(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<void> {
  const [[store], [user]] = await Promise.all([
    tx
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(
          eq(stores.id, storeId),
          eq(stores.kind, 'retail'),
          eq(stores.isActive, true),
          isNull(stores.deletedAt),
        ),
      )
      .limit(1),
    tx
      .select({ role: users.role, status: users.status, storeId: users.storeId })
      .from(users)
      .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
      .limit(1),
  ]);
  if (
    !store ||
    !user ||
    user.role !== 'store' ||
    user.status !== 'active' ||
    user.storeId !== storeId
  ) {
    throw new StoreTransferAuthorizationError();
  }
}

async function assertActiveRetailDestination(
  tx: Transaction,
  destinationStoreId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(
      and(
        eq(stores.id, destinationStoreId),
        eq(stores.kind, 'retail'),
        eq(stores.isActive, true),
        isNull(stores.deletedAt),
      ),
    )
    .limit(1);
  if (!store)
    throw new StoreOperationValidationError('Destination must be an active retail store.');
}

function validateCreate(input: CreateStoreTransferInput): void {
  if (input.sourceStoreId === input.destinationStoreId)
    throw new StoreOperationValidationError('Source and destination stores must differ.');
  validateVersion(input.expectedSourceBagVersion);
  if (kilogramsToGramsExact(input.weightKg) <= 0n)
    throw new StoreOperationValidationError('Transfer weight must be positive.');
}

/** Allocates whole VND proportionally, assigning all rounding residue to the source bag. */
export function allocateTransferCostVnd(
  sourceCostVnd: bigint,
  sourceWeightGrams: bigint,
  movedWeightGrams: bigint,
): { readonly movedCostVnd: bigint; readonly remainingCostVnd: bigint } {
  if (sourceCostVnd < 0n)
    throw new StoreOperationValidationError('Source cost cannot be negative.');
  if (sourceWeightGrams <= 0n || movedWeightGrams <= 0n || movedWeightGrams > sourceWeightGrams) {
    throw new StoreOperationValidationError('Transfer weight must be within source inventory.');
  }
  const movedCostVnd =
    movedWeightGrams === sourceWeightGrams
      ? sourceCostVnd
      : (sourceCostVnd * movedWeightGrams) / sourceWeightGrams;
  return { movedCostVnd, remainingCostVnd: sourceCostVnd - movedCostVnd };
}

function validateVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0)
    throw new StoreOperationValidationError('Expected version must be non-negative.');
}

function validatePage(page: number, pageSize: number): void {
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('page must be positive.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new RangeError('pageSize must be between 1 and 100.');
}

function transferSnapshot(transfer: TransferRow): JsonObject {
  return {
    id: transfer.id,
    transferNumber: transfer.transferNumber,
    sourceStoreId: transfer.sourceStoreId,
    destinationStoreId: transfer.destinationStoreId,
    sourceInventoryBagId: transfer.sourceInventoryBagId,
    destinationInventoryBagId: transfer.destinationInventoryBagId,
    productId: transfer.productId,
    weightKg: transfer.weightKg,
    costVnd: transfer.costVnd?.toString() ?? null,
    status: transfer.status,
    version: transfer.version,
  };
}

function mutationResult(
  transferId: string,
  status: TransferStatus,
  version: number,
  sourceInventoryBagVersion: number | null,
  destinationInventoryBagId: string | null,
  responseStatus = 200,
): IdempotentOperationResult<StoreTransferMutationResult> {
  const value = {
    transferId,
    status,
    version,
    sourceInventoryBagVersion,
    destinationInventoryBagId,
  };
  return {
    value,
    responseStatus,
    responseBody: value,
    resourceType: 'store_transfer',
    resourceId: transferId,
  };
}

function transferNumber(now: Date): string {
  return `TR-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 12).toUpperCase()}`;
}

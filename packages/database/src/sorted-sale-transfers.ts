import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  withIdempotency,
  type IdempotencyResult,
  type IdempotentOperationResult,
} from './idempotency.js';
import {
  auditLogs,
  sortedSaleTransfers,
  storeSortedStocks,
  storeSortingEvents,
  stores,
  users,
} from './schema.js';
import { initializeSaleBaseline, settleProductSaleProgress } from './store-sale-sync.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationConflictError,
  StoreOperationValidationError,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

type Transfer = typeof sortedSaleTransfers.$inferSelect;

interface CommandContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CreateSortedSaleTransferInput extends CommandContext {
  readonly sourceStockId: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly expectedStockVersion: number;
  readonly bagQuantity: number;
  readonly weightKg: string | null;
  readonly note: string | null;
}

export interface ReceiveSortedSaleTransferInput extends CommandContext {
  readonly transferId: string;
  readonly expectedVersion: number;
}

export async function listSortedSaleTransfers(
  database: Database,
  storeIds: readonly string[],
): Promise<Transfer[]> {
  if (storeIds.length === 0) return [];
  return database
    .select()
    .from(sortedSaleTransfers)
    .where(
      or(
        inArray(sortedSaleTransfers.sourceStoreId, [...storeIds]),
        inArray(sortedSaleTransfers.destinationStoreId, [...storeIds]),
      ),
    )
    .orderBy(desc(sortedSaleTransfers.createdAt))
    .limit(500);
}

export async function getSortedSaleTransfer(
  database: Database,
  id: string,
): Promise<Transfer | undefined> {
  const [transfer] = await database
    .select()
    .from(sortedSaleTransfers)
    .where(eq(sortedSaleTransfers.id, id))
    .limit(1);
  return transfer;
}

export async function createSortedSaleTransfer(
  database: Database,
  input: CreateSortedSaleTransferInput,
): Promise<IdempotencyResult<{ transferId: string }>> {
  if (!Number.isSafeInteger(input.bagQuantity) || input.bagQuantity <= 0)
    throw new StoreOperationValidationError('Transfer bag quantity must be positive.');
  if (input.sourceStoreId === input.destinationStoreId)
    throw new StoreOperationValidationError('Source and destination stores must differ.');
  const enteredGrams = input.weightKg === null ? null : kilogramsToGramsExact(input.weightKg);
  if (enteredGrams !== null && enteredGrams <= 0n)
    throw new StoreOperationValidationError('Transfer weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `sorted-sale.transfer:${input.sourceStoreId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.sourceStoreId, async () => {
        await assertRetailStoreActor(tx, input.actorUserId, input.sourceStoreId);
        await assertActiveRetailStore(tx, input.destinationStoreId);
        const [stock] = await tx
          .select()
          .from(storeSortedStocks)
          .where(eq(storeSortedStocks.id, input.sourceStockId))
          .for('update')
          .limit(1);
        if (!stock || stock.storeId !== input.sourceStoreId)
          throw new StoreOperationValidationError('Sale stock was not found at the source store.');
        if (stock.version !== input.expectedStockVersion)
          throw new StoreOperationConflictError('Sale stock changed before transfer.');
        if (stock.bagQuantity < input.bagQuantity || stock.bagQuantity === 0)
          throw new StoreOperationValidationError('Transfer bags exceed sorted Sale stock.');
        const beforeGrams = kilogramsToGramsExact(stock.saleWeightKg);
        const movedGrams =
          enteredGrams ??
          (input.bagQuantity === stock.bagQuantity
            ? beforeGrams
            : (beforeGrams * BigInt(input.bagQuantity)) / BigInt(stock.bagQuantity));
        if (
          movedGrams <= 0n ||
          movedGrams > beforeGrams ||
          (input.bagQuantity === stock.bagQuantity && movedGrams !== beforeGrams) ||
          (input.bagQuantity < stock.bagQuantity && movedGrams === beforeGrams)
        )
          throw new StoreOperationValidationError(
            'Transfer weight is inconsistent with the remaining bags.',
          );
        const now = new Date();
        const [transfer] = await tx
          .insert(sortedSaleTransfers)
          .values({
            transferNumber: '',
            sourceStockId: stock.id,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            productId: stock.productId,
            bagQuantity: input.bagQuantity,
            weightKg: gramsToKilogramsExact(movedGrams),
            enteredWeightKg: input.weightKg,
            note: input.note,
            createdByUserId: input.actorUserId,
            createdAt: now,
          })
          .returning({ id: sortedSaleTransfers.id });
        if (!transfer) throw new Error('Transfer insert returned no row.');
        const [updated] = await tx
          .update(storeSortedStocks)
          .set({
            bagQuantity: stock.bagQuantity - input.bagQuantity,
            saleWeightKg: gramsToKilogramsExact(beforeGrams - movedGrams),
            transferredOutBagQuantity: stock.transferredOutBagQuantity + input.bagQuantity,
            transferredOutWeightKg: gramsToKilogramsExact(
              kilogramsToGramsExact(stock.transferredOutWeightKg) + movedGrams,
            ),
            version: stock.version + 1,
            updatedAt: now,
          })
          .where(
            and(eq(storeSortedStocks.id, stock.id), eq(storeSortedStocks.version, stock.version)),
          )
          .returning({ id: storeSortedStocks.id });
        if (!updated) throw new StoreOperationConflictError('Sale stock changed during transfer.');
        await tx.insert(storeSortingEvents).values({
          storeSortedStockId: stock.id,
          storeInventoryBagId: stock.storeInventoryBagId,
          storeId: stock.storeId,
          productId: stock.productId,
          action: 'sale_transfer_out',
          weightKg: gramsToKilogramsExact(movedGrams),
          actorUserId: input.actorUserId,
          occurredAt: now,
        });
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.sourceStoreId,
          action: 'SORTED_SALE_TRANSFER_DISPATCHED',
          entityType: 'sorted_sale_transfer',
          entityId: transfer.id,
          before: { stockId: stock.id, bags: stock.bagQuantity, weightKg: stock.saleWeightKg },
          after: {
            bags: stock.bagQuantity - input.bagQuantity,
            weightKg: gramsToKilogramsExact(beforeGrams - movedGrams),
            destinationStoreId: input.destinationStoreId,
            movedBags: input.bagQuantity,
            movedWeightKg: gramsToKilogramsExact(movedGrams),
          },
        });
        return result({ transferId: transfer.id }, transfer.id, 201);
      }),
  );
}

export async function receiveSortedSaleTransfer(
  database: Database,
  input: ReceiveSortedSaleTransferInput,
): Promise<IdempotencyResult<{ transferId: string }>> {
  return withIdempotency(
    database,
    {
      scope: `sorted-sale.receive:${input.transferId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'sorted-sale-transfer', input.transferId, async () => {
        const [transfer] = await tx
          .select()
          .from(sortedSaleTransfers)
          .where(eq(sortedSaleTransfers.id, input.transferId))
          .for('update')
          .limit(1);
        if (!transfer)
          throw new StoreOperationValidationError('Sorted Sale transfer was not found.');
        await assertRetailStoreActor(tx, input.actorUserId, transfer.destinationStoreId);
        if (transfer.status !== 'in_transit' || transfer.version !== input.expectedVersion)
          throw new StoreOperationConflictError('Transfer was already received or changed.');
        return withAdvisoryLock(tx, 'store-sorting', transfer.destinationStoreId, async () => {
          const hasSale = await tx
            .select({ id: storeSortedStocks.id })
            .from(storeSortedStocks)
            .where(
              and(
                eq(storeSortedStocks.storeId, transfer.destinationStoreId),
                eq(storeSortedStocks.productId, transfer.productId),
                gt(storeSortedStocks.saleCreditedWeightKg, '0.000'),
              ),
            )
            .limit(1);
          // A first Sale credit needs an IDOSI baseline, as with freshly sorted goods.
          if (hasSale.length === 0)
            await initializeSaleBaseline(
              tx,
              transfer.destinationStoreId,
              transfer.productId,
              new Date(),
            );
          const now = new Date();
          const [stock] = await tx
            .insert(storeSortedStocks)
            .values({
              storeId: transfer.destinationStoreId,
              productId: transfer.productId,
              sourceTransferId: transfer.id,
              bagQuantity: transfer.bagQuantity,
              creditedBagQuantity: transfer.bagQuantity,
              saleCreditedWeightKg: transfer.weightKg,
              saleWeightKg: transfer.weightKg,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: storeSortedStocks.id });
          if (!stock) throw new Error('Destination Sale stock insert returned no row.');
          const [updated] = await tx
            .update(sortedSaleTransfers)
            .set({
              status: 'received',
              destinationStockId: stock.id,
              receivedByUserId: input.actorUserId,
              receivedAt: now,
              version: transfer.version + 1,
            })
            .where(
              and(
                eq(sortedSaleTransfers.id, transfer.id),
                eq(sortedSaleTransfers.version, transfer.version),
              ),
            )
            .returning({ id: sortedSaleTransfers.id });
          if (!updated) throw new StoreOperationConflictError('Transfer changed during receipt.');
          await tx.insert(storeSortingEvents).values({
            storeSortedStockId: stock.id,
            storeInventoryBagId: null,
            storeId: transfer.destinationStoreId,
            productId: transfer.productId,
            action: 'sale_transfer_in',
            weightKg: transfer.weightKg,
            actorUserId: input.actorUserId,
            occurredAt: now,
          });
          await settleProductSaleProgress(tx, transfer.destinationStoreId, transfer.productId, now);
          await tx.insert(auditLogs).values({
            requestId: input.requestId,
            actorUserId: input.actorUserId,
            actorRole: 'store',
            actorStoreId: transfer.destinationStoreId,
            action: 'SORTED_SALE_TRANSFER_RECEIVED',
            entityType: 'sorted_sale_transfer',
            entityId: transfer.id,
            before: { status: 'in_transit' },
            after: {
              status: 'received',
              destinationStockId: stock.id,
              bags: transfer.bagQuantity,
              weightKg: transfer.weightKg,
            },
          });
          return result({ transferId: transfer.id }, transfer.id);
        });
      }),
  );
}

async function assertRetailStoreActor(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<void> {
  await assertActiveRetailStore(tx, storeId);
  const [actor] = await tx
    .select({ role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
    .limit(1);
  if (!actor || actor.role !== 'store' || actor.status !== 'active' || actor.storeId !== storeId)
    throw new StoreOperationValidationError('Only the active owning store may change Sale stock.');
}

async function assertActiveRetailStore(tx: Transaction, storeId: string): Promise<void> {
  const [store] = await tx
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
    .limit(1);
  if (!store)
    throw new StoreOperationValidationError('Destination must be an active retail store.');
}

function result(
  value: { transferId: string },
  id: string,
  responseStatus = 200,
): IdempotentOperationResult<{ transferId: string }> {
  return {
    value,
    responseBody: value,
    resourceType: 'sorted_sale_transfer',
    resourceId: id,
    responseStatus,
  };
}

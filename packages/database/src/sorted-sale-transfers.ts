import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

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
  weighBags,
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
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly productId: string;
  readonly bagWeightsKg: readonly string[];
  readonly note: string | null;
}

export interface ReceiveSortedSaleTransferInput extends CommandContext {
  readonly transferId: string;
  readonly expectedVersion: number;
}

export interface CancelSortedSaleTransferInput extends CommandContext {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly reason: string;
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
  if (input.sourceStoreId === input.destinationStoreId)
    throw new StoreOperationValidationError('Source and destination stores must differ.');
  const { bagWeightsKg, totalGrams: movedGrams } = weighBags(input.bagWeightsKg);
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
        // Same lot order as IDOSI sale consumption: the oldest Sale leaves first.
        const lots = await tx
          .select()
          .from(storeSortedStocks)
          .where(
            and(
              eq(storeSortedStocks.storeId, input.sourceStoreId),
              eq(storeSortedStocks.productId, input.productId),
            ),
          )
          .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id))
          .for('update');
        const availableGrams = lots.reduce(
          (sum, lot) => sum + kilogramsToGramsExact(lot.saleWeightKg),
          0n,
        );
        if (movedGrams > availableGrams)
          throw new StoreOperationValidationError(
            'Total bag weight exceeds the Sale stock of this product.',
          );
        const now = new Date();
        const consumed: { lot: (typeof lots)[number]; grams: bigint }[] = [];
        let remaining = movedGrams;
        for (const lot of lots) {
          if (remaining === 0n) break;
          const balance = kilogramsToGramsExact(lot.saleWeightKg);
          const take = balance < remaining ? balance : remaining;
          if (take <= 0n) continue;
          consumed.push({ lot, grams: take });
          remaining -= take;
        }
        const firstLot = consumed[0]?.lot;
        if (!firstLot || remaining !== 0n)
          throw new StoreOperationValidationError('Sale stock could not cover the transfer.');
        const [transfer] = await tx
          .insert(sortedSaleTransfers)
          .values({
            transferNumber: '',
            sourceStockId: firstLot.id,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            productId: input.productId,
            bagQuantity: bagWeightsKg.length,
            weightKg: gramsToKilogramsExact(movedGrams),
            enteredWeightKg: gramsToKilogramsExact(movedGrams),
            bagWeightsKg,
            note: input.note,
            createdByUserId: input.actorUserId,
            createdAt: now,
          })
          .returning({ id: sortedSaleTransfers.id });
        if (!transfer) throw new Error('Transfer insert returned no row.');
        for (const { lot, grams } of consumed) {
          const after = kilogramsToGramsExact(lot.saleWeightKg) - grams;
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              saleWeightKg: gramsToKilogramsExact(after),
              // Legacy lots carried a bag count; it no longer describes an emptied lot.
              ...(after === 0n ? { bagQuantity: 0 } : {}),
              transferredOutWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.transferredOutWeightKg) + grams,
              ),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated)
            throw new StoreOperationConflictError('Sale stock changed during transfer.');
          await tx.insert(storeSortingEvents).values({
            storeSortedStockId: lot.id,
            storeInventoryBagId: lot.storeInventoryBagId,
            storeId: lot.storeId,
            productId: lot.productId,
            action: 'sale_transfer_out',
            weightKg: gramsToKilogramsExact(grams),
            actorUserId: input.actorUserId,
            occurredAt: now,
          });
        }
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.sourceStoreId,
          action: 'SORTED_SALE_TRANSFER_DISPATCHED',
          entityType: 'sorted_sale_transfer',
          entityId: transfer.id,
          before: {
            productId: input.productId,
            saleWeightKg: gramsToKilogramsExact(availableGrams),
          },
          after: {
            saleWeightKg: gramsToKilogramsExact(availableGrams - movedGrams),
            destinationStoreId: input.destinationStoreId,
            bagWeightsKg,
            movedWeightKg: gramsToKilogramsExact(movedGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
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

/**
 * A transfer the destination has not received yet can be called back by the sending store.
 * The weight returns to the sender as a new Sale lot tied to the transfer, the same way the
 * receiving store would have booked it, so outstanding IDOSI sales are settled against it.
 */
export async function cancelSortedSaleTransfer(
  database: Database,
  input: CancelSortedSaleTransferInput,
): Promise<IdempotencyResult<{ transferId: string }>> {
  const reason = input.reason.trim();
  if (reason.length < 3)
    throw new StoreOperationValidationError('Cần ghi lý do hủy phiếu tối thiểu 3 ký tự.');
  return withIdempotency(
    database,
    {
      scope: `sorted-sale.cancel:${input.transferId}`,
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
        await assertRetailStoreActor(tx, input.actorUserId, transfer.sourceStoreId);
        if (transfer.status !== 'in_transit' || transfer.version !== input.expectedVersion)
          throw new StoreOperationConflictError('Transfer was already received or changed.');
        return withAdvisoryLock(tx, 'store-sorting', transfer.sourceStoreId, async () => {
          const now = new Date();
          const [stock] = await tx
            .insert(storeSortedStocks)
            .values({
              storeId: transfer.sourceStoreId,
              productId: transfer.productId,
              sourceTransferId: transfer.id,
              saleCreditedWeightKg: transfer.weightKg,
              saleWeightKg: transfer.weightKg,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: storeSortedStocks.id });
          if (!stock) throw new Error('Returned Sale stock insert returned no row.');
          const [updated] = await tx
            .update(sortedSaleTransfers)
            .set({
              status: 'cancelled',
              cancelledByUserId: input.actorUserId,
              cancelledAt: now,
              cancellationReason: reason,
              version: transfer.version + 1,
            })
            .where(
              and(
                eq(sortedSaleTransfers.id, transfer.id),
                eq(sortedSaleTransfers.version, transfer.version),
                eq(sortedSaleTransfers.status, 'in_transit'),
              ),
            )
            .returning({ id: sortedSaleTransfers.id });
          if (!updated) throw new StoreOperationConflictError('Transfer changed during cancel.');
          await tx.insert(storeSortingEvents).values({
            storeSortedStockId: stock.id,
            storeInventoryBagId: null,
            storeId: transfer.sourceStoreId,
            productId: transfer.productId,
            action: 'sale_transfer_return',
            weightKg: transfer.weightKg,
            actorUserId: input.actorUserId,
            occurredAt: now,
          });
          await settleProductSaleProgress(tx, transfer.sourceStoreId, transfer.productId, now);
          await tx.insert(auditLogs).values({
            requestId: input.requestId,
            actorUserId: input.actorUserId,
            actorRole: 'store',
            actorStoreId: transfer.sourceStoreId,
            action: 'SORTED_SALE_TRANSFER_CANCELLED',
            entityType: 'sorted_sale_transfer',
            entityId: transfer.id,
            before: { status: 'in_transit' },
            after: {
              status: 'cancelled',
              returnedStockId: stock.id,
              weightKg: transfer.weightKg,
              reason,
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

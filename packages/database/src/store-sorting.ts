import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  storeInventoryBags,
  storeInventoryLedgerEntries,
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

type SortedStockRow = typeof storeSortedStocks.$inferSelect;
type SortingReason = 'SALE' | 'CHARITY' | 'CANCEL';

export interface SortedStockRecord {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly inventoryLotId: string;
  readonly bagCode: string;
  readonly saleWeightKg: string;
  readonly charityWeightKg: string;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface CreateStoreSortingInput {
  readonly storeId: string;
  readonly inventoryBagId: string;
  readonly expectedInventoryVersion: number;
  readonly reason: SortingReason;
  readonly weightKg: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface SortedStockMutationInput {
  readonly stockId: string;
  readonly storeId: string;
  readonly expectedVersion: number;
  readonly weightKg: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface StoreSortingMutationResult {
  readonly stockId: string | null;
  readonly inventoryBagId: string;
  readonly inventoryVersion: number;
}

export async function listStoreSortedStocks(
  database: Database,
  storeId?: string,
): Promise<SortedStockRecord[]> {
  const rows = await database
    .select({ stock: storeSortedStocks, bagCode: storeInventoryBags.displayCode })
    .from(storeSortedStocks)
    .innerJoin(storeInventoryBags, eq(storeSortedStocks.storeInventoryBagId, storeInventoryBags.id))
    .where(storeId ? eq(storeSortedStocks.storeId, storeId) : undefined)
    .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id));
  return rows.map(({ stock, bagCode }) => sortedStockRecord(stock, bagCode));
}

export async function getStoreSortedStock(
  database: Database,
  stockId: string,
): Promise<SortedStockRecord | null> {
  const [row] = await database
    .select({ stock: storeSortedStocks, bagCode: storeInventoryBags.displayCode })
    .from(storeSortedStocks)
    .innerJoin(storeInventoryBags, eq(storeSortedStocks.storeInventoryBagId, storeInventoryBags.id))
    .where(eq(storeSortedStocks.id, stockId))
    .limit(1);
  return row ? sortedStockRecord(row.stock, row.bagCode) : null;
}

export async function createStoreSorting(
  database: Database,
  input: CreateStoreSortingInput,
): Promise<IdempotencyResult<StoreSortingMutationResult>> {
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n)
    throw new StoreOperationValidationError('Sorting weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `store-sorting.create:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const [bag] = await tx
          .select()
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.id, input.inventoryBagId))
          .for('update')
          .limit(1);
        if (!bag || bag.storeId !== input.storeId)
          throw new StoreOperationValidationError('Inventory bag does not belong to this store.');
        if (
          bag.version !== input.expectedInventoryVersion ||
          !['available', 'opened'].includes(bag.status)
        ) {
          throw new StoreOperationConflictError('Inventory bag changed before sorting.');
        }
        const beforeGrams = kilogramsToGramsExact(bag.currentWeightKg);
        if (weightGrams > beforeGrams)
          throw new StoreOperationValidationError('Sorting weight exceeds the bag balance.');
        const now = new Date();
        const [updatedBag] = await tx
          .update(storeInventoryBags)
          .set({
            currentWeightKg: gramsToKilogramsExact(beforeGrams - weightGrams),
            status: beforeGrams === weightGrams ? 'depleted' : 'opened',
            openedAt: bag.openedAt ?? now,
            depletedAt: beforeGrams === weightGrams ? now : null,
            version: bag.version + 1,
            updatedAt: now,
          })
          .where(
            and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)),
          )
          .returning({ version: storeInventoryBags.version });
        if (!updatedBag)
          throw new StoreOperationConflictError('Inventory bag changed during sorting.');

        let stock: SortedStockRow | null = null;
        if (input.reason !== 'CANCEL') {
          if (input.reason === 'SALE') {
            const existingCredits = await tx
              .select({ saleWeightKg: storeSortedStocks.saleWeightKg })
              .from(storeSortedStocks)
              .where(
                and(
                  eq(storeSortedStocks.storeId, bag.storeId),
                  eq(storeSortedStocks.productId, bag.productId),
                ),
              );
            if (!existingCredits.some((row) => kilogramsToGramsExact(row.saleWeightKg) > 0n)) {
              await initializeSaleBaseline(tx, bag.storeId, bag.productId, now);
            }
          }
          const [existing] = await tx
            .select()
            .from(storeSortedStocks)
            .where(eq(storeSortedStocks.storeInventoryBagId, bag.id))
            .for('update')
            .limit(1);
          const saleGrams =
            (existing ? kilogramsToGramsExact(existing.saleWeightKg) : 0n) +
            (input.reason === 'SALE' ? weightGrams : 0n);
          const charityGrams =
            (existing ? kilogramsToGramsExact(existing.charityWeightKg) : 0n) +
            (input.reason === 'CHARITY' ? weightGrams : 0n);
          if (existing) {
            const updated = await tx
              .update(storeSortedStocks)
              .set({
                saleCreditedWeightKg: gramsToKilogramsExact(
                  kilogramsToGramsExact(existing.saleCreditedWeightKg) +
                    (input.reason === 'SALE' ? weightGrams : 0n),
                ),
                saleWeightKg: gramsToKilogramsExact(saleGrams),
                charityWeightKg: gramsToKilogramsExact(charityGrams),
                version: existing.version + 1,
                updatedAt: now,
              })
              .where(eq(storeSortedStocks.id, existing.id))
              .returning();
            stock = updated[0] ?? null;
          } else {
            const inserted = await tx
              .insert(storeSortedStocks)
              .values({
                storeId: bag.storeId,
                productId: bag.productId,
                storeInventoryBagId: bag.id,
                saleCreditedWeightKg: gramsToKilogramsExact(
                  input.reason === 'SALE' ? weightGrams : 0n,
                ),
                saleWeightKg: gramsToKilogramsExact(saleGrams),
                charityWeightKg: gramsToKilogramsExact(charityGrams),
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            stock = inserted[0] ?? null;
          }
          if (!stock) throw new Error('Sorted stock mutation returned no row.');
          if (input.reason === 'SALE')
            await settleProductSaleProgress(tx, bag.storeId, bag.productId, now);
        }
        const [event] = await tx
          .insert(storeSortingEvents)
          .values({
            storeSortedStockId: stock?.id ?? null,
            storeInventoryBagId: bag.id,
            storeId: bag.storeId,
            productId: bag.productId,
            action:
              input.reason === 'SALE'
                ? 'sort_sale'
                : input.reason === 'CHARITY'
                  ? 'sort_charity'
                  : 'sort_cancel',
            weightKg: input.weightKg,
            actorUserId: input.actorUserId,
            occurredAt: now,
          })
          .returning({ id: storeSortingEvents.id });
        if (!event) throw new Error('Sorting event insert returned no row.');
        await tx.insert(storeInventoryLedgerEntries).values({
          storeInventoryBagId: bag.id,
          storeId: bag.storeId,
          productId: bag.productId,
          eventType: input.reason === 'CANCEL' ? 'consume' : 'adjust',
          weightBeforeKg: bag.currentWeightKg,
          weightAfterKg: gramsToKilogramsExact(beforeGrams - weightGrams),
          sourceType: 'store_sorting_event',
          sourceId: event.id,
          reason: `Lọc hàng: ${input.reason}`,
          actorUserId: input.actorUserId,
          occurredAt: now,
        });
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_SORTING_RECORDED',
          entityType: 'store_sorting_event',
          entityId: event.id,
          after: {
            reason: input.reason,
            weightKg: input.weightKg,
            bagId: bag.id,
            stockId: stock?.id ?? null,
          },
        });
        const value = {
          stockId: stock?.id ?? null,
          inventoryBagId: bag.id,
          inventoryVersion: updatedBag.version,
        };
        return {
          value,
          responseBody: value,
          responseStatus: 201,
          resourceType: 'store_sorting_event',
          resourceId: event.id,
        };
      }),
  );
}

export async function moveCharityToSale(
  database: Database,
  input: SortedStockMutationInput,
): Promise<IdempotencyResult<StoreSortingMutationResult>> {
  return mutateCharity(database, input, 'charity_to_sale');
}

export async function exportCharity(
  database: Database,
  input: SortedStockMutationInput,
): Promise<IdempotencyResult<StoreSortingMutationResult>> {
  return mutateCharity(database, input, 'charity_export');
}

async function mutateCharity(
  database: Database,
  input: SortedStockMutationInput,
  action: 'charity_to_sale' | 'charity_export',
): Promise<IdempotencyResult<StoreSortingMutationResult>> {
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n) throw new StoreOperationValidationError('Weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `store-sorting.${action}:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const [stock] = await tx
          .select()
          .from(storeSortedStocks)
          .where(eq(storeSortedStocks.id, input.stockId))
          .for('update')
          .limit(1);
        if (!stock || stock.storeId !== input.storeId)
          throw new StoreOperationValidationError('Sorted stock does not belong to this store.');
        if (stock.version !== input.expectedVersion)
          throw new StoreOperationConflictError('Sorted stock changed before confirmation.');
        const charityGrams = kilogramsToGramsExact(stock.charityWeightKg);
        if (weightGrams > charityGrams)
          throw new StoreOperationValidationError('Weight exceeds charity stock.');
        if (action === 'charity_export' && weightGrams !== charityGrams) {
          throw new StoreOperationValidationError(
            'Charity export must confirm the entire remaining charity weight.',
          );
        }
        const now = new Date();
        if (action === 'charity_to_sale') {
          const existingCredits = await tx
            .select({ saleWeightKg: storeSortedStocks.saleWeightKg })
            .from(storeSortedStocks)
            .where(
              and(
                eq(storeSortedStocks.storeId, stock.storeId),
                eq(storeSortedStocks.productId, stock.productId),
              ),
            );
          if (!existingCredits.some((row) => kilogramsToGramsExact(row.saleWeightKg) > 0n)) {
            await initializeSaleBaseline(tx, stock.storeId, stock.productId, now);
          }
        }
        const [updated] = await tx
          .update(storeSortedStocks)
          .set({
            charityWeightKg: gramsToKilogramsExact(charityGrams - weightGrams),
            saleCreditedWeightKg: gramsToKilogramsExact(
              kilogramsToGramsExact(stock.saleCreditedWeightKg) +
                (action === 'charity_to_sale' ? weightGrams : 0n),
            ),
            saleWeightKg: gramsToKilogramsExact(
              kilogramsToGramsExact(stock.saleWeightKg) +
                (action === 'charity_to_sale' ? weightGrams : 0n),
            ),
            version: stock.version + 1,
            updatedAt: now,
          })
          .where(
            and(eq(storeSortedStocks.id, stock.id), eq(storeSortedStocks.version, stock.version)),
          )
          .returning({ version: storeSortedStocks.version });
        if (!updated)
          throw new StoreOperationConflictError('Sorted stock changed during confirmation.');
        if (action === 'charity_to_sale')
          await settleProductSaleProgress(tx, stock.storeId, stock.productId, now);
        const [event] = await tx
          .insert(storeSortingEvents)
          .values({
            storeSortedStockId: stock.id,
            storeInventoryBagId: stock.storeInventoryBagId,
            storeId: stock.storeId,
            productId: stock.productId,
            action,
            weightKg: input.weightKg,
            actorUserId: input.actorUserId,
            occurredAt: now,
          })
          .returning({ id: storeSortingEvents.id });
        if (!event) throw new Error('Charity event insert returned no row.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action:
            action === 'charity_to_sale' ? 'STORE_CHARITY_MOVED_TO_SALE' : 'STORE_CHARITY_EXPORTED',
          entityType: 'store_sorting_event',
          entityId: event.id,
          after: { stockId: stock.id, weightKg: input.weightKg, version: updated.version },
        });
        const [bag] = await tx
          .select({ version: storeInventoryBags.version })
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.id, stock.storeInventoryBagId))
          .limit(1);
        if (!bag) throw new Error('Sorted stock source bag is missing.');
        const value = {
          stockId: stock.id,
          inventoryBagId: stock.storeInventoryBagId,
          inventoryVersion: bag.version,
        };
        return {
          value,
          responseBody: value,
          responseStatus: 200,
          resourceType: 'store_sorting_event',
          resourceId: event.id,
        };
      }),
  );
}

async function assertActiveStoreActor(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<void> {
  const [[store], [actor]] = await Promise.all([
    tx
      .select({ id: stores.id, kind: stores.kind })
      .from(stores)
      .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1),
    tx
      .select({ role: users.role, status: users.status, storeId: users.storeId })
      .from(users)
      .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
      .limit(1),
  ]);
  if (
    !store ||
    store.kind !== 'retail' ||
    !actor ||
    actor.role !== 'store' ||
    actor.status !== 'active' ||
    actor.storeId !== storeId
  ) {
    throw new StoreOperationValidationError(
      'Only an active retail store account may sort this stock.',
    );
  }
}

function sortedStockRecord(stock: SortedStockRow, bagCode: string): SortedStockRecord {
  return {
    id: stock.id,
    storeId: stock.storeId,
    productId: stock.productId,
    inventoryLotId: stock.storeInventoryBagId,
    bagCode,
    saleWeightKg: stock.saleWeightKg,
    charityWeightKg: stock.charityWeightKg,
    version: stock.version,
    updatedAt: stock.updatedAt,
  };
}

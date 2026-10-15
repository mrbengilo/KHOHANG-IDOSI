import { and, asc, count, desc, eq, gte, inArray, isNull, lt, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  sortedSaleTransfers,
  storeCharityExports,
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

type SortedStockRow = typeof storeSortedStocks.$inferSelect;
type SortingReason = 'SALE' | 'CHARITY' | 'CANCEL';

export interface SortedStockRecord {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly inventoryLotId: string;
  readonly bagCode: string;
  readonly saleWeightKg: string;
  readonly bagQuantity: number;
  readonly charityWeightKg: string;
  readonly cancelWeightKg: string;
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

/** Store-visible sorting actions; IDOSI reconciliation and Sale transfers have their own screens. */
const SORTING_HISTORY_ACTIONS = [
  'sort_sale',
  'sort_charity',
  'sort_cancel',
  'charity_to_sale',
  'charity_export',
  'cancel_to_sale',
  'cancel_finalize',
  'sale_to_charity',
  'sale_to_cancel',
] as const;
export type StoreSortingHistoryAction = (typeof SORTING_HISTORY_ACTIONS)[number];

export interface StoreSortingHistoryInput {
  readonly storeIds: readonly string[];
  readonly page: number;
  readonly pageSize: number;
  readonly occurredFrom?: Date;
  readonly occurredBefore?: Date;
}

export interface StoreSortingHistoryRecord {
  readonly id: string;
  readonly storeId: string;
  readonly productId: string;
  readonly inventoryBagId: string | null;
  readonly bagCode: string | null;
  readonly action: StoreSortingHistoryAction;
  readonly weightKg: string;
  readonly actorDisplayName: string | null;
  readonly occurredAt: Date;
}

export async function listStoreSortingHistory(
  database: Database,
  input: StoreSortingHistoryInput,
): Promise<{ readonly data: StoreSortingHistoryRecord[]; readonly totalItems: number }> {
  if (input.storeIds.length === 0) return { data: [], totalItems: 0 };
  const predicates: SQL[] = [
    inArray(storeSortingEvents.storeId, [...input.storeIds]),
    inArray(storeSortingEvents.action, [...SORTING_HISTORY_ACTIONS]),
  ];
  if (input.occurredFrom) predicates.push(gte(storeSortingEvents.occurredAt, input.occurredFrom));
  if (input.occurredBefore)
    predicates.push(lt(storeSortingEvents.occurredAt, input.occurredBefore));
  const where = and(...predicates);
  const [totals, rows] = await Promise.all([
    database.select({ value: count() }).from(storeSortingEvents).where(where),
    database
      .select({
        event: storeSortingEvents,
        bagCode: storeInventoryBags.displayCode,
        actorDisplayName: users.displayName,
      })
      .from(storeSortingEvents)
      .leftJoin(
        storeInventoryBags,
        eq(storeSortingEvents.storeInventoryBagId, storeInventoryBags.id),
      )
      .leftJoin(users, eq(storeSortingEvents.actorUserId, users.id))
      .where(where)
      .orderBy(desc(storeSortingEvents.occurredAt), desc(storeSortingEvents.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);
  return {
    totalItems: totals[0]?.value ?? 0,
    data: rows.map(({ event, bagCode, actorDisplayName }) => ({
      id: event.id,
      storeId: event.storeId,
      productId: event.productId,
      inventoryBagId: event.storeInventoryBagId,
      bagCode: bagCode || null,
      action: event.action as StoreSortingHistoryAction,
      weightKg: event.weightKg,
      actorDisplayName,
      occurredAt: event.occurredAt,
    })),
  };
}

export async function listStoreSortedStocks(
  database: Database,
  storeId?: string,
): Promise<SortedStockRecord[]> {
  const rows = await database
    .select({
      stock: storeSortedStocks,
      bagCode: storeInventoryBags.displayCode,
      transferNumber: sortedSaleTransfers.transferNumber,
    })
    .from(storeSortedStocks)
    .leftJoin(storeInventoryBags, eq(storeSortedStocks.storeInventoryBagId, storeInventoryBags.id))
    .leftJoin(sortedSaleTransfers, eq(storeSortedStocks.sourceTransferId, sortedSaleTransfers.id))
    .where(storeId ? eq(storeSortedStocks.storeId, storeId) : undefined)
    .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id));
  return rows.map(({ stock, bagCode, transferNumber }) =>
    sortedStockRecord(stock, bagCode ?? transferNumber ?? ''),
  );
}

export interface SaleBreakdownRecord {
  readonly storeId: string;
  readonly productId: string;
  readonly creditedWeightKg: string;
  readonly remainingWeightKg: string;
  readonly soldByPieceWeightKg: string;
  readonly soldByWeightWeightKg: string;
  readonly movedToCharityWeightKg: string;
  readonly movedToCancelWeightKg: string;
  readonly transferredOutWeightKg: string;
}

/**
 * How each store/product's Sale pool was used, for display only: credited = remaining +
 * sold-by-piece + sold-by-weight + moved-to-charity + moved-to-cancel + transferred-out. The
 * "sold by weight" figure absorbs IDOSI sale corrections so the breakdown always reconciles
 * exactly against the credited total.
 */
export async function listStoreSaleBreakdown(
  database: Database,
  storeIds: readonly string[],
): Promise<SaleBreakdownRecord[]> {
  if (storeIds.length === 0) return [];
  const stocks = await database
    .select({
      storeId: storeSortedStocks.storeId,
      productId: storeSortedStocks.productId,
      saleCreditedWeightKg: storeSortedStocks.saleCreditedWeightKg,
      saleWeightKg: storeSortedStocks.saleWeightKg,
      transferredOutWeightKg: storeSortedStocks.transferredOutWeightKg,
    })
    .from(storeSortedStocks)
    .where(inArray(storeSortedStocks.storeId, [...storeIds]));
  const events = await database
    .select({
      storeId: storeSortingEvents.storeId,
      productId: storeSortingEvents.productId,
      action: storeSortingEvents.action,
      weightKg: storeSortingEvents.weightKg,
    })
    .from(storeSortingEvents)
    .where(
      and(
        inArray(storeSortingEvents.storeId, [...storeIds]),
        inArray(storeSortingEvents.action, [
          'idosi_sale_piece',
          'sale_to_charity',
          'sale_to_cancel',
        ]),
      ),
    );
  type Accumulator = {
    storeId: string;
    productId: string;
    credited: bigint;
    remaining: bigint;
    transferredOut: bigint;
    soldByPiece: bigint;
    toCharity: bigint;
    toCancel: bigint;
  };
  const byKey = new Map<string, Accumulator>();
  const keyOf = (storeId: string, productId: string) => `${storeId}:${productId}`;
  const entry = (storeId: string, productId: string): Accumulator => {
    const key = keyOf(storeId, productId);
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        storeId,
        productId,
        credited: 0n,
        remaining: 0n,
        transferredOut: 0n,
        soldByPiece: 0n,
        toCharity: 0n,
        toCancel: 0n,
      };
      byKey.set(key, acc);
    }
    return acc;
  };
  for (const stock of stocks) {
    const acc = entry(stock.storeId, stock.productId);
    acc.credited += kilogramsToGramsExact(stock.saleCreditedWeightKg);
    acc.remaining += kilogramsToGramsExact(stock.saleWeightKg);
    acc.transferredOut += kilogramsToGramsExact(stock.transferredOutWeightKg);
  }
  for (const event of events) {
    const acc = entry(event.storeId, event.productId);
    const grams = kilogramsToGramsExact(event.weightKg);
    if (event.action === 'idosi_sale_piece') acc.soldByPiece += grams;
    else if (event.action === 'sale_to_charity') acc.toCharity += grams;
    else if (event.action === 'sale_to_cancel') acc.toCancel += grams;
  }
  return [...byKey.values()]
    .filter((acc) => acc.credited > 0n)
    .map((acc) => {
      const soldByWeight = max0(
        acc.credited -
          acc.remaining -
          acc.transferredOut -
          acc.toCharity -
          acc.toCancel -
          acc.soldByPiece,
      );
      return {
        storeId: acc.storeId,
        productId: acc.productId,
        creditedWeightKg: gramsToKilogramsExact(acc.credited),
        remainingWeightKg: gramsToKilogramsExact(acc.remaining),
        soldByPieceWeightKg: gramsToKilogramsExact(acc.soldByPiece),
        soldByWeightWeightKg: gramsToKilogramsExact(soldByWeight),
        movedToCharityWeightKg: gramsToKilogramsExact(acc.toCharity),
        movedToCancelWeightKg: gramsToKilogramsExact(acc.toCancel),
        transferredOutWeightKg: gramsToKilogramsExact(acc.transferredOut),
      };
    });
}

function max0(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export async function getStoreSortedStock(
  database: Database,
  stockId: string,
): Promise<SortedStockRecord | null> {
  const [row] = await database
    .select({
      stock: storeSortedStocks,
      bagCode: storeInventoryBags.displayCode,
      transferNumber: sortedSaleTransfers.transferNumber,
    })
    .from(storeSortedStocks)
    .leftJoin(storeInventoryBags, eq(storeSortedStocks.storeInventoryBagId, storeInventoryBags.id))
    .leftJoin(sortedSaleTransfers, eq(storeSortedStocks.sourceTransferId, sortedSaleTransfers.id))
    .where(eq(storeSortedStocks.id, stockId))
    .limit(1);
  return row ? sortedStockRecord(row.stock, row.bagCode ?? row.transferNumber ?? '') : null;
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
        {
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
          const cancelGrams =
            (existing ? kilogramsToGramsExact(existing.cancelWeightKg) : 0n) +
            (input.reason === 'CANCEL' ? weightGrams : 0n);
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
                cancelWeightKg: gramsToKilogramsExact(cancelGrams),
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
                cancelWeightKg: gramsToKilogramsExact(cancelGrams),
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
          eventType: 'adjust',
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
        if (!stock.storeInventoryBagId)
          throw new StoreOperationValidationError(
            'Transferred Sale stock cannot be used for charity.',
          );
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
          after: {
            stockId: stock.id,
            weightKg: input.weightKg,
            version: updated.version,
          },
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

interface ProductSortingCommand {
  readonly storeId: string;
  readonly productId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}
/** @deprecated kept as an alias; use ProductSortingCommand. */
type ProductCharityCommand = ProductSortingCommand;

export interface MoveProductCharityToSaleInput extends ProductCharityCommand {
  readonly weightKg: string;
}

export interface CreateCharityExportInput extends ProductCharityCommand {
  readonly bagWeightsKg: readonly string[];
  readonly note: string | null;
}

export interface MoveProductCancelToSaleInput extends ProductSortingCommand {
  readonly weightKg: string;
}

export interface FinalizeProductCancelInput extends ProductSortingCommand {
  readonly weightKg: string;
}

export interface MoveProductSaleToCharityInput extends ProductSortingCommand {
  readonly weightKg: string;
}

export interface MoveProductSaleToCancelInput extends ProductSortingCommand {
  readonly weightKg: string;
}

// Type aliases (not interfaces) so each is assignable to the JSON idempotency body.
export type ProductCharityBalanceRecord = {
  readonly storeId: string;
  readonly productId: string;
  readonly charityWeightKg: string;
  readonly saleWeightKg: string;
};

export type ProductCancelBalanceRecord = {
  readonly storeId: string;
  readonly productId: string;
  readonly cancelWeightKg: string;
  readonly saleWeightKg: string;
};

type CharityExportRow = typeof storeCharityExports.$inferSelect;

export async function listCharityExports(
  database: Database,
  storeIds: readonly string[],
): Promise<CharityExportRow[]> {
  if (storeIds.length === 0) return [];
  return database
    .select()
    .from(storeCharityExports)
    .where(inArray(storeCharityExports.storeId, [...storeIds]))
    .orderBy(desc(storeCharityExports.createdAt))
    .limit(500);
}

export async function getCharityExport(
  database: Database,
  id: string,
): Promise<CharityExportRow | undefined> {
  const [row] = await database
    .select()
    .from(storeCharityExports)
    .where(eq(storeCharityExports.id, id))
    .limit(1);
  return row;
}

/** Move charity weight of one product back into Sale, oldest sorted lots first. */
export async function moveProductCharityToSale(
  database: Database,
  input: MoveProductCharityToSaleInput,
): Promise<IdempotencyResult<ProductCharityBalanceRecord>> {
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n) throw new StoreOperationValidationError('Weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `store-sorting.product_charity_to_sale:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const lots = await lockProductLots(tx, input.storeId, input.productId);
        const consumed = takeBucket(
          lots,
          weightGrams,
          'charityWeightKg',
          'Weight exceeds the charity stock of this product.',
        );
        const now = new Date();
        if (!lots.some((lot) => kilogramsToGramsExact(lot.saleWeightKg) > 0n))
          await initializeSaleBaseline(tx, input.storeId, input.productId, now);
        const eventIds: string[] = [];
        for (const { lot, grams } of consumed) {
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              charityWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.charityWeightKg) - grams,
              ),
              saleCreditedWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.saleCreditedWeightKg) + grams,
              ),
              saleWeightKg: gramsToKilogramsExact(kilogramsToGramsExact(lot.saleWeightKg) + grams),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated) throw new StoreOperationConflictError('Charity stock changed during move.');
          eventIds.push(
            await recordSortingLotEvent(tx, lot, 'charity_to_sale', grams, input.actorUserId, now),
          );
        }
        await settleProductSaleProgress(tx, input.storeId, input.productId, now);
        const balance = await productCharityBalance(tx, input.storeId, input.productId);
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_CHARITY_MOVED_TO_SALE',
          entityType: 'store_sorting_event',
          entityId: eventIds[0]!,
          after: {
            productId: input.productId,
            weightKg: gramsToKilogramsExact(weightGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
            balance,
          },
        });
        return {
          value: balance,
          responseBody: balance,
          responseStatus: 200,
          resourceType: 'store_sorting_event',
          resourceId: eventIds[0]!,
        };
      }),
  );
}

/** Export charity of one product bag by bag, oldest sorted lots first. */
export async function createCharityExport(
  database: Database,
  input: CreateCharityExportInput,
): Promise<IdempotencyResult<{ exportId: string }>> {
  const { bagWeightsKg, totalGrams } = weighBags(input.bagWeightsKg);
  return withIdempotency(
    database,
    {
      scope: `store-sorting.charity_export_bags:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const lots = await lockProductLots(tx, input.storeId, input.productId);
        const consumed = takeBucket(
          lots,
          totalGrams,
          'charityWeightKg',
          'Weight exceeds the charity stock of this product.',
        );
        const now = new Date();
        const [created] = await tx
          .insert(storeCharityExports)
          .values({
            exportNumber: '',
            storeId: input.storeId,
            productId: input.productId,
            bagQuantity: bagWeightsKg.length,
            weightKg: gramsToKilogramsExact(totalGrams),
            bagWeightsKg,
            note: input.note,
            createdByUserId: input.actorUserId,
            createdAt: now,
          })
          .returning({ id: storeCharityExports.id });
        if (!created) throw new Error('Charity export insert returned no row.');
        for (const { lot, grams } of consumed) {
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              charityWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.charityWeightKg) - grams,
              ),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated)
            throw new StoreOperationConflictError('Charity stock changed during export.');
          await recordSortingLotEvent(tx, lot, 'charity_export', grams, input.actorUserId, now);
        }
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_CHARITY_EXPORTED',
          entityType: 'store_charity_export',
          entityId: created.id,
          after: {
            productId: input.productId,
            bagWeightsKg,
            weightKg: gramsToKilogramsExact(totalGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
          },
        });
        const value = { exportId: created.id };
        return {
          value,
          responseBody: value,
          responseStatus: 201,
          resourceType: 'store_charity_export',
          resourceId: created.id,
        };
      }),
  );
}

/** Move cancel weight of one product back into Sale, oldest sorted lots first. */
export async function moveProductCancelToSale(
  database: Database,
  input: MoveProductCancelToSaleInput,
): Promise<IdempotencyResult<ProductCancelBalanceRecord>> {
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n) throw new StoreOperationValidationError('Weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `store-sorting.product_cancel_to_sale:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const lots = await lockProductLots(tx, input.storeId, input.productId);
        const consumed = takeBucket(
          lots,
          weightGrams,
          'cancelWeightKg',
          'Weight exceeds the cancelled stock of this product.',
        );
        const now = new Date();
        if (!lots.some((lot) => kilogramsToGramsExact(lot.saleWeightKg) > 0n))
          await initializeSaleBaseline(tx, input.storeId, input.productId, now);
        const eventIds: string[] = [];
        for (const { lot, grams } of consumed) {
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              cancelWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.cancelWeightKg) - grams,
              ),
              saleCreditedWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.saleCreditedWeightKg) + grams,
              ),
              saleWeightKg: gramsToKilogramsExact(kilogramsToGramsExact(lot.saleWeightKg) + grams),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated) throw new StoreOperationConflictError('Cancel stock changed during move.');
          eventIds.push(
            await recordSortingLotEvent(tx, lot, 'cancel_to_sale', grams, input.actorUserId, now),
          );
        }
        await settleProductSaleProgress(tx, input.storeId, input.productId, now);
        const balance = await productCancelBalance(tx, input.storeId, input.productId);
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_CANCEL_MOVED_TO_SALE',
          entityType: 'store_sorting_event',
          entityId: eventIds[0]!,
          after: {
            productId: input.productId,
            weightKg: gramsToKilogramsExact(weightGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
            balance,
          },
        });
        return {
          value: balance,
          responseBody: balance,
          responseStatus: 200,
          resourceType: 'store_sorting_event',
          resourceId: eventIds[0]!,
        };
      }),
  );
}

/**
 * Finalize ("Hủy luôn") the remaining cancel weight of one product: a terminal write-off with no
 * destination and no revenue. Must confirm the entire remaining cancel balance at once, mirroring
 * the charity export's all-or-nothing confirmation.
 */
export async function finalizeProductCancel(
  database: Database,
  input: FinalizeProductCancelInput,
): Promise<IdempotencyResult<ProductCancelBalanceRecord>> {
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n) throw new StoreOperationValidationError('Weight must be positive.');
  return withIdempotency(
    database,
    {
      scope: `store-sorting.product_cancel_finalize:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.storeId, async () => {
        await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
        const lots = await lockProductLots(tx, input.storeId, input.productId);
        const totalCancelGrams = lots.reduce(
          (sum, lot) => sum + kilogramsToGramsExact(lot.cancelWeightKg),
          0n,
        );
        if (weightGrams !== totalCancelGrams) {
          throw new StoreOperationValidationError(
            'Finalizing cancel must confirm the entire remaining cancel weight.',
          );
        }
        const consumed = takeBucket(
          lots,
          weightGrams,
          'cancelWeightKg',
          'Weight exceeds the cancelled stock of this product.',
        );
        const now = new Date();
        const eventIds: string[] = [];
        for (const { lot, grams } of consumed) {
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              cancelWeightKg: gramsToKilogramsExact(
                kilogramsToGramsExact(lot.cancelWeightKg) - grams,
              ),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated)
            throw new StoreOperationConflictError('Cancel stock changed during finalize.');
          eventIds.push(
            await recordSortingLotEvent(tx, lot, 'cancel_finalize', grams, input.actorUserId, now),
          );
        }
        const balance = await productCancelBalance(tx, input.storeId, input.productId);
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_CANCEL_FINALIZED',
          entityType: 'store_sorting_event',
          entityId: eventIds[0]!,
          after: {
            productId: input.productId,
            weightKg: gramsToKilogramsExact(weightGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
            balance,
          },
        });
        return {
          value: balance,
          responseBody: balance,
          responseStatus: 200,
          resourceType: 'store_sorting_event',
          resourceId: eventIds[0]!,
        };
      }),
  );
}

/** Reroute Sale weight of one product into Charity or Cancel, oldest sorted lots first. */
async function rerouteProductSale(
  database: Database,
  input: MoveProductSaleToCharityInput | MoveProductSaleToCancelInput,
  destination: 'charityWeightKg' | 'cancelWeightKg',
  action: 'sale_to_charity' | 'sale_to_cancel',
  auditAction: 'STORE_SALE_MOVED_TO_CHARITY' | 'STORE_SALE_MOVED_TO_CANCEL',
): Promise<IdempotencyResult<ProductCharityBalanceRecord | ProductCancelBalanceRecord>> {
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
        const lots = await lockProductLots(tx, input.storeId, input.productId);
        const consumed = takeBucket(
          lots,
          weightGrams,
          'saleWeightKg',
          'Weight exceeds the available Sale stock of this product.',
        );
        const now = new Date();
        const eventIds: string[] = [];
        for (const { lot, grams } of consumed) {
          const [updated] = await tx
            .update(storeSortedStocks)
            .set({
              saleWeightKg: gramsToKilogramsExact(kilogramsToGramsExact(lot.saleWeightKg) - grams),
              [destination]: gramsToKilogramsExact(kilogramsToGramsExact(lot[destination]) + grams),
              version: lot.version + 1,
              updatedAt: now,
            })
            .where(
              and(eq(storeSortedStocks.id, lot.id), eq(storeSortedStocks.version, lot.version)),
            )
            .returning({ id: storeSortedStocks.id });
          if (!updated) throw new StoreOperationConflictError('Sale stock changed during move.');
          eventIds.push(
            await recordSortingLotEvent(tx, lot, action, grams, input.actorUserId, now),
          );
        }
        const balance =
          destination === 'charityWeightKg'
            ? await productCharityBalance(tx, input.storeId, input.productId)
            : await productCancelBalance(tx, input.storeId, input.productId);
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: auditAction,
          entityType: 'store_sorting_event',
          entityId: eventIds[0]!,
          after: {
            productId: input.productId,
            weightKg: gramsToKilogramsExact(weightGrams),
            lots: consumed.map(({ lot, grams }) => ({
              stockId: lot.id,
              weightKg: gramsToKilogramsExact(grams),
            })),
            balance,
          },
        });
        return {
          value: balance,
          responseBody: balance,
          responseStatus: 200,
          resourceType: 'store_sorting_event',
          resourceId: eventIds[0]!,
        };
      }),
  );
}

export async function moveProductSaleToCharity(
  database: Database,
  input: MoveProductSaleToCharityInput,
): Promise<IdempotencyResult<ProductCharityBalanceRecord>> {
  return rerouteProductSale(
    database,
    input,
    'charityWeightKg',
    'sale_to_charity',
    'STORE_SALE_MOVED_TO_CHARITY',
  ) as Promise<IdempotencyResult<ProductCharityBalanceRecord>>;
}

export async function moveProductSaleToCancel(
  database: Database,
  input: MoveProductSaleToCancelInput,
): Promise<IdempotencyResult<ProductCancelBalanceRecord>> {
  return rerouteProductSale(
    database,
    input,
    'cancelWeightKg',
    'sale_to_cancel',
    'STORE_SALE_MOVED_TO_CANCEL',
  ) as Promise<IdempotencyResult<ProductCancelBalanceRecord>>;
}

async function lockProductLots(
  tx: Transaction,
  storeId: string,
  productId: string,
): Promise<SortedStockRow[]> {
  return tx
    .select()
    .from(storeSortedStocks)
    .where(and(eq(storeSortedStocks.storeId, storeId), eq(storeSortedStocks.productId, productId)))
    .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id))
    .for('update');
}

type SortedWeightBucket = 'charityWeightKg' | 'cancelWeightKg' | 'saleWeightKg';

function takeBucket(
  lots: readonly SortedStockRow[],
  grams: bigint,
  field: SortedWeightBucket,
  errorMessage: string,
): { lot: SortedStockRow; grams: bigint }[] {
  const consumed: { lot: SortedStockRow; grams: bigint }[] = [];
  let remaining = grams;
  for (const lot of lots) {
    if (remaining === 0n) break;
    const balance = kilogramsToGramsExact(lot[field]);
    const take = balance < remaining ? balance : remaining;
    if (take <= 0n) continue;
    consumed.push({ lot, grams: take });
    remaining -= take;
  }
  if (remaining !== 0n || consumed.length === 0)
    throw new StoreOperationValidationError(errorMessage);
  return consumed;
}

async function recordSortingLotEvent(
  tx: Transaction,
  lot: SortedStockRow,
  action: StoreSortingHistoryAction,
  grams: bigint,
  actorUserId: string,
  now: Date,
): Promise<string> {
  const [event] = await tx
    .insert(storeSortingEvents)
    .values({
      storeSortedStockId: lot.id,
      storeInventoryBagId: lot.storeInventoryBagId,
      storeId: lot.storeId,
      productId: lot.productId,
      action,
      weightKg: gramsToKilogramsExact(grams),
      actorUserId,
      occurredAt: now,
    })
    .returning({ id: storeSortingEvents.id });
  if (!event) throw new Error('Sorting event insert returned no row.');
  return event.id;
}

async function sumProductBuckets(
  tx: Transaction,
  storeId: string,
  productId: string,
): Promise<{ sale: bigint; charity: bigint; cancel: bigint }> {
  const lots = await tx
    .select({
      saleWeightKg: storeSortedStocks.saleWeightKg,
      charityWeightKg: storeSortedStocks.charityWeightKg,
      cancelWeightKg: storeSortedStocks.cancelWeightKg,
    })
    .from(storeSortedStocks)
    .where(and(eq(storeSortedStocks.storeId, storeId), eq(storeSortedStocks.productId, productId)));
  let sale = 0n;
  let charity = 0n;
  let cancel = 0n;
  for (const lot of lots) {
    sale += kilogramsToGramsExact(lot.saleWeightKg);
    charity += kilogramsToGramsExact(lot.charityWeightKg);
    cancel += kilogramsToGramsExact(lot.cancelWeightKg);
  }
  return { sale, charity, cancel };
}

async function productCharityBalance(
  tx: Transaction,
  storeId: string,
  productId: string,
): Promise<ProductCharityBalanceRecord> {
  const { sale, charity } = await sumProductBuckets(tx, storeId, productId);
  return {
    storeId,
    productId,
    charityWeightKg: gramsToKilogramsExact(charity),
    saleWeightKg: gramsToKilogramsExact(sale),
  };
}

async function productCancelBalance(
  tx: Transaction,
  storeId: string,
  productId: string,
): Promise<ProductCancelBalanceRecord> {
  const { sale, cancel } = await sumProductBuckets(tx, storeId, productId);
  return {
    storeId,
    productId,
    cancelWeightKg: gramsToKilogramsExact(cancel),
    saleWeightKg: gramsToKilogramsExact(sale),
  };
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
    inventoryLotId: stock.storeInventoryBagId ?? stock.sourceTransferId!,
    bagCode,
    saleWeightKg: stock.saleWeightKg,
    bagQuantity: stock.bagQuantity,
    charityWeightKg: stock.charityWeightKg,
    cancelWeightKg: stock.cancelWeightKg,
    version: stock.version,
    updatedAt: stock.updatedAt,
  };
}

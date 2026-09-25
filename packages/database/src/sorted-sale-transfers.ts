import {
  CreateSortedSaleTransferRequestSchema,
  type SortedSaleTransferLine,
} from '@idosi/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';

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
  products,
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

type Transfer = typeof sortedSaleTransfers.$inferSelect & { createdByDisplayName?: string | null };
const transferLines = (transfer: Transfer): SortedSaleTransferLine[] =>
  transfer.lines ?? [
    {
      productId: transfer.productId,
      sourceStockId: transfer.sourceStockId,
      bagQuantity: transfer.bagQuantity,
      weightKg: transfer.weightKg,
      enteredWeightKg: transfer.enteredWeightKg,
      bagWeightsKg: transfer.bagWeightsKg ?? [],
    },
  ];

interface CommandContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CreateSortedSaleTransferInput extends CommandContext {
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly productId?: string;
  readonly bagWeightsKg?: readonly string[];
  readonly lines?: readonly {
    readonly productId: string;
    readonly bagWeightsKg: readonly string[];
  }[];
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

/** Settled (received/cancelled) transfers shown as history; in-transit ones are never capped. */
export const SORTED_SALE_TRANSFER_HISTORY_LIMIT = 500;

/**
 * Every in-transit transfer of the scope, however old (the destination still has to receive it
 * or the source cancel it), plus the most recent settled ones as history, newest first.
 */
export async function listSortedSaleTransfers(
  database: Database,
  storeIds: readonly string[],
  historyLimit = SORTED_SALE_TRANSFER_HISTORY_LIMIT,
  page?: { page: number; pageSize: number },
): Promise<Transfer[]> {
  if (storeIds.length === 0) return [];
  const inScope = or(
    inArray(sortedSaleTransfers.sourceStoreId, [...storeIds]),
    inArray(sortedSaleTransfers.destinationStoreId, [...storeIds]),
  );
  if (page) {
    const rows = await database
      .select({ transfer: sortedSaleTransfers, actorName: users.displayName })
      .from(sortedSaleTransfers)
      .leftJoin(users, eq(users.id, sortedSaleTransfers.createdByUserId))
      .where(inScope)
      .orderBy(desc(sortedSaleTransfers.createdAt), desc(sortedSaleTransfers.id))
      .limit(page.pageSize + 1)
      .offset((page.page - 1) * page.pageSize);
    return rows.map((row) => ({ ...row.transfer, createdByDisplayName: row.actorName }));
  }
  const [open, settled] = await Promise.all([
    database
      .select()
      .from(sortedSaleTransfers)
      .where(and(inScope, eq(sortedSaleTransfers.status, 'in_transit'))),
    database
      .select()
      .from(sortedSaleTransfers)
      .where(and(inScope, ne(sortedSaleTransfers.status, 'in_transit')))
      .orderBy(desc(sortedSaleTransfers.createdAt), desc(sortedSaleTransfers.id))
      .limit(historyLimit),
  ]);
  const actorIds = [...new Set([...open, ...settled].map((row) => row.createdByUserId))];
  const actors = actorIds.length
    ? await database
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const names = new Map(actors.map((actor) => [actor.id, actor.name]));
  return [...open, ...settled]
    .map((row) => ({ ...row, createdByDisplayName: names.get(row.createdByUserId) ?? null }))
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
    );
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
  if (!transfer) return undefined;
  const [actor] = await database
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, transfer.createdByUserId))
    .limit(1);
  return { ...transfer, createdByDisplayName: actor?.name ?? null };
}

export async function createSortedSaleTransfer(
  database: Database,
  input: CreateSortedSaleTransferInput,
): Promise<IdempotencyResult<{ transferId: string }>> {
  const parsed = CreateSortedSaleTransferRequestSchema.safeParse({
    sourceStoreId: input.sourceStoreId,
    destinationStoreId: input.destinationStoreId,
    note: input.note,
    ...(input.lines
      ? { lines: input.lines }
      : { productId: input.productId, bagWeightsKg: input.bagWeightsKg }),
  });
  if (!parsed.success)
    throw new StoreOperationValidationError('Kiểm tra cửa hàng, mặt hàng duy nhất và kg từng bao.');
  const requested = 'lines' in parsed.data ? parsed.data.lines : [parsed.data];
  return withIdempotency(
    database,
    {
      scope: 'sorted-sale.transfer:' + input.sourceStoreId,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-sorting', input.sourceStoreId, async () => {
        await assertRetailStoreActor(tx, input.actorUserId, input.sourceStoreId);
        await assertActiveRetailStore(tx, input.destinationStoreId);
        const lines: SortedSaleTransferLine[] = [];
        const now = new Date();
        // All consumers serialize on the same source-store lock. Product/lot order is stable.
        for (const requestedLine of [...requested].sort((a, b) =>
          a.productId.localeCompare(b.productId),
        )) {
          const [product] = await tx
            .select({ id: products.id })
            .from(products)
            .where(
              and(
                eq(products.id, requestedLine.productId),
                isNull(products.deletedAt),
                eq(products.isActive, true),
              ),
            )
            .limit(1);
          if (!product) throw new StoreOperationValidationError('Mặt hàng không còn hoạt động.');
          const { bagWeightsKg, totalGrams: movedGrams } = weighBags(requestedLine.bagWeightsKg);
          const lots = await tx
            .select()
            .from(storeSortedStocks)
            .where(
              and(
                eq(storeSortedStocks.storeId, input.sourceStoreId),
                eq(storeSortedStocks.productId, requestedLine.productId),
              ),
            )
            .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id))
            .for('update');
          const available = lots.reduce(
            (sum, lot) => sum + kilogramsToGramsExact(lot.saleWeightKg),
            0n,
          );
          if (movedGrams > available)
            throw new StoreOperationValidationError(
              'Total bag weight exceeds the Sale stock of this product.',
            );
          let remaining = movedGrams;
          const sourceLots: { stockId: string; weightKg: string }[] = [];
          for (const lot of lots) {
            if (remaining === 0n) break;
            const balance = kilogramsToGramsExact(lot.saleWeightKg);
            const take = balance < remaining ? balance : remaining;
            if (take <= 0n) continue;
            remaining -= take;
            const after = balance - take;
            sourceLots.push({ stockId: lot.id, weightKg: gramsToKilogramsExact(take) });
            const [updated] = await tx
              .update(storeSortedStocks)
              .set({
                saleWeightKg: gramsToKilogramsExact(after),
                ...(after === 0n ? { bagQuantity: 0 } : {}),
                transferredOutWeightKg: gramsToKilogramsExact(
                  kilogramsToGramsExact(lot.transferredOutWeightKg) + take,
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
              weightKg: gramsToKilogramsExact(take),
              actorUserId: input.actorUserId,
              occurredAt: now,
            });
          }
          if (!sourceLots[0] || remaining !== 0n)
            throw new StoreOperationValidationError('Sale stock could not cover the transfer.');
          lines.push({
            productId: requestedLine.productId,
            sourceStockId: sourceLots[0].stockId,
            bagQuantity: bagWeightsKg.length,
            weightKg: gramsToKilogramsExact(movedGrams),
            enteredWeightKg: gramsToKilogramsExact(movedGrams),
            bagWeightsKg,
            sourceLots,
          });
        }
        const first = lines[0]!;
        const [transfer] = await tx
          .insert(sortedSaleTransfers)
          .values({
            transferNumber: '',
            sourceStockId: first.sourceStockId,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            productId: first.productId,
            bagQuantity: first.bagQuantity,
            weightKg: first.weightKg,
            enteredWeightKg: first.enteredWeightKg,
            bagWeightsKg: first.bagWeightsKg,
            lines,
            note: input.note,
            createdByUserId: input.actorUserId,
            createdAt: now,
          })
          .returning({ id: sortedSaleTransfers.id });
        if (!transfer) throw new Error('Transfer insert returned no row.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: input.sourceStoreId,
          action: 'SORTED_SALE_TRANSFER_DISPATCHED',
          entityType: 'sorted_sale_transfer',
          entityId: transfer.id,
          after: {
            destinationStoreId: input.destinationStoreId,
            lines: lines.map((line) => ({
              productId: line.productId,
              bagWeightsKg: line.bagWeightsKg,
              weightKg: line.weightKg,
              lots: line.sourceLots ?? [],
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
  return settleTransfer(database, input, false);
}
export async function cancelSortedSaleTransfer(
  database: Database,
  input: CancelSortedSaleTransferInput,
): Promise<IdempotencyResult<{ transferId: string }>> {
  if (input.reason.trim().length < 3)
    throw new StoreOperationValidationError('Cần ghi lý do hủy phiếu tối thiểu 3 ký tự.');
  return settleTransfer(database, input, true);
}
async function settleTransfer(
  database: Database,
  input: ReceiveSortedSaleTransferInput | CancelSortedSaleTransferInput,
  cancel: boolean,
): Promise<IdempotencyResult<{ transferId: string }>> {
  return withIdempotency(
    database,
    {
      scope: (cancel ? 'sorted-sale.cancel:' : 'sorted-sale.receive:') + input.transferId,
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
        const targetStoreId = cancel ? transfer.sourceStoreId : transfer.destinationStoreId;
        await assertRetailStoreActor(tx, input.actorUserId, targetStoreId);
        if (transfer.status !== 'in_transit' || transfer.version !== input.expectedVersion)
          throw new StoreOperationConflictError('Transfer was already received or changed.');
        return withAdvisoryLock(tx, 'store-sorting', targetStoreId, async () => {
          const now = new Date();
          const lines = transferLines(transfer);
          const stockIds: string[] = [];
          for (const line of lines) {
            if (!cancel) {
              const hasSale = await tx
                .select({ id: storeSortedStocks.id })
                .from(storeSortedStocks)
                .where(
                  and(
                    eq(storeSortedStocks.storeId, targetStoreId),
                    eq(storeSortedStocks.productId, line.productId),
                    gt(storeSortedStocks.saleCreditedWeightKg, '0.000'),
                  ),
                )
                .limit(1);
              if (!hasSale.length)
                await initializeSaleBaseline(tx, targetStoreId, line.productId, now);
            }
            const [stock] = await tx
              .insert(storeSortedStocks)
              .values({
                storeId: targetStoreId,
                productId: line.productId,
                sourceTransferId: transfer.id,
                saleCreditedWeightKg: line.weightKg,
                saleWeightKg: line.weightKg,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: storeSortedStocks.id });
            if (!stock) throw new Error('Sale stock insert returned no row.');
            stockIds.push(stock.id);
            await tx.insert(storeSortingEvents).values({
              storeSortedStockId: stock.id,
              storeInventoryBagId: null,
              storeId: targetStoreId,
              productId: line.productId,
              action: cancel ? 'sale_transfer_return' : 'sale_transfer_in',
              weightKg: line.weightKg,
              actorUserId: input.actorUserId,
              occurredAt: now,
            });
            await settleProductSaleProgress(tx, targetStoreId, line.productId, now);
          }
          const reason = 'reason' in input ? input.reason.trim() : null;
          const [updated] = await tx
            .update(sortedSaleTransfers)
            .set({
              status: cancel ? 'cancelled' : 'received',
              version: transfer.version + 1,
              ...(cancel
                ? {
                    cancelledByUserId: input.actorUserId,
                    cancelledAt: now,
                    cancellationReason: reason,
                  }
                : {
                    destinationStockId: stockIds[0],
                    receivedByUserId: input.actorUserId,
                    receivedAt: now,
                  }),
            })
            .where(
              and(
                eq(sortedSaleTransfers.id, transfer.id),
                eq(sortedSaleTransfers.version, transfer.version),
                eq(sortedSaleTransfers.status, 'in_transit'),
              ),
            )
            .returning({ id: sortedSaleTransfers.id });
          if (!updated)
            throw new StoreOperationConflictError('Transfer changed during settlement.');
          await tx.insert(auditLogs).values({
            requestId: input.requestId,
            actorUserId: input.actorUserId,
            actorRole: 'store',
            actorStoreId: targetStoreId,
            action: cancel ? 'SORTED_SALE_TRANSFER_CANCELLED' : 'SORTED_SALE_TRANSFER_RECEIVED',
            entityType: 'sorted_sale_transfer',
            entityId: transfer.id,
            before: { status: 'in_transit' },
            after: {
              status: cancel ? 'cancelled' : 'received',
              stockIds,
              reason,
              lines: lines.map((line) => ({
                productId: line.productId,
                weightKg: line.weightKg,
                bagQuantity: line.bagQuantity,
              })),
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

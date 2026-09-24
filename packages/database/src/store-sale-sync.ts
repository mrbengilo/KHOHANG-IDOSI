import {
  canonicalIdosiProductName,
  IdosiOrderStatisticsPayloadSchema,
  type IdosiOrderStatisticsPayload,
} from '@idosi/contracts';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import {
  auditLogs,
  idosiProductLinks,
  idosiStatisticsSnapshots,
  products,
  storeSaleSyncProgress,
  storeSortedStocks,
  storeSortingEvents,
} from './schema.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationValidationError,
} from './store-operations.js';
import type { Transaction } from './transaction.js';

type SaleType = 'sale_kg' | 'sale_piece';

export const productKey = (value: string) =>
  canonicalIdosiProductName(value)
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('vi-VN');

function sourceGrams(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1000))) {
    throw new StoreOperationValidationError(
      'IDOSI sale weight is outside supported gram precision.',
    );
  }
  return BigInt(Math.round(value * 1000));
}

type IdosiItem = IdosiOrderStatisticsPayload['products']['items'][number];

/** IDOSI id -> warehouse product id, learned the first time a name matched. */
export type IdosiProductLinks = ReadonlyMap<string, string>;

export interface IdosiProductMatch {
  readonly productId: string;
  readonly links: IdosiProductLinks;
}

/** The id IDOSI keeps across renames when it sends one, else the id the line was sold with. */
export function idosiItemKey(item: Pick<IdosiItem, 'productId' | 'canonicalProductId'>): string {
  return item.canonicalProductId ?? item.productId;
}

/**
 * Lines belonging to one warehouse product. With links (the database path) only lines whose
 * IDOSI id is linked to this product count, so a rename on either side keeps matching and a
 * line that is unmatched or ambiguous is never charged to a guessed product. Without links
 * (the in-memory demo) the normalized name is compared directly.
 */
export function idosiItemsForProduct(
  payload: IdosiOrderStatisticsPayload,
  name: string,
  match?: IdosiProductMatch,
): IdosiItem[] {
  return payload.products.items.filter((item) => {
    if (match) return match.links.get(idosiItemKey(item)) === match.productId;
    return productKey(item.productName) === productKey(name);
  });
}

export interface IdosiNameCandidate {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

/**
 * The single warehouse product an IDOSI name may be linked to automatically: the only active
 * product with that normalized name, or else the only inactive one (stock of a retired item can
 * still be sold). Deleted products never qualify. Two candidates at the same level are
 * ambiguous and return null, so an Admin has to choose.
 */
export function uniqueProductForName(
  candidates: readonly IdosiNameCandidate[],
  idosiName: string,
): string | null {
  const key = productKey(idosiName);
  const named = candidates.filter((candidate) => productKey(candidate.name) === key);
  const active = named.filter((candidate) => candidate.isActive);
  const pool = active.length > 0 ? active : named;
  return pool.length === 1 ? pool[0]!.id : null;
}

/** Records the IDOSI id of every line whose name matches exactly one warehouse product today. */
export async function linkIdosiProducts(
  tx: Transaction,
  payload: IdosiOrderStatisticsPayload,
): Promise<IdosiProductLinks> {
  const existing = await tx.select().from(idosiProductLinks);
  const links = new Map(existing.map((row) => [row.idosiProductId, row.productId]));
  const unlinked = payload.products.items.filter((item) => !links.has(idosiItemKey(item)));
  if (unlinked.length === 0) return links;
  const catalog = await tx
    .select({ id: products.id, name: products.name, isActive: products.isActive })
    .from(products)
    .where(isNull(products.deletedAt));
  for (const item of unlinked) {
    const key = idosiItemKey(item);
    const productId = uniqueProductForName(catalog, item.productName);
    if (!productId || links.has(key)) continue;
    await tx
      .insert(idosiProductLinks)
      .values({ idosiProductId: key, productId, firstSeenName: item.productName })
      .onConflictDoNothing();
    links.set(key, productId);
  }
  return links;
}

/** The monthly source is cumulative. Round the whole product/type once to avoid drift. */
export function idosiProductSaleGrams(
  payload: IdosiOrderStatisticsPayload,
  name: string,
  type: SaleType,
  match?: IdosiProductMatch,
): bigint | null {
  const matching = idosiItemsForProduct(payload, name, match).filter(
    (item) => item.revenueType === (type === 'sale_kg' ? 'SALE_KG' : 'SALE_PIECE'),
  );
  if (matching.some((item) => !item.weight.isComplete)) return null;
  const kilograms = matching.reduce(
    (sum, item) => sum + (type === 'sale_kg' ? item.weight.actualKg : item.weight.estimatedKg),
    0,
  );
  return sourceGrams(kilograms);
}

function currentPeriod(now: Date): string {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
}

function fullMonthScopeKey(period: string): string {
  return JSON.stringify([period, null, null, null]);
}

/** Capture existing IDOSI sales before the first sale credit so historical sales are not charged to new stock. */
export async function initializeSaleBaseline(
  tx: Transaction,
  storeId: string,
  productId: string,
  now: Date,
): Promise<void> {
  const period = currentPeriod(now);
  const [product] = await tx
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new StoreOperationValidationError('Sale product does not exist.');
  const [snapshot] = await tx
    .select()
    .from(idosiStatisticsSnapshots)
    .where(
      and(
        eq(idosiStatisticsSnapshots.storeId, storeId),
        eq(idosiStatisticsSnapshots.scopeKey, fullMonthScopeKey(period)),
      ),
    )
    .limit(1);
  if (!snapshot)
    throw new StoreOperationValidationError(
      'Cần đồng bộ IDOSI tháng hiện tại trước khi lưu Sale lần đầu.',
    );
  const payload = IdosiOrderStatisticsPayloadSchema.parse(snapshot.payload);
  const links = await linkIdosiProducts(tx, payload);
  for (const type of ['sale_kg', 'sale_piece'] as const) {
    const grams = idosiProductSaleGrams(payload, product.name, type, { productId, links });
    if (grams === null)
      throw new StoreOperationValidationError(
        'IDOSI chưa có đủ định mức kg cho Sale theo cái của mặt hàng này.',
      );
    await tx
      .insert(storeSaleSyncProgress)
      .values({
        storeId,
        productId,
        period,
        saleType: type,
        baselineGrams: grams,
        observedGrams: grams,
        appliedGrams: 0n,
        sourceSnapshotId: snapshot.id,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

/** Called in the same transaction that records a fresh, full-month IDOSI snapshot. */
export async function reconcileStoreSaleSnapshot(
  tx: Transaction,
  storeId: string,
  period: string,
  snapshotId: string,
  payload: IdosiOrderStatisticsPayload,
  now: Date,
): Promise<void> {
  const credited = await tx
    .select({ productId: storeSortedStocks.productId, createdAt: storeSortedStocks.createdAt })
    .from(storeSortedStocks)
    .where(
      and(
        eq(storeSortedStocks.storeId, storeId),
        gt(storeSortedStocks.saleCreditedWeightKg, '0.000'),
      ),
    );
  const firstCreditPeriod = new Map<string, string>();
  for (const row of credited) {
    const creditPeriod = currentPeriod(row.createdAt);
    const first = firstCreditPeriod.get(row.productId);
    if (!first || creditPeriod < first) firstCreditPeriod.set(row.productId, creditPeriod);
  }
  // An operator may inspect older IDOSI months after sorting began. Those sales
  // preceded this stock and must never be charged against its current balance.
  const productIds = [...firstCreditPeriod]
    .filter(([, creditPeriod]) => period >= creditPeriod)
    .map(([productId]) => productId);
  if (productIds.length === 0) return;
  const namedProducts = await tx.select({ id: products.id, name: products.name }).from(products);
  const names = new Map(namedProducts.map((product) => [product.id, product.name]));
  const links = await linkIdosiProducts(tx, payload);
  for (const productId of productIds) {
    const name = names.get(productId);
    if (!name) continue;
    for (const type of ['sale_kg', 'sale_piece'] as const) {
      const observed = idosiProductSaleGrams(payload, name, type, { productId, links });
      if (observed === null) continue;
      const [existing] = await tx
        .select()
        .from(storeSaleSyncProgress)
        .where(
          and(
            eq(storeSaleSyncProgress.storeId, storeId),
            eq(storeSaleSyncProgress.productId, productId),
            eq(storeSaleSyncProgress.period, period),
            eq(storeSaleSyncProgress.saleType, type),
          ),
        )
        .for('update')
        .limit(1);
      if (existing) {
        await tx
          .update(storeSaleSyncProgress)
          .set({ observedGrams: observed, sourceSnapshotId: snapshotId, updatedAt: now })
          .where(eq(storeSaleSyncProgress.id, existing.id));
      } else {
        await tx.insert(storeSaleSyncProgress).values({
          storeId,
          productId,
          period,
          saleType: type,
          baselineGrams: 0n,
          observedGrams: observed,
          appliedGrams: 0n,
          sourceSnapshotId: snapshotId,
          updatedAt: now,
        });
      }
    }
    await settleProductSaleProgress(tx, storeId, productId, now);
  }
}

/** Apply outstanding prior-month demand when fresh stock is moved into the sale pool. */
export async function settleProductSaleProgress(
  tx: Transaction,
  storeId: string,
  productId: string,
  now: Date,
): Promise<void> {
  const progress = await tx
    .select()
    .from(storeSaleSyncProgress)
    .where(
      and(
        eq(storeSaleSyncProgress.storeId, storeId),
        eq(storeSaleSyncProgress.productId, productId),
      ),
    )
    .orderBy(asc(storeSaleSyncProgress.period), asc(storeSaleSyncProgress.saleType))
    .for('update');
  const lots = await tx
    .select()
    .from(storeSortedStocks)
    .where(and(eq(storeSortedStocks.storeId, storeId), eq(storeSortedStocks.productId, productId)))
    .orderBy(asc(storeSortedStocks.createdAt), asc(storeSortedStocks.id))
    .for('update');
  if (lots.length === 0) return;
  const balances = new Map(lots.map((lot) => [lot.id, kilogramsToGramsExact(lot.saleWeightKg)]));
  // Restore source corrections before applying later sales. Each lot is capped at its
  // total credited sale weight, so corrections cannot create stock from nothing.
  for (const checkpoint of progress) {
    const target =
      checkpoint.observedGrams > checkpoint.baselineGrams
        ? checkpoint.observedGrams - checkpoint.baselineGrams
        : 0n;
    let toRestore = checkpoint.appliedGrams > target ? checkpoint.appliedGrams - target : 0n;
    for (const lot of [...lots].reverse()) {
      if (toRestore === 0n) break;
      const balance = balances.get(lot.id)!;
      const room =
        kilogramsToGramsExact(lot.saleCreditedWeightKg) -
        kilogramsToGramsExact(lot.transferredOutWeightKg) -
        balance;
      const amount = room < toRestore ? room : toRestore;
      if (amount <= 0n) continue;
      await updateLotAndRecord(
        tx,
        lot,
        balance + amount,
        amount,
        'idosi_sale_correction',
        checkpoint.sourceSnapshotId,
        now,
      );
      balances.set(lot.id, balance + amount);
      toRestore -= amount;
    }
    if (toRestore !== 0n) throw new Error('Sale correction could not restore prior consumption.');
    if (checkpoint.appliedGrams > target) {
      await tx
        .update(storeSaleSyncProgress)
        .set({ appliedGrams: target, updatedAt: now })
        .where(eq(storeSaleSyncProgress.id, checkpoint.id));
    }
  }
  for (const checkpoint of progress) {
    const target =
      checkpoint.observedGrams > checkpoint.baselineGrams
        ? checkpoint.observedGrams - checkpoint.baselineGrams
        : 0n;
    let toConsume = target > checkpoint.appliedGrams ? target - checkpoint.appliedGrams : 0n;
    const original = toConsume;
    for (const lot of lots) {
      if (toConsume === 0n) break;
      const balance = balances.get(lot.id)!;
      const amount = balance < toConsume ? balance : toConsume;
      if (amount <= 0n) continue;
      await updateLotAndRecord(
        tx,
        lot,
        balance - amount,
        amount,
        checkpoint.saleType === 'sale_kg' ? 'idosi_sale_kg' : 'idosi_sale_piece',
        checkpoint.sourceSnapshotId,
        now,
      );
      balances.set(lot.id, balance - amount);
      toConsume -= amount;
    }
    if (original !== toConsume) {
      await tx
        .update(storeSaleSyncProgress)
        .set({ appliedGrams: checkpoint.appliedGrams + original - toConsume, updatedAt: now })
        .where(eq(storeSaleSyncProgress.id, checkpoint.id));
    }
  }
}

async function updateLotAndRecord(
  tx: Transaction,
  lot: typeof storeSortedStocks.$inferSelect,
  balanceGrams: bigint,
  movementGrams: bigint,
  action: 'idosi_sale_kg' | 'idosi_sale_piece' | 'idosi_sale_correction',
  sourceSnapshotId: string | null,
  now: Date,
): Promise<void> {
  await tx
    .update(storeSortedStocks)
    .set({
      saleWeightKg: gramsToKilogramsExact(balanceGrams),
      bagQuantity:
        balanceGrams === 0n ? 0 : lot.creditedBagQuantity - lot.transferredOutBagQuantity,
      version: sql`${storeSortedStocks.version} + 1`,
      updatedAt: now,
    })
    .where(eq(storeSortedStocks.id, lot.id));
  const [event] = await tx
    .insert(storeSortingEvents)
    .values({
      storeSortedStockId: lot.id,
      storeInventoryBagId: lot.storeInventoryBagId,
      storeId: lot.storeId,
      productId: lot.productId,
      action,
      weightKg: gramsToKilogramsExact(movementGrams),
      sourceSnapshotId,
      actorUserId: null,
      occurredAt: now,
    })
    .returning({ id: storeSortingEvents.id });
  if (!event) throw new Error('IDOSI sale event insert returned no row.');
  await tx.insert(auditLogs).values({
    action:
      action === 'idosi_sale_correction' ? 'IDOSI_SALE_CORRECTED' : 'IDOSI_SALE_STOCK_CONSUMED',
    entityType: 'store_sorting_event',
    entityId: event.id,
    actorStoreId: lot.storeId,
    after: {
      stockId: lot.id,
      productId: lot.productId,
      action,
      weightKg: gramsToKilogramsExact(movementGrams),
      sourceSnapshotId,
    },
  });
}

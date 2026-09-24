import { randomUUID } from 'node:crypto';

import type { IdosiOrderStatisticsPayload } from '@idosi/contracts';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  products,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storeNormalSaleProgress,
} from './schema.js';
import {
  idosiItemsForProduct,
  linkIdosiProducts,
  type IdosiProductMatch,
} from './store-sale-sync.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationValidationError,
} from './store-operations.js';
import type { Transaction } from './transaction.js';

type BagRow = typeof storeInventoryBags.$inferSelect;
type ProgressRow = typeof storeNormalSaleProgress.$inferSelect;

/**
 * Regular-price (NORMAL) weight IDOSI sold for one product this month. Kilogram lines use the
 * weighed amount, piece lines the per-piece norm. Null while any line still lacks a norm, so an
 * incomplete month never under-counts what left the store.
 */
export function idosiNormalSaleGrams(
  payload: IdosiOrderStatisticsPayload,
  name: string,
  match?: IdosiProductMatch,
): bigint | null {
  const matching = idosiItemsForProduct(payload, name, match).filter(
    (item) => item.revenueType === 'NORMAL',
  );
  if (matching.some((item) => !item.weight.isComplete)) return null;
  const kilograms = matching.reduce(
    (sum, item) => sum + (item.unit === 'KG' ? item.weight.actualKg : item.weight.estimatedKg),
    0,
  );
  if (!Number.isFinite(kilograms) || !Number.isSafeInteger(Math.round(kilograms * 1000))) {
    throw new StoreOperationValidationError(
      'IDOSI regular sale weight is outside supported gram precision.',
    );
  }
  return BigInt(Math.round(kilograms * 1000));
}

/**
 * Called with the store-sorting lock held, in the transaction that records a fresh full-month
 * IDOSI snapshot. Takes regular-price sales out of the store's inventory bags so the bag
 * balance keeps matching what is physically left to sell or sort.
 */
export async function reconcileStoreNormalSaleSnapshot(
  tx: Transaction,
  storeId: string,
  period: string,
  snapshotId: string,
  payload: IdosiOrderStatisticsPayload,
  now: Date,
): Promise<void> {
  const catalog = await tx.select({ id: products.id, name: products.name }).from(products);
  const tracked = await tx
    .select({
      productId: storeNormalSaleProgress.productId,
      period: storeNormalSaleProgress.period,
    })
    .from(storeNormalSaleProgress)
    .where(eq(storeNormalSaleProgress.storeId, storeId));
  const firstPeriodByProduct = new Map<string, string>();
  for (const row of tracked) {
    const first = firstPeriodByProduct.get(row.productId);
    if (!first || row.period < first) firstPeriodByProduct.set(row.productId, row.period);
  }
  const currentPeriod = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);

  const links = await linkIdosiProducts(tx, payload);
  for (const product of catalog) {
    const match = { productId: product.id, links };
    const listed = idosiItemsForProduct(payload, product.name, match).length > 0;
    const firstPeriod = firstPeriodByProduct.get(product.id);
    // Tracking starts in the month it is first seen. Looking at an older month in IDOSI must
    // never charge those historical sales to the bags the store holds today.
    if (firstPeriod === undefined ? !listed || period !== currentPeriod : period < firstPeriod)
      continue;
    const observed = idosiNormalSaleGrams(payload, product.name, match);
    if (observed === null) continue;
    const [existing] = await tx
      .select()
      .from(storeNormalSaleProgress)
      .where(
        and(
          eq(storeNormalSaleProgress.storeId, storeId),
          eq(storeNormalSaleProgress.productId, product.id),
          eq(storeNormalSaleProgress.period, period),
        ),
      )
      .for('update')
      .limit(1);
    if (existing) {
      await tx
        .update(storeNormalSaleProgress)
        .set({ observedGrams: observed, sourceSnapshotId: snapshotId, updatedAt: now })
        .where(eq(storeNormalSaleProgress.id, existing.id));
    } else {
      // The first month a product is tracked starts from what IDOSI already reports, so sales
      // made before this sync existed are never charged to today's bags. Later months start at 0.
      const firstEver = firstPeriod === undefined;
      await tx.insert(storeNormalSaleProgress).values({
        storeId,
        productId: product.id,
        period,
        baselineGrams: firstEver ? observed : 0n,
        observedGrams: observed,
        appliedGrams: 0n,
        sourceSnapshotId: snapshotId,
        updatedAt: now,
      });
      if (firstEver) firstPeriodByProduct.set(product.id, period);
    }
    await settleStoreNormalSaleProgress(tx, storeId, product.id, now);
  }
}

/** Applies outstanding regular-price sales (or IDOSI corrections) to the product's bags. */
export async function settleStoreNormalSaleProgress(
  tx: Transaction,
  storeId: string,
  productId: string,
  now: Date,
): Promise<void> {
  const progress = await tx
    .select()
    .from(storeNormalSaleProgress)
    .where(
      and(
        eq(storeNormalSaleProgress.storeId, storeId),
        eq(storeNormalSaleProgress.productId, productId),
      ),
    )
    .orderBy(asc(storeNormalSaleProgress.period))
    .for('update');
  for (const checkpoint of progress) {
    const target =
      checkpoint.observedGrams > checkpoint.baselineGrams
        ? checkpoint.observedGrams - checkpoint.baselineGrams
        : 0n;
    if (checkpoint.appliedGrams > target) {
      const restored = await restoreBags(
        tx,
        storeId,
        productId,
        checkpoint.appliedGrams - target,
        checkpoint,
        now,
      );
      await setApplied(tx, checkpoint, checkpoint.appliedGrams - restored, now);
    } else if (checkpoint.appliedGrams < target) {
      const consumed = await consumeBags(
        tx,
        storeId,
        productId,
        target - checkpoint.appliedGrams,
        checkpoint,
        now,
      );
      if (consumed > 0n) await setApplied(tx, checkpoint, checkpoint.appliedGrams + consumed, now);
    }
  }
}

async function setApplied(
  tx: Transaction,
  checkpoint: ProgressRow,
  appliedGrams: bigint,
  now: Date,
): Promise<void> {
  await tx
    .update(storeNormalSaleProgress)
    .set({ appliedGrams, updatedAt: now })
    .where(eq(storeNormalSaleProgress.id, checkpoint.id));
}

/** Goods are sold off the shelf first, so opened bags go before sealed ones, oldest first. */
async function consumeBags(
  tx: Transaction,
  storeId: string,
  productId: string,
  grams: bigint,
  checkpoint: ProgressRow,
  now: Date,
): Promise<bigint> {
  const bags = await tx
    .select()
    .from(storeInventoryBags)
    .where(
      and(
        eq(storeInventoryBags.storeId, storeId),
        eq(storeInventoryBags.productId, productId),
        inArray(storeInventoryBags.status, ['opened', 'available']),
        gt(storeInventoryBags.currentWeightKg, '0.000'),
      ),
    )
    .orderBy(
      sql`case when ${storeInventoryBags.status} = 'opened' then 0 else 1 end`,
      asc(sql`coalesce(${storeInventoryBags.openedAt}, ${storeInventoryBags.receivedAt})`),
      asc(storeInventoryBags.id),
    )
    .for('update');
  let remaining = grams;
  for (const bag of bags) {
    if (remaining === 0n) break;
    const balance = kilogramsToGramsExact(bag.currentWeightKg);
    const take = balance < remaining ? balance : remaining;
    if (take <= 0n) continue;
    await moveBag(tx, bag, balance - take, take, 'consume', checkpoint, now);
    remaining -= take;
  }
  // Sales IDOSI reports beyond what the bags hold stay outstanding for the next bags.
  return grams - remaining;
}

/** An IDOSI correction returns weight to the bags that lost it, newest first. */
async function restoreBags(
  tx: Transaction,
  storeId: string,
  productId: string,
  grams: bigint,
  checkpoint: ProgressRow,
  now: Date,
): Promise<bigint> {
  const bags = await tx
    .select()
    .from(storeInventoryBags)
    .where(
      and(
        eq(storeInventoryBags.storeId, storeId),
        eq(storeInventoryBags.productId, productId),
        inArray(storeInventoryBags.status, ['opened', 'available', 'depleted']),
        gt(storeInventoryBags.normalSaleConsumedKg, '0.000'),
      ),
    )
    .orderBy(desc(storeInventoryBags.updatedAt), desc(storeInventoryBags.id))
    .for('update');
  let remaining = grams;
  for (const bag of bags) {
    if (remaining === 0n) break;
    const consumed = kilogramsToGramsExact(bag.normalSaleConsumedKg);
    const back = consumed < remaining ? consumed : remaining;
    if (back <= 0n) continue;
    await moveBag(
      tx,
      bag,
      kilogramsToGramsExact(bag.currentWeightKg) + back,
      back,
      'restore',
      checkpoint,
      now,
    );
    remaining -= back;
  }
  return grams - remaining;
}

async function moveBag(
  tx: Transaction,
  bag: BagRow,
  afterGrams: bigint,
  movedGrams: bigint,
  direction: 'consume' | 'restore',
  checkpoint: ProgressRow,
  now: Date,
): Promise<void> {
  const consumedGrams =
    kilogramsToGramsExact(bag.normalSaleConsumedKg) +
    (direction === 'consume' ? movedGrams : -movedGrams);
  const depleted = afterGrams === 0n;
  const [updated] = await tx
    .update(storeInventoryBags)
    .set({
      currentWeightKg: gramsToKilogramsExact(afterGrams),
      normalSaleConsumedKg: gramsToKilogramsExact(consumedGrams),
      status: depleted ? 'depleted' : 'opened',
      openedAt: bag.openedAt ?? now,
      depletedAt: depleted ? (bag.depletedAt ?? now) : null,
      version: bag.version + 1,
      updatedAt: now,
    })
    .where(and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)))
    .returning({ id: storeInventoryBags.id });
  if (!updated) throw new Error('Inventory bag changed during IDOSI regular-sale sync.');
  await tx.insert(storeInventoryLedgerEntries).values({
    storeInventoryBagId: bag.id,
    storeId: bag.storeId,
    productId: bag.productId,
    eventType: direction === 'consume' ? 'consume' : 'adjust',
    weightBeforeKg: bag.currentWeightKg,
    weightAfterKg: gramsToKilogramsExact(afterGrams),
    sourceType: direction === 'consume' ? 'idosi_normal_sale' : 'idosi_normal_sale_correction',
    sourceId: randomUUID(),
    reason:
      direction === 'consume'
        ? `Bán thường trên IDOSI tháng ${checkpoint.period}`
        : `IDOSI điều chỉnh giảm bán thường tháng ${checkpoint.period}`,
    metadata: {
      period: checkpoint.period,
      sourceSnapshotId: checkpoint.sourceSnapshotId,
      weightKg: gramsToKilogramsExact(movedGrams),
    },
    actorUserId: null,
    occurredAt: now,
  });
}

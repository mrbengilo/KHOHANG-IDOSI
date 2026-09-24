import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from './client.js';
import { auditLogs, idosiProductLinks, idosiStatisticsSnapshots, products } from './schema.js';
import { idosiItemKey, productKey, uniqueProductForName } from './store-sale-sync.js';
import { withAdvisoryLock, withTransaction } from './transaction.js';

export interface IdosiProductLinkRecord {
  readonly idosiProductId: string;
  readonly firstSeenName: string;
  readonly productId: string;
  readonly productName: string;
  readonly productSku: string;
  readonly createdAt: Date;
}

export interface UnmatchedIdosiProductRecord {
  readonly idosiProductId: string;
  readonly productName: string;
  /** Stores whose latest full-month snapshot of the period lists this IDOSI product. */
  readonly storeCount: number;
  /**
   * NO_PRODUCT: no warehouse product has this name. AMBIGUOUS: several do. PENDING_SYNC: exactly
   * one does (e.g. created after the last sync); the next sync links it automatically.
   */
  readonly reason: 'NO_PRODUCT' | 'AMBIGUOUS' | 'PENDING_SYNC';
  readonly candidateProductIds: readonly string[];
}

export interface IdosiProductMatchingRecord {
  readonly period: string;
  readonly links: readonly IdosiProductLinkRecord[];
  readonly unmatched: readonly UnmatchedIdosiProductRecord[];
}

/**
 * Current links plus the IDOSI products of one month that no link covers. Their sales are not
 * charged to any warehouse stock until an Admin links them, so they must be visible.
 */
export async function loadIdosiProductMatching(
  database: Database,
  period: string,
): Promise<IdosiProductMatchingRecord> {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new TypeError('Invalid IDOSI period');
  const [linkRows, catalog, snapshots] = await Promise.all([
    database
      .select({ link: idosiProductLinks, product: products })
      .from(idosiProductLinks)
      .innerJoin(products, eq(idosiProductLinks.productId, products.id))
      .orderBy(asc(idosiProductLinks.firstSeenName)),
    database
      .select({ id: products.id, name: products.name, isActive: products.isActive })
      .from(products)
      .where(isNull(products.deletedAt)),
    database
      .select({
        storeId: idosiStatisticsSnapshots.storeId,
        payload: idosiStatisticsSnapshots.payload,
      })
      .from(idosiStatisticsSnapshots)
      .where(
        and(
          eq(idosiStatisticsSnapshots.period, period),
          isNull(idosiStatisticsSnapshots.filterDate),
          isNull(idosiStatisticsSnapshots.shiftId),
          isNull(idosiStatisticsSnapshots.paymentMethod),
        ),
      ),
  ]);
  const linked = new Set(linkRows.map((row) => row.link.idosiProductId));
  const unmatched = new Map<string, { name: string; stores: Set<string> }>();
  for (const snapshot of snapshots) {
    const parsed = IdosiOrderStatisticsPayloadSchema.safeParse(snapshot.payload);
    if (!parsed.success) continue;
    for (const item of parsed.data.products.items) {
      const key = idosiItemKey(item);
      if (linked.has(key)) continue;
      const entry = unmatched.get(key) ?? { name: item.productName, stores: new Set<string>() };
      entry.stores.add(snapshot.storeId);
      unmatched.set(key, entry);
    }
  }
  return {
    period,
    links: linkRows.map(({ link, product }) => ({
      idosiProductId: link.idosiProductId,
      firstSeenName: link.firstSeenName,
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      createdAt: link.createdAt,
    })),
    unmatched: [...unmatched]
      .map(([idosiProductId, entry]) => {
        const candidates = catalog
          .filter((product) => productKey(product.name) === productKey(entry.name))
          .map((product) => product.id);
        return {
          idosiProductId,
          productName: entry.name,
          storeCount: entry.stores.size,
          reason:
            candidates.length === 0
              ? ('NO_PRODUCT' as const)
              : uniqueProductForName(catalog, entry.name) === null
                ? ('AMBIGUOUS' as const)
                : ('PENDING_SYNC' as const),
          candidateProductIds: candidates,
        };
      })
      .sort((left, right) => left.productName.localeCompare(right.productName, 'vi')),
  };
}

export class IdosiProductLinkValidationError extends Error {
  public readonly code = 'IDOSI_PRODUCT_LINK_INVALID';
}

export interface SetIdosiProductLinkInput {
  readonly idosiProductId: string;
  readonly idosiProductName: string;
  readonly productId: string;
  readonly reason: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * Admin decision for one IDOSI product: link it, or move an existing link to another warehouse
 * product. The next full-month sync reconciles both products from IDOSI's cumulative figures, so
 * the previously linked product gets its wrongly charged weight back as a correction.
 */
export async function setIdosiProductLink(
  database: Database,
  input: SetIdosiProductLinkInput,
): Promise<IdosiProductLinkRecord> {
  const idosiProductId = input.idosiProductId.trim();
  if (!idosiProductId || idosiProductId.length > 200) {
    throw new IdosiProductLinkValidationError('IDOSI product id is invalid.');
  }
  return withTransaction(database, (tx) =>
    withAdvisoryLock(tx, 'idosi-product-link', idosiProductId, async () => {
      const [product] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
        .limit(1);
      if (!product) throw new IdosiProductLinkValidationError('Warehouse product does not exist.');
      const [existing] = await tx
        .select()
        .from(idosiProductLinks)
        .where(eq(idosiProductLinks.idosiProductId, idosiProductId))
        .for('update')
        .limit(1);
      const firstSeenName =
        existing?.firstSeenName ?? (input.idosiProductName.trim() || idosiProductId);
      const [saved] = existing
        ? await tx
            .update(idosiProductLinks)
            .set({ productId: product.id })
            .where(eq(idosiProductLinks.idosiProductId, idosiProductId))
            .returning()
        : await tx
            .insert(idosiProductLinks)
            .values({ idosiProductId, productId: product.id, firstSeenName })
            .returning();
      if (!saved) throw new Error('IDOSI product link was not saved.');
      await tx.insert(auditLogs).values({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        actorRole: 'admin',
        actorStoreId: null,
        action: existing ? 'IDOSI_PRODUCT_LINK_CHANGED' : 'IDOSI_PRODUCT_LINK_CREATED',
        entityType: 'idosi_product_link',
        entityId: null,
        before: existing ? { idosiProductId, productId: existing.productId } : null,
        after: { idosiProductId, productId: product.id, firstSeenName },
        metadata: { reason: input.reason },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return {
        idosiProductId,
        firstSeenName,
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        createdAt: saved.createdAt,
      };
    }),
  );
}

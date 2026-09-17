import { inArray } from 'drizzle-orm';

import type { Database } from './client.js';
import { productConversions, products, storeGroups, stores, warehouseBalances } from './schema.js';
import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from './seed-data.js';

/**
 * Installs reference rows that are missing from a fresh database.
 *
 * Every conflict is deliberately ignored. Production catalog and store rows
 * are user-managed after bootstrap, so a deploy must never rename, reactivate,
 * move, or otherwise reconcile an existing row back to the source defaults.
 * Corrections to existing production data belong in an explicit, reviewed
 * migration instead.
 */
export async function seedReferenceData(database: Database): Promise<void> {
  await database.transaction(async (tx) => {
    for (const group of STORE_GROUP_SEEDS) {
      await tx
        .insert(storeGroups)
        .values({
          code: group.code,
          name: group.name,
          displayOrder: group.displayOrder,
          isActive: true,
        })
        .onConflictDoNothing({ target: storeGroups.code });
    }

    const persistedGroups = await tx
      .select({ id: storeGroups.id, code: storeGroups.code })
      .from(storeGroups)
      .where(
        inArray(
          storeGroups.code,
          STORE_GROUP_SEEDS.map((group) => group.code),
        ),
      );
    const groupIdByCode = new Map(persistedGroups.map((group) => [group.code, group.id]));
    const groupKindByCode = new Map(
      STORE_GROUP_SEEDS.map((group) => [group.code, group.kind] as const),
    );

    for (const store of STORE_SEEDS) {
      const groupId = groupIdByCode.get(store.groupCode);
      if (!groupId) {
        throw new Error(`Seed store group "${store.groupCode}" was not persisted.`);
      }
      const kind = groupKindByCode.get(store.groupCode);
      if (!kind) {
        throw new Error(`Seed store group "${store.groupCode}" has no store kind.`);
      }

      await tx
        .insert(stores)
        .values({
          code: store.code,
          name: store.name,
          groupId,
          kind,
          displayOrder: store.displayOrder,
          isActive: true,
          deletedAt: null,
        })
        .onConflictDoNothing({ target: stores.code });
    }

    for (const product of PRODUCT_SEEDS) {
      await tx
        .insert(products)
        .values({
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          unit: product.unit,
          displayOrder: product.displayOrder,
          isActive: true,
          deletedAt: null,
        })
        .onConflictDoNothing({ target: products.sku });
    }

    const persistedProducts = await tx
      .select({ id: products.id, sku: products.sku })
      .from(products)
      .where(
        inArray(
          products.sku,
          PRODUCT_SEEDS.map((product) => product.sku),
        ),
      );
    const productIdBySku = new Map(
      persistedProducts.map((product) => [product.sku, product.id] as const),
    );

    for (const conversion of PRODUCT_CONVERSION_SEEDS) {
      const productId = productIdBySku.get(conversion.productSku);
      if (!productId) {
        throw new Error(`Seed product "${conversion.productSku}" was not persisted.`);
      }

      await tx
        .insert(productConversions)
        .values({
          productId,
          version: conversion.version,
          itemQuantity: conversion.itemQuantity,
          weightKilograms: conversion.weightKilograms,
          effectiveFrom: conversion.effectiveFrom,
          effectiveTo: conversion.effectiveTo,
          reason: conversion.reason,
        })
        .onConflictDoNothing({
          target: [productConversions.productId, productConversions.version],
        });
    }

    await tx
      .insert(warehouseBalances)
      .values(
        persistedProducts.map((product) => ({
          productId: product.id,
          onHandQuantity: 0,
          reservedQuantity: 0,
        })),
      )
      .onConflictDoNothing({ target: warehouseBalances.productId });
  });
}

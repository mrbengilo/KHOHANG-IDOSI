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

    // Một mặt hàng đã có bản quy đổi trong database là mặt hàng đã được quản trị:
    // bản gốc có thể đã retire và thay bằng version mới có kỳ hiệu lực khác.
    // Insert lại seed sẽ chồng lấn kỳ và bị trigger product_conversions_validate_period
    // chặn trước cả khi ON CONFLICT kịp bỏ qua, nên phải loại hẳn mặt hàng đó khỏi seed.
    const productIds = Array.from(productIdBySku.values());
    const existingConversions = productIds.length
      ? await tx
          .selectDistinct({ productId: productConversions.productId })
          .from(productConversions)
          .where(inArray(productConversions.productId, productIds))
      : [];
    const productsWithConversions = new Set(
      existingConversions.map((conversion) => conversion.productId),
    );

    for (const conversion of PRODUCT_CONVERSION_SEEDS) {
      const productId = productIdBySku.get(conversion.productSku);
      if (!productId) {
        throw new Error(`Seed product "${conversion.productSku}" was not persisted.`);
      }

      if (productsWithConversions.has(productId)) {
        continue;
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

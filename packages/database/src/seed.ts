import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { closeDatabase, db, type Database } from './client.js';
import { productConversions, products, storeGroups, stores, warehouseBalances } from './schema.js';
import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from './seed-data.js';

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
        .onConflictDoUpdate({
          target: storeGroups.code,
          set: {
            name: group.name,
            displayOrder: group.displayOrder,
            isActive: true,
            updatedAt: new Date(),
          },
        });
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

    const storeValues = STORE_SEEDS.map((store) => {
      const groupId = groupIdByCode.get(store.groupCode);
      if (!groupId) {
        throw new Error(`Seed store group "${store.groupCode}" was not persisted.`);
      }
      const kind = groupKindByCode.get(store.groupCode);
      if (!kind) {
        throw new Error(`Seed store group "${store.groupCode}" has no store kind.`);
      }

      return {
        code: store.code,
        name: store.name,
        groupId,
        kind,
        displayOrder: store.displayOrder,
        isActive: true,
        deletedAt: null,
      };
    });

    for (const store of storeValues) {
      await tx
        .insert(stores)
        .values(store)
        .onConflictDoUpdate({
          target: stores.code,
          set: {
            name: store.name,
            groupId: store.groupId,
            kind: store.kind,
            displayOrder: store.displayOrder,
            isActive: true,
            deletedAt: null,
            updatedAt: new Date(),
          },
          setWhere: sql`${stores.name} IS DISTINCT FROM ${store.name}
            OR ${stores.groupId} IS DISTINCT FROM ${store.groupId}
            OR ${stores.kind} IS DISTINCT FROM ${store.kind}
            OR ${stores.displayOrder} IS DISTINCT FROM ${store.displayOrder}
            OR ${stores.isActive} IS DISTINCT FROM TRUE
            OR ${stores.deletedAt} IS NOT NULL`,
        });
    }

    const [legacyMenswear] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, 'DO_NAM_CUA_HANG'))
      .limit(1);
    const [canonicalMenswear] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, 'DO_NAM'))
      .limit(1);
    if (legacyMenswear && canonicalMenswear) {
      throw new Error(
        'Both legacy DO_NAM_CUA_HANG and canonical DO_NAM exist; merge references before seeding.',
      );
    }
    if (legacyMenswear) {
      await tx
        .update(products)
        .set({
          sku: 'DO_NAM',
          slug: 'do-nam',
          name: 'Đồ nam',
          displayOrder: 12,
          version: sql`${products.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(products.id, legacyMenswear.id));
    }

    await tx
      .update(products)
      .set({
        isActive: false,
        deletedAt: sql`COALESCE(${products.deletedAt}, now())`,
        version: sql`${products.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(products.sku, ['THAP_CAM_TON', 'HANG_JEANS_TAI_CHE', 'HANG_THUN_TAI_CHE']),
          or(eq(products.isActive, true), isNull(products.deletedAt)),
        ),
      );

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
        .onConflictDoUpdate({
          target: products.sku,
          set: {
            slug: product.slug,
            name: product.name,
            unit: product.unit,
            displayOrder: product.displayOrder,
            isActive: true,
            deletedAt: null,
            updatedAt: new Date(),
          },
          setWhere: sql`${products.slug} IS DISTINCT FROM ${product.slug}
            OR ${products.name} IS DISTINCT FROM ${product.name}
            OR ${products.unit} IS DISTINCT FROM ${product.unit}
            OR ${products.displayOrder} IS DISTINCT FROM ${product.displayOrder}
            OR ${products.isActive} IS DISTINCT FROM TRUE
            OR ${products.deletedAt} IS NOT NULL`,
        });
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

try {
  await seedReferenceData(db);
  console.info(
    `Seeded ${STORE_GROUP_SEEDS.length} store groups, ${STORE_SEEDS.length} stores, ${PRODUCT_SEEDS.length} products, and ${PRODUCT_CONVERSION_SEEDS.length} product conversions.`,
  );
} catch (error: unknown) {
  console.error('Database seed failed.', error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

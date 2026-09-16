import { inArray } from 'drizzle-orm';

import { closeDatabase, db, type Database } from './client.js';
import { products, storeGroups, stores, warehouseBalances } from './schema.js';
import { PRODUCT_SEEDS, STORE_GROUP_SEEDS, STORE_SEEDS } from './seed-data.js';

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

    const storeValues = STORE_SEEDS.map((store) => {
      const groupId = groupIdByCode.get(store.groupCode);
      if (!groupId) {
        throw new Error(`Seed store group "${store.groupCode}" was not persisted.`);
      }

      return {
        code: store.code,
        name: store.name,
        groupId,
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
            displayOrder: store.displayOrder,
            isActive: true,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });
    }

    for (const product of PRODUCT_SEEDS) {
      await tx
        .insert(products)
        .values({
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          unit: 'item',
          displayOrder: product.displayOrder,
          isActive: true,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: products.sku,
          set: {
            slug: product.slug,
            name: product.name,
            displayOrder: product.displayOrder,
            isActive: true,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });
    }

    const persistedProducts = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        inArray(
          products.sku,
          PRODUCT_SEEDS.map((product) => product.sku),
        ),
      );

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
    `Seeded ${STORE_GROUP_SEEDS.length} store groups, ${STORE_SEEDS.length} stores, and ${PRODUCT_SEEDS.length} products.`,
  );
} catch (error: unknown) {
  console.error('Database seed failed.', error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

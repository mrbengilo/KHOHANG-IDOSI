import { describe, expect, it } from 'vitest';

import type { Database } from '../src/client.js';
import { seedReferenceData } from '../src/reference-seed.js';
import {
  productConversions,
  products,
  storeGroups,
  stores,
  warehouseBalances,
} from '../src/schema.js';
import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from '../src/seed-data.js';

interface RecordedInsert {
  readonly table: unknown;
  readonly values: unknown;
  readonly conflictTarget: unknown;
}

describe('production reference bootstrap', () => {
  it('uses insert-only conflict handling for every reference and balance row', async () => {
    const inserts: RecordedInsert[] = [];
    const database = recordingDatabase(inserts);

    await seedReferenceData(database);

    expect(inserts).toHaveLength(
      STORE_GROUP_SEEDS.length +
        STORE_SEEDS.length +
        PRODUCT_SEEDS.length +
        PRODUCT_CONVERSION_SEEDS.length +
        1,
    );
    expect(inserts.filter(({ table }) => table === storeGroups)).toHaveLength(
      STORE_GROUP_SEEDS.length,
    );
    expect(inserts.filter(({ table }) => table === stores)).toHaveLength(STORE_SEEDS.length);
    expect(inserts.filter(({ table }) => table === products)).toHaveLength(PRODUCT_SEEDS.length);
    expect(inserts.filter(({ table }) => table === productConversions)).toHaveLength(
      PRODUCT_CONVERSION_SEEDS.length,
    );
    expect(inserts.filter(({ table }) => table === warehouseBalances)).toHaveLength(1);

    expect(
      inserts.every(
        ({ conflictTarget }) => conflictTarget !== null && conflictTarget !== undefined,
      ),
    ).toBe(true);
    expect(inserts.find(({ table }) => table === storeGroups)?.conflictTarget).toBe(
      storeGroups.code,
    );
    expect(inserts.find(({ table }) => table === stores)?.conflictTarget).toBe(stores.code);
    expect(inserts.find(({ table }) => table === products)?.conflictTarget).toBe(products.sku);
    expect(inserts.find(({ table }) => table === warehouseBalances)?.conflictTarget).toBe(
      warehouseBalances.productId,
    );
  });

  it('skips conversion seeds for products that already carry an administered conversion', async () => {
    const administeredSku = PRODUCT_CONVERSION_SEEDS[0]!.productSku;
    const skipped = PRODUCT_CONVERSION_SEEDS.filter(
      (conversion) => conversion.productSku === administeredSku,
    ).length;
    const inserts: RecordedInsert[] = [];
    const database = recordingDatabase(inserts, [`product-${administeredSku}`]);

    await seedReferenceData(database);

    expect(skipped).toBeGreaterThan(0);
    expect(inserts.filter(({ table }) => table === productConversions)).toHaveLength(
      PRODUCT_CONVERSION_SEEDS.length - skipped,
    );
    expect(
      inserts
        .filter(({ table }) => table === productConversions)
        .some(
          ({ values }) =>
            (values as { productId: string }).productId === `product-${administeredSku}`,
        ),
    ).toBe(false);
    expect(inserts.filter(({ table }) => table === products)).toHaveLength(PRODUCT_SEEDS.length);
  });
});

function recordingDatabase(
  inserts: RecordedInsert[],
  productIdsWithConversions: readonly string[] = [],
): Database {
  const transaction = {
    selectDistinct() {
      return {
        from(table: unknown) {
          return {
            async where() {
              if (table === productConversions) {
                return productIdsWithConversions.map((productId) => ({ productId }));
              }
              throw new Error('Unexpected reference seed selectDistinct');
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          return {
            async onConflictDoNothing(options: { readonly target: unknown }) {
              inserts.push({ table, values, conflictTarget: options.target });
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            async where() {
              if (table === storeGroups) {
                return STORE_GROUP_SEEDS.map((group) => ({
                  id: `group-${group.code}`,
                  code: group.code,
                }));
              }
              if (table === products) {
                return PRODUCT_SEEDS.map((product) => ({
                  id: `product-${product.sku}`,
                  sku: product.sku,
                }));
              }
              throw new Error('Unexpected reference seed select');
            },
          };
        },
      };
    },
  };

  return {
    async transaction(callback: (tx: typeof transaction) => Promise<void>) {
      await callback(transaction);
    },
  } as unknown as Database;
}

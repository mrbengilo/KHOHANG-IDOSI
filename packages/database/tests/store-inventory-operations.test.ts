import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  buildStoreInventoryBagPageQueries,
  createStoreOutbound,
  openStoreInventoryBag,
} from '../src/store-inventory-operations.js';
import * as schema from '../src/schema.js';

const IDS = {
  actor: '11111111-1111-4111-8111-111111111111',
  bag: '22222222-2222-4222-8222-222222222222',
  product: '33333333-3333-4333-8333-333333333333',
  store: '44444444-4444-4444-8444-444444444444',
};

describe('store inventory operations', () => {
  it('builds a paginated bag projection with lineage and server-approved filters', () => {
    const database = drizzle.mock({ schema });
    const queries = buildStoreInventoryBagPageQueries(database, {
      page: 2,
      pageSize: 25,
      storeId: IDS.store,
      productId: IDS.product,
      status: 'opened',
      bagCode: 'GV-DAM',
    });
    const total = queries.total.toSQL();
    const rows = queries.rows.toSQL();
    for (const sql of [total.sql, rows.sql]) {
      expect(sql).toContain('inner join "outbound_request_lines"');
      expect(sql).toContain('"store_inventory_bags"."store_id"');
      expect(sql).toContain('"store_inventory_bags"."product_id"');
      expect(sql).toContain('"store_inventory_bags"."status"');
      expect(sql).toContain('"store_inventory_bags"."bag_code" ilike');
    }
    expect(rows.sql).toContain(
      'order by "store_inventory_bags"."received_at" desc, "store_inventory_bags"."bag_code" asc',
    );
    expect(queries.pagination).toEqual({ page: 2, pageSize: 25 });
  });

  it('rejects malformed mutation identity and non-positive stock removals before I/O', async () => {
    const database = drizzle.mock({ schema });
    await expect(
      openStoreInventoryBag(database, {
        bagId: IDS.bag,
        storeId: '',
        expectedVersion: 0,
        actorUserId: IDS.actor,
        idempotencyKey: 'open-1',
        requestHash: 'hash-1',
      }),
    ).rejects.toThrow('identifiers are required');

    await expect(
      createStoreOutbound(database, {
        storeId: IDS.store,
        inventoryBagId: IDS.bag,
        expectedInventoryVersion: 0,
        weightKg: '0',
        reason: 'discount_sale',
        revenueVnd: 0n,
        createdByUserId: IDS.actor,
        idempotencyKey: 'outbound-1',
        requestHash: 'hash-2',
      }),
    ).rejects.toThrow('weight must be positive');
  });

  it('rejects invalid page bounds before constructing a query', () => {
    const database = drizzle.mock({ schema });
    expect(() => buildStoreInventoryBagPageQueries(database, { page: 0 })).toThrow(RangeError);
    expect(() => buildStoreInventoryBagPageQueries(database, { pageSize: 101 })).toThrow(
      RangeError,
    );
  });
});

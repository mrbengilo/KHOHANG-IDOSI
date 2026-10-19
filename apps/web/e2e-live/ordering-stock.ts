import { randomUUID } from 'node:crypto';
import { applyWarehouseMovement, createDatabase, products } from '@idosi/database';

export interface OrderableProduct {
  readonly id: string;
  readonly name: string;
}

export const OUT_OF_STOCK_NOTE = 'Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.';

/**
 * Inserts an active product holding `bags` free central-warehouse bags (opening balance).
 * Orders need stock in the central warehouse, so ordering flows pick these by name instead of
 * whichever shared catalog product happens to be first. Written straight to the database like the
 * other live fixtures, so the reset rehearsal over the accumulated fixture sees no new audit kinds.
 */
export async function createProductWithStock(
  name: string,
  bags: number,
): Promise<OrderableProduct> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Ordering fixtures require DATABASE_URL.');
  const client = createDatabase({ connectionString, max: 1 });
  try {
    const token = randomUUID().replaceAll('-', '').slice(0, 12);
    const [product] = await client.db
      .insert(products)
      .values({ sku: `E2E-ORD-${token}`, slug: `e2e-ord-${token}`, name })
      .returning({ id: products.id, name: products.name });
    if (bags > 0)
      await client.db.transaction((tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'opening_balance',
          onHandDelta: bags,
          reservedDelta: 0,
          sourceType: 'live_e2e_opening',
          sourceId: randomUUID(),
          reason: 'Live ordering workflow stock',
          occurredAt: new Date(),
        }),
      );
    return product!;
  } finally {
    await client.close();
  }
}

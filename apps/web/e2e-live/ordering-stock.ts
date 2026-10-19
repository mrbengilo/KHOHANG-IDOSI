import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

interface ApiClient {
  get(url: string, options?: Parameters<APIRequestContext['get']>[1]): Promise<APIResponse>;
  post(url: string, options?: Parameters<APIRequestContext['post']>[1]): Promise<APIResponse>;
}

export interface OrderableProduct {
  readonly id: string;
  readonly name: string;
}

/**
 * Creates an active product holding `bags` free central-warehouse bags, through an Admin session.
 * Orders need stock in the central warehouse, so ordering flows pick these by name instead of
 * whichever shared catalog product happens to be first.
 */
export async function createProductWithStock(
  api: ApiClient,
  apiBase: string,
  name: string,
  bags: number,
): Promise<OrderableProduct> {
  const created = await api.post(`${apiBase}/products`, {
    data: {
      sku: `E2E-ORD-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      name,
      measurement: 'UNIT',
      unitLabel: 'bao',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const product = (await created.json()).data as OrderableProduct;
  if (bags > 0) {
    const inventory = await api.get(
      `${apiBase}/warehouse-inventory?projection=waiting-demand-v2&productId=${product.id}`,
    );
    expect(inventory.status()).toBe(200);
    const [row] = (await inventory.json()).data as { balanceVersion: number }[];
    const adjusted = await api.post(`${apiBase}/warehouse-adjustments`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        productId: product.id,
        direction: 'INCREASE',
        quantity: bags,
        reasonCode: 'COUNT_CORRECTION',
        reason: 'Tồn kho tổng cho kiểm thử đặt hàng',
        expectedVersion: row!.balanceVersion,
      },
    });
    expect(adjusted.status(), await adjusted.text()).toBe(201);
  }
  return { id: product.id, name: product.name };
}

export const OUT_OF_STOCK_NOTE = 'Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.';

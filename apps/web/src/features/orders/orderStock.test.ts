import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWarehouseAvailableBags, loadWarehouseAvailableBags } from '../../lib/api';
import { checkOrderStock, isOutOfStock, OUT_OF_STOCK_NOTE } from './orderStock';

const productId = '40000000-0000-4000-8000-000000000001';

function inventoryRow(availableBags: number) {
  return {
    productId,
    productName: 'Quần jean',
    sku: 'JEANS',
    onHandBags: availableBags + 2,
    reservedBags: 2,
    waitTicketHoldBags: 0,
    waitingDemandBags: 0,
    sharedDeliveryHoldBags: 2,
    availableBags,
    dispatchedBags: 0,
    balanceVersion: 3,
    productActive: true,
    reshareReconciled: false,
  };
}

describe('order stock check when a product is picked', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lets a product with central-warehouse stock be ordered without notice', async () => {
    await expect(checkOrderStock(productId, 'Quần jean', async () => 1)).resolves.toEqual({
      kind: 'available',
    });
  });

  it('blocks a product whose central-warehouse stock is zero with the out-of-stock note', async () => {
    const check = await checkOrderStock(productId, 'Quần jean', async () => 0);
    expect(check).toEqual({ kind: 'out-of-stock', message: OUT_OF_STOCK_NOTE });
    expect(OUT_OF_STOCK_NOTE).toBe('Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.');
  });

  it('greys out products at zero or missing from the stock list, never before it loads', () => {
    const stock = new Map([
      ['in-stock', 3],
      ['empty', 0],
    ]);
    expect(isOutOfStock(stock, 'in-stock')).toBe(false);
    expect(isOutOfStock(stock, 'empty')).toBe(true);
    expect(isOutOfStock(stock, 'missing')).toBe(true);
    expect(isOutOfStock(undefined, 'empty')).toBe(false);
  });

  it('does not pick the product when the stock read fails', async () => {
    const check = await checkOrderStock(productId, 'Quần jean', async () => {
      throw new Error('offline');
    });
    expect(check.kind).toBe('error');
  });

  it('reads one product row of the central warehouse, missing rows counting as zero', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [inventoryRow(4)],
            pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [],
            pagination: { page: 1, pageSize: 1, totalItems: 0, totalPages: 0 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(loadWarehouseAvailableBags(productId)).resolves.toBe(4);
    await expect(loadWarehouseAvailableBags(productId)).resolves.toBe(0);
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain('/warehouse-inventory?');
    expect(url).toContain(`productId=${productId}`);
    expect(url).toContain('projection=waiting-demand-v2');
  });

  it('reads every product of the central warehouse into an availability map', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [inventoryRow(0)],
          pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const stock = await listWarehouseAvailableBags();
    expect(stock.get(productId)).toBe(0);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('projection=waiting-demand-v2');
  });
});

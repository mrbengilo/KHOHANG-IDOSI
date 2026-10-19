import { loadWarehouseAvailableBags } from '../../lib/api';

export type OrderStockCheck =
  | { readonly kind: 'available' }
  | { readonly kind: 'out-of-stock' | 'error'; readonly message: string };

/** Note shown under a product the central warehouse has run out of. */
export const OUT_OF_STOCK_NOTE = 'Kho tổng đã hết hàng (tồn = 0), chưa thể đặt.';

/** A product is orderable only while the central warehouse has free bags; unknown counts as 0. */
export function isOutOfStock(
  availableBags: ReadonlyMap<string, number> | undefined,
  productId: string,
): boolean {
  return availableBags !== undefined && (availableBags.get(productId) ?? 0) <= 0;
}

/**
 * Picking a product re-reads its central-warehouse stock, since the list loaded with the page may
 * be stale: zero free stock refuses the pick, any positive stock is ordered without notice. The
 * server repeats the check at submission, so a failed read only blocks this pick.
 */
export async function checkOrderStock(
  productId: string,
  productName: string,
  loadAvailableBags: (productId: string) => Promise<number> = loadWarehouseAvailableBags,
): Promise<OrderStockCheck> {
  try {
    return (await loadAvailableBags(productId)) > 0
      ? { kind: 'available' }
      : { kind: 'out-of-stock', message: OUT_OF_STOCK_NOTE };
  } catch {
    return {
      kind: 'error',
      message: `Không kiểm tra được tồn kho tổng của ${productName}. Bấm chọn lại để thử lại.`,
    };
  }
}

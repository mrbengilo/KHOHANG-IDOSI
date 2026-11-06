import { loadSupplierMappedProductIds } from './supplier-commitments.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';
import { flagSupplierProductForReconciliation } from './warehouse.js';

/** Only affected source SKUs are blocked; no stock is added, released or deducted here. */
export async function flagReceiptSourceDiscrepancies(
  tx: Transaction,
  receiptCode: string,
  lines: readonly {
    readonly productId: string;
    readonly approvedQuantity: number;
    readonly receivedQuantity: number;
  }[],
  unexpected: readonly { readonly productId: string; readonly quantity: number }[],
): Promise<void> {
  const reasons = new Map<string, string>();
  const wrongProduct =
    unexpected.some((item) => !lines.some((line) => line.productId === item.productId)) &&
    lines.some((line) => line.receivedQuantity < line.approvedQuantity);
  for (const line of lines) {
    const shortage = line.approvedQuantity - line.receivedQuantity;
    if (shortage > 0)
      reasons.set(
        line.productId,
        `${receiptCode}: ${wrongProduct ? 'nhận sai mặt hàng, ' : ''}nhận thiếu ${shortage} bao. Cần đối chiếu lại tồn Reshare.`,
      );
  }
  for (const item of unexpected) {
    reasons.set(
      item.productId,
      `${receiptCode}: ${wrongProduct ? 'nhận sai mặt hàng, ' : ''}nhận dư ${item.quantity} bao ngoài phiếu. Cần đối chiếu lại tồn Reshare.`,
    );
  }
  if (!reasons.size) return;
  const mapped = await loadSupplierMappedProductIds(tx, [...reasons.keys()]);
  for (const productId of [...mapped].sort()) {
    await withAdvisoryLock(tx, 'warehouse-balance', productId, () =>
      flagSupplierProductForReconciliation(tx, productId, reasons.get(productId)!),
    );
  }
}

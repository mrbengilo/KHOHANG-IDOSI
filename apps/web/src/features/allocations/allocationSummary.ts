import type { SessionDocument } from '@idosi/contracts';

export interface SummaryItem {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
}

export interface AllocationSummary {
  readonly granted: readonly SummaryItem[];
  readonly waiting: readonly SummaryItem[];
  readonly carried: readonly SummaryItem[];
  readonly grantedTotal: number;
  readonly waitingTotal: number;
}

function items(
  entries: Iterable<readonly [string, number]>,
  productName: (productId: string) => string,
): SummaryItem[] {
  return [...entries]
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, quantity]) => ({ productId, name: productName(productId), quantity }));
}

/**
 * What one store got in one session and what it still waits for, item by item. "Waiting" is the
 * part of this session's demand that was not granted and moved to the store's wait document.
 */
export function summarizeAllocation(
  document: Pick<SessionDocument, 'lines' | 'carriedAllocations'>,
  productName: (productId: string) => string,
): AllocationSummary {
  const granted = items(
    document.lines.map((line) => [line.productId, line.allocatedQuantity] as const),
    productName,
  );
  const waiting = items(
    document.lines.map((line) => [line.productId, line.waitlistedQuantity] as const),
    productName,
  );
  const carriedByProduct = new Map<string, number>();
  for (const line of document.carriedAllocations)
    carriedByProduct.set(
      line.productId,
      (carriedByProduct.get(line.productId) ?? 0) + line.quantity,
    );
  return {
    granted,
    waiting,
    carried: items(carriedByProduct, productName),
    grantedTotal: granted.reduce((sum, item) => sum + item.quantity, 0),
    waitingTotal: waiting.reduce((sum, item) => sum + item.quantity, 0),
  };
}

/** "2 Nam, 2 Nữ, 2 Đầm" — the wording stores use when they talk about a result. */
export function summaryText(list: readonly SummaryItem[], empty: string): string {
  return list.length === 0 ? empty : list.map((item) => `${item.quantity} ${item.name}`).join(', ');
}

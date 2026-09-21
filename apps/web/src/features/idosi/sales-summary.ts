import type { IdosiStatisticsState } from '@idosi/contracts';

/** Snapshot replacement is handled by the server; never add successive syncs. */
export function summarizeIdosiSales(states: readonly IdosiStatisticsState[]) {
  const snapshots = states.flatMap((state) => (state.snapshot ? [state.snapshot] : []));
  const products = snapshots.flatMap((snapshot) =>
    snapshot.payload.products.items.map((item) => ({
      ...item,
      storeId: snapshot.storeId,
      storeName: snapshot.payload.store.name,
    })),
  );
  const missingStores = states.length - snapshots.length;
  const incompleteWeight = snapshots.some(
    (snapshot) => !snapshot.payload.products.weight.isComplete,
  );
  // Group by the source identity, never by mutable product names or sale type.
  const byProduct = new Map<
    string,
    {
      productId: string;
      productName: string;
      productCode: string | null | undefined;
      pieces: number;
      knownKg: number;
      isComplete: boolean;
    }
  >();
  for (const item of products) {
    const total = byProduct.get(item.productId) ?? {
      productId: item.productId,
      productName: item.productName,
      productCode: item.productCode,
      pieces: 0,
      knownKg: 0,
      isComplete: true,
    };
    total.pieces += item.unit === 'PIECE' ? item.quantity : 0;
    total.knownKg += item.weight.knownKg;
    total.isComplete = total.isComplete && item.weight.isComplete;
    byProduct.set(item.productId, total);
  }
  return {
    snapshots,
    products,
    productTotals: [...byProduct.values()].sort((a, b) =>
      a.productName.localeCompare(b.productName, 'vi'),
    ),
    missingStores,
    incompleteWeight,
    revenueVnd: snapshots.reduce(
      (sum, snapshot) => sum + BigInt(snapshot.payload.totals.revenue),
      0n,
    ),
    pieces: products.reduce((sum, item) => sum + (item.unit === 'PIECE' ? item.quantity : 0), 0),
    actualKg: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.payload.products.weight.actualKg,
      0,
    ),
    estimatedKg: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.payload.products.weight.estimatedKg,
      0,
    ),
    knownKg: snapshots.reduce((sum, snapshot) => sum + snapshot.payload.products.weight.knownKg, 0),
    unclassifiedOrders: snapshots.reduce(
      (sum, snapshot) => sum + snapshot.payload.products.unclassifiedOrders,
      0,
    ),
    staleStores: states.filter((state) => state.freshness === 'STALE').length,
  };
}

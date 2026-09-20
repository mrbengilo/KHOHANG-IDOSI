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
  return {
    snapshots,
    products,
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

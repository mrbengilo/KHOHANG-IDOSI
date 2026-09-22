import type { IdosiStatisticsState } from '@idosi/contracts';

/**
 * IDOSI renames and retires products, and a retired code can later be handed to a
 * different product. A line's `productId` is therefore the identity it was SOLD
 * with, not a stable one, so grouping on it splits a renamed product into several
 * rows and can merge two unrelated ones. `canonicalProductId` is the entry IDOSI
 * uses today and is the only safe aggregation key; fall back to `productId` only
 * for snapshots taken before IDOSI started sending it.
 */
const productIdentity = (item: { canonicalProductId?: string | undefined; productId: string }) =>
  item.canonicalProductId?.trim() || item.productId;

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
  // Group by the identity IDOSI uses today, never by mutable product names or sale type.
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
  // A source id seen under several names means IDOSI reused it for another product
  // and the snapshot predates canonical identities; totals for it cannot be trusted.
  const namesBySourceId = new Map<string, Set<string>>();
  for (const item of products) {
    const identity = productIdentity(item);
    const names = namesBySourceId.get(item.productId) ?? new Set<string>();
    names.add(item.productName);
    namesBySourceId.set(item.productId, names);
    const total = byProduct.get(identity) ?? {
      productId: identity,
      productName: item.productName,
      productCode: item.canonicalProductCode ?? item.productCode,
      pieces: 0,
      knownKg: 0,
      isComplete: true,
    };
    total.pieces += item.unit === 'PIECE' ? item.quantity : 0;
    total.knownKg += item.weight.knownKg;
    total.isComplete = total.isComplete && item.weight.isComplete;
    byProduct.set(identity, total);
  }
  return {
    snapshots,
    products,
    productTotals: [...byProduct.values()].sort((a, b) =>
      a.productName.localeCompare(b.productName, 'vi'),
    ),
    missingStores,
    incompleteWeight,
    ambiguousProducts: [...namesBySourceId.values()].filter((names) => names.size > 1).length,
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

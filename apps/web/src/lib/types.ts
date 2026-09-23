export type Role = 'ADMIN' | 'HTKD' | 'STORE' | 'WHOLESALE';
export type StoreKind = 'RETAIL' | 'WHOLESALE';
export type DemoMode = 'ADMIN' | 'HTKD' | 'STORE_RETAIL' | 'STORE_WHOLESALE';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'priority';

export interface ProductConversion {
  id: string;
  sku?: string;
  name: string;
  /** Exact ratio: itemQuantity items weigh weightKilograms kilograms. */
  itemQuantity: number | null;
  weightKilograms: string | null;
  conversionId?: string;
  conversionVersion?: number;
  conversionMissing?: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  effectiveDate: string;
}

export interface StoreHealth {
  code: string;
  name: string;
  type: 'RETAIL' | 'WHOLESALE';
  unopenedBags: number;
  unopenedKg: number;
  sellingBags: number;
  sellingKg: number;
  pendingSortKg: number;
  revenueVnd: number | null;
  health: 'STABLE' | 'WATCH' | 'RISK';
}

export interface AllocationRequest {
  id: string;
  storeCode: string;
  storeName: string;
  product: string;
  requestedBags: number;
  allocatedBags: number;
  waitlistedBags: number;
  priority: 'P0A' | 'P0B' | 'P1' | 'P2' | 'P3';
  status: 'WAITING' | 'OFFERED' | 'ALLOCATED' | 'DECLINED';
  submittedAt: string;
}

export interface LedgerRow {
  id: string;
  at: string;
  document: string;
  product: string;
  movement: string;
  bagsDelta: number;
  kgDelta: number;
  balanceKg: number;
}

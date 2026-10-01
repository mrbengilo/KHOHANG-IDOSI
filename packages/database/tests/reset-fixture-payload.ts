import { randomUUID } from 'node:crypto';
import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';

export function resetFixturePayload(
  product: { id: string; name: string },
  kg: number,
  at: Date,
  type: 'NORMAL' | 'SALE_KG' | 'SALE_PIECE' = 'NORMAL',
  complete = true,
) {
  const bucket = {
    actualKg: 0,
    estimatedKg: 0,
    knownKg: 0,
    totalKg: 0,
    isComplete: true,
    missingFactorLines: 0,
    invalidLines: 0,
    unclassifiedOrders: 0,
  };
  const weight = {
    ...bucket,
    schemaVersion: 1,
    unit: 'KG' as const,
    tableVersion: 'reset-fixture',
    byRevenueType: { NORMAL: bucket, SALE_KG: bucket, SALE_PIECE: bucket },
  };
  const itemWeight = {
    ...weight,
    actualKg: type === 'SALE_KG' ? kg : 0,
    estimatedKg: type !== 'SALE_KG' ? kg : 0,
    knownKg: kg,
    totalKg: kg,
    isComplete: complete,
  };
  const period = new Date(at.getTime() + 7 * 3600000).toISOString().slice(0, 7);
  return IdosiOrderStatisticsPayloadSchema.parse({
    ok: true,
    apiVersion: 1,
    storeId: 'RESET_FIXTURE',
    store: { id: 'RESET_FIXTURE', name: 'Fixture' },
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
    revenueBasis: 'ACTIVE_ORDER_AMOUNT',
    generatedAt: at.toISOString(),
    serverTime: at.toISOString(),
    requestId: randomUUID(),
    filters: { period, date: null, shiftId: null, paymentMethod: null },
    totals: {
      orders: 1,
      cash: 0,
      transfer: 0,
      revenue: 0,
      cashOrders: 0,
      transferOrders: 0,
      revenueByType: { NORMAL: 0, SALE_KG: 0, SALE_PIECE: 0 },
      unclassifiedRevenue: 0,
      unclassifiedOrders: 0,
      weight,
    },
    products: {
      totalQuantity: 1,
      salePieceQuantity: type === 'SALE_PIECE' ? kg : 0,
      totalWeightKg: kg,
      productTypes: 1,
      ordersWithItems: 1,
      unclassifiedOrders: 0,
      items: [
        {
          productId: product.id,
          productName: product.name,
          quantity: kg,
          unit: type === 'SALE_KG' ? 'KG' : 'PIECE',
          revenueType: type,
          classification: type,
          orders: 1,
          weight: itemWeight,
        },
      ],
      weight,
      weightByProduct: [],
    },
    groups: { shift: [], day: [], month: [] },
  });
}

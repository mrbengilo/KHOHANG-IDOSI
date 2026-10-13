import { describe, expect, it } from 'vitest';

import {
  AllocationDecisionSchema,
  ListAllocationDecisionsQuerySchema,
  ListReshareOrdersQuerySchema,
  ListReshareOrdersResponseSchema,
  ReshareOrderSummarySchema,
  SupplierObservationRequestSchema,
  SupplierPositionSchema,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('RE order contracts', () => {
  it('accepts only six-digit RE codes', () => {
    const base = {
      id: id(1),
      status: 'ORDERED',
      orderedAt: '2026-10-13T09:15:00+07:00',
      totalQuantity: 5,
    };
    expect(ReshareOrderSummarySchema.parse({ ...base, code: 'RE-000001' }).code).toBe('RE-000001');
    expect(() => ReshareOrderSummarySchema.parse({ ...base, code: 'RE-0000001' })).toThrow();
    expect(() => ReshareOrderSummarySchema.parse({ ...base, code: 'PXK-000001' })).toThrow();
    expect(() =>
      ReshareOrderSummarySchema.parse({ ...base, code: 'RE-000001', totalQuantity: 0 }),
    ).toThrow();
  });

  it('parses history filters strictly and normalizes the code search', () => {
    const query = ListReshareOrdersQuerySchema.parse({
      page: '1',
      pageSize: '20',
      status: 'NOT_ORDERED',
      code: ' re-0001 ',
      from: '2026-10-01T00:00:00+07:00',
      to: '2026-10-14T00:00:00+07:00',
    });
    expect(query).toMatchObject({ status: 'NOT_ORDERED', code: 'RE-0001' });
    expect(() => ListReshareOrdersQuerySchema.parse({ storeCode: 'DS01' })).toThrow();
    expect(() =>
      ListReshareOrdersQuerySchema.parse({
        from: '2026-10-14T00:00:00+07:00',
        to: '2026-10-01T00:00:00+07:00',
      }),
    ).toThrow();
  });

  it('keeps one total per order in the history row', () => {
    const response = ListReshareOrdersResponseSchema.parse({
      data: [
        {
          decisionId: id(2),
          decisionStatus: 'ACCEPTED',
          sessionId: id(3),
          sessionCode: 'PDH-000010',
          businessDate: '2026-10-13',
          runVersion: 1,
          sessionOpenedAt: '2026-10-13T00:00:00+07:00',
          allocationCompletedAt: '2026-10-13T09:00:05+07:00',
          publishedAt: '2026-10-13T09:00:05+07:00',
          acceptedAt: '2026-10-13T09:20:00+07:00',
          acceptedByName: 'Cửa hàng A',
          storeId: id(4),
          storeName: 'Cửa hàng A',
          status: 'ORDERED',
          order: {
            id: id(5),
            code: 'RE-000001',
            orderedAt: '2026-10-13T09:20:00+07:00',
            origin: 'ACCEPTANCE',
            actorName: 'Cửa hàng A',
            actorRole: 'STORE',
            cancelledAt: null,
            cancelReason: null,
          },
          lines: [
            { productId: id(6), productName: 'Quần dài nữ', productSku: 'QDN', quantity: 2 },
            { productId: id(7), productName: 'Áo', productSku: 'AO', quantity: 3 },
          ],
          totalQuantity: 5,
          delivery: {
            issuedQuantity: 5,
            receivedQuantity: 0,
            shortageQuantity: 0,
            awaitingReceiptQuantity: 5,
            onShipmentQuantity: 5,
          },
        },
      ],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      scoped: true,
    });
    expect(response.data[0]!.totalQuantity).toBe(5);
  });

  it('adds the RE fields to decisions and positions only as optional keys (old bundles keep parsing)', () => {
    expect(
      ListAllocationDecisionsQuerySchema.parse({ includeReshare: 'true' }).includeReshare,
    ).toBe(true);
    expect(AllocationDecisionSchema.shape.allowedActions.isOptional()).toBe(true);
    expect(AllocationDecisionSchema.shape.reshareOrder.isOptional()).toBe(true);
    expect(SupplierPositionSchema.shape.issuedUnreflectedQuantity.isOptional()).toBe(true);
    const request = SupplierObservationRequestSchema.parse({
      sourceId: id(1),
      observedAt: '2026-10-13T10:00:00+07:00',
      lines: [{ productId: id(2), observedQuantity: 6 }],
      reshareCoverage: [{ reshareOrderLineId: id(3), quantity: 4 }],
    });
    expect(request.reshareCoverage).toEqual([{ reshareOrderLineId: id(3), quantity: 4 }]);
    expect(() =>
      SupplierObservationRequestSchema.parse({
        sourceId: id(1),
        observedAt: '2026-10-13T10:00:00+07:00',
        lines: [{ productId: id(2), observedQuantity: 6 }],
        reshareCoverage: [{ reshareOrderLineId: id(3), quantity: 0 }],
      }),
    ).toThrow();
  });
});

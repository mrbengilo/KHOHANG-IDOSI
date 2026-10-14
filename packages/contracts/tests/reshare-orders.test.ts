import { describe, expect, it } from 'vitest';

import {
  AllocationDecisionSchema,
  ListAllocationDecisionsQuerySchema,
  ListReshareOrdersQuerySchema,
  ListReshareOrdersResponseSchema,
  ListReshareStoresResponseSchema,
  ReshareOrderSummarySchema,
  ReshareStatusControlSchema,
  ReshareStatusHistoryQuerySchema,
  ReshareStatusHistoryResponseSchema,
  UpdateReshareOrderStatusRequestSchema,
  SupplierObservationRequestSchema,
  SupplierPositionSchema,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('RE order contracts', () => {
  it('requires a version and previous status, allows only both acknowledgement states', () => {
    const input = { status: 'ORDERED', expectedStatus: 'NOT_ORDERED', expectedVersion: 0 };
    expect(UpdateReshareOrderStatusRequestSchema.parse(input)).toEqual(input);
    for (const bad of [
      { ...input, status: 'CANCELLED' },
      { ...input, expectedVersion: -1 },
      { ...input, expectedVersion: undefined },
      { ...input, expectedStatus: undefined },
      { ...input, quantity: 99 },
    ])
      expect(UpdateReshareOrderStatusRequestSchema.safeParse(bad).success).toBe(false);
  });
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

  it('keeps the status actor opt-in so older strict bundles keep parsing', () => {
    expect(ReshareStatusControlSchema.shape.updatedByRole.isOptional()).toBe(true);
    expect(
      ListReshareOrdersQuerySchema.parse({ includeStatusActor: 'true' }).includeStatusActor,
    ).toBe(true);
    expect(
      ReshareStatusControlSchema.parse({
        version: 1,
        updatedAt: '2026-10-13T03:00:00.000Z',
        updatedByName: 'HTKD',
        updatedByRole: 'HTKD',
      }).updatedByRole,
    ).toBe('HTKD');
  });

  it('validates the status history page strictly, including legacy nulls', () => {
    const event = {
      id: id(1),
      occurredAt: '2026-10-13T03:00:00.000Z',
      kind: 'STATUS_CHANGED',
      source: 'MANUAL',
      statusBefore: 'NOT_ORDERED',
      statusAfter: 'ORDERED',
      version: 1,
      orderCode: null,
      actor: { accountId: id(2), role: 'HTKD', nameAtEvent: 'HTKD A', currentName: null },
      requestId: 'req-1',
    };
    const legacy = {
      ...event,
      id: id(3),
      kind: 'CREATED',
      source: 'ACCEPTANCE',
      statusBefore: null,
      version: null,
      orderCode: 'RE-000001',
      actor: { accountId: id(4), role: 'STORE', nameAtEvent: null, currentName: 'Cửa hàng A' },
    };
    const page = {
      data: [event, legacy],
      pagination: { page: 1, pageSize: 10, totalItems: 2, totalPages: 1 },
      decision: { id: id(5), storeId: id(6), publishedAt: '2026-10-13T02:00:00.000Z' },
    };
    expect(ReshareStatusHistoryResponseSchema.parse(page).data).toHaveLength(2);
    expect(() =>
      ReshareStatusHistoryResponseSchema.parse({ ...page, data: [{ ...event, extra: 1 }] }),
    ).toThrow();
    expect(() =>
      ReshareStatusHistoryResponseSchema.parse({
        ...page,
        data: [{ ...event, orderCode: 'RE-1' }],
      }),
    ).toThrow();
    expect(ReshareStatusHistoryQuerySchema.parse({ page: '2' })).toEqual({ page: 2, pageSize: 20 });
    expect(() => ReshareStatusHistoryQuerySchema.parse({ pageSize: '101' })).toThrow();
    expect(() => ReshareStatusHistoryQuerySchema.parse({ storeId: id(1) })).toThrow();
    expect(
      ListReshareStoresResponseSchema.parse({
        data: [{ id: id(1), code: 'CH01', name: 'Cửa hàng 1', isActive: false }],
        scoped: false,
      }).data[0]!.isActive,
    ).toBe(false);
  });
});

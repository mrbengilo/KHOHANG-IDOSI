import { describe, expect, it } from 'vitest';

import {
  CancelInboundReceiptRequestSchema,
  CreateInboundReceiptRequestSchema,
  CreateOutboundLineSchema,
  DeclareStoreReceiptRequestSchema,
  ExportMonthlyReportQuerySchema,
  FinalizeReceiptRequestSchema,
  MonthlyReportQuerySchema,
  OutboundReceiptDeclarationLineSchema,
  ReceiptCostConfirmationSchema,
  ReceiptSchema,
  StoreInventoryBagSchema,
} from '../src/index.js';

const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  allocationLine: '22222222-2222-4222-8222-222222222222',
  bag: '33333333-3333-4333-8333-333333333333',
  outbound: '44444444-4444-4444-8444-444444444444',
  outboundLine: '55555555-5555-4555-8555-555555555555',
  product: '66666666-6666-4666-8666-666666666666',
  receipt: '77777777-7777-4777-8777-777777777777',
  store: '88888888-8888-4888-8888-888888888888',
};

describe('receipt, outbound and report contracts', () => {
  it('rejects duplicate inbound bag codes', () => {
    const bag = { productId: IDS.product, bagCode: 'BAG-001', weightKg: '25.125' };
    expect(
      CreateInboundReceiptRequestSchema.safeParse({
        referenceCode: 'RCPT-001',
        supplierName: 'Supplier',
        receivedAt: '2026-09-10T08:00:00+07:00',
        bags: [bag],
      }).success,
    ).toBe(true);
    expect(
      CreateInboundReceiptRequestSchema.safeParse({
        referenceCode: 'RCPT-001',
        supplierName: 'Supplier',
        receivedAt: '2026-09-10T08:00:00+07:00',
        bags: [bag, bag],
      }).success,
    ).toBe(false);
  });

  it('requires confirmed costs to add up using whole VND', () => {
    const confirmation = {
      productCosts: [{ productId: IDS.product, priceVndPerKg: 25_000 }],
      transportationFeeVnd: 100_000,
      handlingFeeVnd: 20_000,
      goodsCostVnd: 1_000_000,
      totalCostVnd: 1_120_000,
      confirmedByAccountId: IDS.account,
      confirmedAt: '2026-09-10T10:00:00Z',
    };
    expect(ReceiptCostConfirmationSchema.safeParse(confirmation).success).toBe(true);
    expect(
      ReceiptCostConfirmationSchema.safeParse({ ...confirmation, totalCostVnd: 1_119_999 }).success,
    ).toBe(false);
    expect(
      ReceiptCostConfirmationSchema.safeParse({
        ...confirmation,
        transportationFeeVnd: 100_000.5,
      }).success,
    ).toBe(false);
  });

  it('requires an optimistic version when cancelling supplier stock', () => {
    expect(
      CancelInboundReceiptRequestSchema.safeParse({
        reason: 'Nhà cung cấp giao nhầm lô hàng',
        expectedVersion: 0,
      }).success,
    ).toBe(true);
    expect(
      CancelInboundReceiptRequestSchema.safeParse({
        reason: 'Nhà cung cấp giao nhầm lô hàng',
      }).success,
    ).toBe(false);
  });

  it('requires weight outbound picks to exactly match integer grams', () => {
    const line = {
      allocationLineId: IDS.allocationLine,
      productId: IDS.product,
      amount: { kind: 'WEIGHT', value: '1.250', unit: 'kg' },
      bagPicks: [{ sourceReceiptBagId: IDS.bag, weightGrams: 1_250 }],
    };
    expect(CreateOutboundLineSchema.safeParse(line).success).toBe(true);
    expect(
      CreateOutboundLineSchema.safeParse({
        ...line,
        bagPicks: [{ sourceReceiptBagId: IDS.bag, weightGrams: 1_249 }],
      }).success,
    ).toBe(false);
  });

  it('distinguishes full and short receipt declarations', () => {
    const declaration = {
      outboundLineId: IDS.outboundLine,
      expected: { kind: 'UNIT', quantity: 5 },
      actual: { kind: 'UNIT', quantity: 5 },
      declaration: 'FULL',
    };
    expect(OutboundReceiptDeclarationLineSchema.safeParse(declaration).success).toBe(true);
    expect(
      OutboundReceiptDeclarationLineSchema.safeParse({
        ...declaration,
        declaration: 'SHORT',
        actual: { kind: 'UNIT', quantity: 4 },
      }).success,
    ).toBe(false);
    expect(
      OutboundReceiptDeclarationLineSchema.safeParse({
        ...declaration,
        declaration: 'SHORT',
        actual: { kind: 'UNIT', quantity: 4 },
        shortageReason: 'One unit was missing',
      }).success,
    ).toBe(true);
    expect(
      OutboundReceiptDeclarationLineSchema.safeParse({
        ...declaration,
        actual: { kind: 'UNIT', quantity: 4 },
      }).success,
    ).toBe(false);
  });

  it('binds store receipt declarations to an outbound and requires shortage evidence', () => {
    const full = {
      storeId: IDS.store,
      outboundRequestId: IDS.outbound,
      lines: [{ productId: IDS.product, approvedUnits: 5, receivedUnits: 5 }],
    };
    expect(DeclareStoreReceiptRequestSchema.parse(full)).toEqual({
      ...full,
      discrepancyNote: null,
    });
    expect(
      DeclareStoreReceiptRequestSchema.safeParse({
        ...full,
        lines: [{ productId: IDS.product, approvedUnits: 5, receivedUnits: 4 }],
      }).success,
    ).toBe(false);
    expect(
      DeclareStoreReceiptRequestSchema.safeParse({
        ...full,
        lines: [{ productId: IDS.product, approvedUnits: 5, receivedUnits: 4 }],
        discrepancyNote: 'Thiếu một bao khi giao nhận',
      }).success,
    ).toBe(true);
    expect(
      DeclareStoreReceiptRequestSchema.safeParse({
        ...full,
        outboundRequestId: undefined,
        allocationId: IDS.allocationLine,
      }).success,
    ).toBe(false);
  });

  it('requires exact bag evidence and reviewer data before a receipt is finalized', () => {
    const line = {
      productId: IDS.product,
      approvedUnits: 2,
      receivedUnits: 2,
      bagWeightsKg: ['1.250', '1.500'],
      pricePerKgVnd: 20_000,
    };
    expect(
      FinalizeReceiptRequestSchema.safeParse({
        lines: [line],
        freightVnd: 10_000,
        handlingVnd: 5_000,
        expectedVersion: 3,
      }).success,
    ).toBe(true);
    expect(
      FinalizeReceiptRequestSchema.safeParse({
        lines: [{ ...line, bagWeightsKg: ['2.750'] }],
        freightVnd: 10_000,
        handlingVnd: 5_000,
        expectedVersion: 3,
      }).success,
    ).toBe(false);

    const finalizedReceipt = {
      id: IDS.receipt,
      receiptNumber: 'SR-2026-0001',
      storeId: IDS.store,
      outboundRequestId: IDS.outbound,
      declaredByAccountId: null,
      lines: [line],
      discrepancyNote: null,
      status: 'FINALIZED',
      freightVnd: 10_000,
      handlingVnd: 5_000,
      totalCostVnd: 70_000,
      reviewedByAccountId: IDS.account,
      reviewNote: null,
      version: 4,
      createdAt: '2026-09-10T08:00:00Z',
      updatedAt: '2026-09-10T10:00:00Z',
    };
    expect(ReceiptSchema.safeParse(finalizedReceipt).success).toBe(true);
    expect(
      ReceiptSchema.safeParse({ ...finalizedReceipt, reviewedByAccountId: null }).success,
    ).toBe(false);
    expect(
      ReceiptSchema.safeParse({
        ...finalizedReceipt,
        lines: [{ ...line, bagWeightsKg: ['2.750'] }],
      }).success,
    ).toBe(false);
  });

  it('prevents impossible store bag balances', () => {
    const bag = {
      id: IDS.bag,
      storeId: IDS.store,
      productId: IDS.product,
      sourceReceiptBagId: IDS.receipt,
      outboundOrderId: IDS.outbound,
      bagCode: 'BAG-001',
      originalWeightKg: '25',
      receivedWeightKg: '24.900',
      remainingWeightKg: '20.100',
      status: 'OPEN',
      version: 2,
      receivedAt: '2026-09-10T10:00:00Z',
      updatedAt: '2026-09-10T11:00:00Z',
    };
    expect(StoreInventoryBagSchema.safeParse(bag).success).toBe(true);
    expect(StoreInventoryBagSchema.safeParse({ ...bag, remainingWeightKg: '25' }).success).toBe(
      false,
    );
    expect(
      StoreInventoryBagSchema.safeParse({ ...bag, status: 'EMPTY', remainingWeightKg: '0' })
        .success,
    ).toBe(true);
  });

  it('requires a report scope ID only for group and store reports', () => {
    expect(MonthlyReportQuerySchema.parse({ year: '2026', month: '9' })).toEqual({
      year: 2026,
      month: 9,
      scopeKind: 'ALL',
    });
    expect(
      MonthlyReportQuerySchema.safeParse({
        year: 2026,
        month: 9,
        scopeKind: 'STORE',
        scopeId: IDS.store,
      }).success,
    ).toBe(true);
    expect(
      MonthlyReportQuerySchema.safeParse({ year: 2026, month: 9, scopeKind: 'STORE' }).success,
    ).toBe(false);
    expect(
      MonthlyReportQuerySchema.safeParse({
        year: 2026,
        month: 13,
        scopeKind: 'ALL',
      }).success,
    ).toBe(false);
    expect(
      ExportMonthlyReportQuerySchema.safeParse({
        year: 2026,
        month: 9,
        scopeKind: 'ALL',
        format: 'xlsx',
      }).success,
    ).toBe(true);
  });
});

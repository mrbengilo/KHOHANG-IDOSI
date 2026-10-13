import { describe, expect, it } from 'vitest';

import {
  ApiErrorCodeSchema,
  CancelSupplierOrderRequestSchema,
  ConfirmSupplierObservationRequestSchema,
  CreateSupplierSourceRequestSchema,
  RecordSupplierOrderRequestSchema,
  RecordSupplierSourceReturnRequestSchema,
  SupplierCommitmentsQuerySchema,
  SupplierObservationRequestSchema,
  SupplierReconciliationQuerySchema,
} from '../src/index.js';

const id = '7d2f4f0e-5a4b-4c3d-9e8f-0a1b2c3d4e5f';
const other = '8e3a5b1f-6b5c-4d4e-8f90-1b2c3d4e5f60';

describe('supplier reconciliation contracts', () => {
  it('accepts an explicit zero and defaults coverage and attestation', () => {
    const parsed = SupplierObservationRequestSchema.parse({
      sourceId: id,
      observedAt: '2026-10-13T01:00:00.000Z',
      lines: [{ productId: id, observedQuantity: 0 }],
    });
    expect(parsed).toMatchObject({ eventCoverage: [], attestUnlinkedAsNotOrdered: false });
  });

  it('refuses negative, fractional or oversized observed stock and unknown fields', () => {
    for (const observedQuantity of [-1, 1.5, 1_000_001]) {
      expect(
        SupplierObservationRequestSchema.safeParse({
          sourceId: id,
          observedAt: '2026-10-13T01:00:00.000Z',
          lines: [{ productId: id, observedQuantity }],
        }).success,
      ).toBe(false);
    }
    expect(
      SupplierObservationRequestSchema.safeParse({
        sourceId: id,
        observedAt: '2026-10-13T01:00:00.000Z',
        lines: [{ productId: id, observedQuantity: 1 }],
        onHand: 5,
      }).success,
    ).toBe(false);
    // Derived numbers never come from the client: only S, the time and the coverage answers.
    expect(
      ConfirmSupplierObservationRequestSchema.safeParse({
        sourceId: id,
        observedAt: '2026-10-13T01:00:00.000Z',
        lines: [{ productId: id, observedQuantity: 1, freeQuantity: 9 }],
        expectedRevision: 'r1',
      }).success,
    ).toBe(false);
  });

  it('requires a preview revision to confirm', () => {
    expect(
      ConfirmSupplierObservationRequestSchema.safeParse({
        sourceId: id,
        observedAt: '2026-10-13T01:00:00.000Z',
        lines: [{ productId: id, observedQuantity: 1 }],
      }).success,
    ).toBe(false);
  });

  it('records B orders per A commitment with positive quantities and B line references', () => {
    expect(
      RecordSupplierOrderRequestSchema.parse({
        sourceId: id,
        externalRef: ' RS-1001 ',
        occurredAt: '2026-10-13T02:00:00+07:00',
        lines: [{ reservationId: other, quantity: 2, externalLineRef: 'SKU-1' }],
      }).externalRef,
    ).toBe('RS-1001');
    expect(
      RecordSupplierOrderRequestSchema.safeParse({
        sourceId: id,
        externalRef: 'RS-1001',
        occurredAt: '2026-10-13T02:00:00+07:00',
        lines: [{ reservationId: other, quantity: 0, externalLineRef: 'SKU-1' }],
      }).success,
    ).toBe(false);
    expect(
      CancelSupplierOrderRequestSchema.safeParse({
        quantity: 1,
        cancelRef: 'C-1',
        occurredAt: '2026-10-13T02:00:00+07:00',
      }).success,
    ).toBe(false);
    expect(
      RecordSupplierSourceReturnRequestSchema.safeParse({
        sourceId: id,
        productId: other,
        quantity: 1,
        externalRef: 'R-1',
        occurredAt: '2026-10-13T02:00:00+07:00',
        note: 'x',
      }).success,
    ).toBe(false);
  });

  it('normalises source codes and validates filters', () => {
    expect(
      CreateSupplierSourceRequestSchema.parse({ code: ' reshare-hn ', name: 'Reshare' }).code,
    ).toBe('RESHARE-HN');
    expect(SupplierReconciliationQuerySchema.parse({}).filter).toBe('ALL');
    expect(SupplierReconciliationQuerySchema.safeParse({ filter: 'EVERYTHING' }).success).toBe(
      false,
    );
    expect(SupplierCommitmentsQuerySchema.parse({ filter: 'ORDERABLE' }).filter).toBe('ORDERABLE');
  });

  it('exposes the structured error codes of the workflow', () => {
    for (const code of [
      'VERSION_CONFLICT',
      'SOURCE_NOT_RECONCILED',
      'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS',
      'SOURCE_SHORTFALL',
      'ORDER_SOURCE_NOT_ELIGIBLE',
      'QUANTITY_EXCEEDED',
      'DUPLICATE_EXTERNAL_EVENT',
      'IDEMPOTENCY_CONFLICT',
      'FORBIDDEN',
    ]) {
      expect(ApiErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

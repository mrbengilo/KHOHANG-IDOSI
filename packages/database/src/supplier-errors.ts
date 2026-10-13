import type { JsonObject } from './schema.js';

export const SUPPLIER_ERROR_CODES = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'VERSION_CONFLICT',
  'SOURCE_NOT_RECONCILED',
  'SOURCE_RECONCILED',
  'EXTERNAL_EVENT_COVERAGE_AMBIGUOUS',
  'SOURCE_SHORTFALL',
  'ORDER_SOURCE_NOT_ELIGIBLE',
  'QUANTITY_EXCEEDED',
  'DUPLICATE_EXTERNAL_EVENT',
  'IDEMPOTENCY_CONFLICT',
  'OBSERVATION_OUT_OF_ORDER',
  'LEGACY_ATTESTATION_REQUIRED',
] as const;
export type SupplierErrorCode = (typeof SUPPLIER_ERROR_CODES)[number];

/** Every refusal of the supplier workflow; `code` maps 1:1 to an API error code. */
export class SupplierReconciliationError extends Error {
  public constructor(
    public readonly code: SupplierErrorCode,
    message: string,
    public readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = 'SupplierReconciliationError';
  }
}

export const DOMAIN_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'INVALID_STATE',
  'REQUEST_WINDOW_CLOSED',
  'REQUEST_LIMIT_EXCEEDED',
  'DUPLICATE_REQUEST_SEQUENCE',
  'IDEMPOTENCY_CONFLICT',
  'ACTIVE_WAIT_TICKET_EXISTS',
  'WAIT_TICKET_NOT_ACTIVE',
  'WAIT_QUANTITY_EXCEEDED',
  'OFFER_ALREADY_EXISTS',
  'OFFER_EXPIRED',
  'OFFER_NOT_PENDING',
  'OFFER_NOT_CONFIRMED',
  'RECEIPT_ALREADY_RECONCILED',
  'RECEIPT_QUANTITY_EXCEEDED',
  'INSUFFICIENT_INVENTORY',
  'LEDGER_CORRUPTED',
  'UNSUPPORTED_POLICY_VERSION',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export type DomainErrorDetail = string | number | boolean | null;

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly details: Readonly<Record<string, DomainErrorDetail>>;

  public constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, DomainErrorDetail>> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'DomainError';
  }
}

export function invariant(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: Readonly<Record<string, DomainErrorDetail>> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}

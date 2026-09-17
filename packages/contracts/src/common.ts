import { z } from 'zod';

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/;
const DECIMAL_KG_PATTERN = /^(0|[1-9]\d*)(\.\d{1,3})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const EntityIdSchema = z.string().uuid();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const IsoDateSchema = z
  .string()
  .regex(DATE_PATTERN, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Expected a valid calendar date');
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** Whole Vietnamese dong. Floating-point or fractional VND values are rejected. */
export const MoneyVndSchema = z.number().int().nonnegative().safe();
export type MoneyVnd = z.infer<typeof MoneyVndSchema>;

export const SignedMoneyVndSchema = z.number().int().safe();
export type SignedMoneyVnd = z.infer<typeof SignedMoneyVndSchema>;

/** Canonical non-negative kilograms with at most gram precision. */
export const KilogramsDecimalSchema = z
  .string()
  .max(24)
  .regex(
    DECIMAL_KG_PATTERN,
    'Expected a non-negative decimal kilogram string with at most 3 decimals',
  );
export type KilogramsDecimal = z.infer<typeof KilogramsDecimalSchema>;

export const PositiveKilogramsDecimalSchema = KilogramsDecimalSchema.refine(
  (value) => !/^0(?:\.0{1,3})?$/.test(value),
  'Weight must be greater than zero',
);
export type PositiveKilogramsDecimal = z.infer<typeof PositiveKilogramsDecimalSchema>;

export const GramsSchema = z.number().int().nonnegative().safe();
export type Grams = z.infer<typeof GramsSchema>;

export const PositiveGramsSchema = z.number().int().positive().safe();
export type PositiveGrams = z.infer<typeof PositiveGramsSchema>;

export const UnitQuantitySchema = z.number().int().nonnegative().safe();
export type UnitQuantity = z.infer<typeof UnitQuantitySchema>;

export const PositiveUnitQuantitySchema = z.number().int().positive().safe();
export type PositiveUnitQuantity = z.infer<typeof PositiveUnitQuantitySchema>;

export const NonEmptyTextSchema = z.string().trim().min(1).max(1_000);
export const AuditReasonSchema = z.string().trim().min(3).max(500);

export const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginationMetaSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const SortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NOT_FOUND',
  'CONFLICT',
  'ACCOUNT_INACTIVE',
  'SESSION_REVOKED',
  'IDEMPOTENCY_CONFLICT',
  'SESSION_NOT_OPEN',
  'REQUEST_LIMIT_REACHED',
  'INSUFFICIENT_STOCK',
  'INVALID_STATE_TRANSITION',
  'VERSION_CONFLICT',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    requestId: z.string().trim().min(1).max(128),
    fieldErrors: z.record(z.string(), z.array(z.string().min(1))).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ErrorEnvelopeSchema = z.object({ error: ApiErrorSchema }).strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const IdempotencyHeadersSchema = z
  .object({
    'idempotency-key': IdempotencyKeySchema,
    'x-request-id': z.string().trim().min(1).max(128).optional(),
  })
  .passthrough();
export type IdempotencyHeaders = z.infer<typeof IdempotencyHeadersSchema>;

export const MutationMetadataSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    replayed: z.boolean(),
  })
  .strict();
export type MutationMetadata = z.infer<typeof MutationMetadataSchema>;

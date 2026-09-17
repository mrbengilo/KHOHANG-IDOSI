import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
  PositiveUnitQuantitySchema,
} from './common.js';

export const ProductStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const ProductMeasurementSchema = z.enum(['UNIT', 'WEIGHT']);
export type ProductMeasurement = z.infer<typeof ProductMeasurementSchema>;

export const ProductSchema = z
  .object({
    id: EntityIdSchema,
    sku: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    measurement: ProductMeasurementSchema,
    unitLabel: z.string().trim().min(1).max(40),
    status: ProductStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Product = z.infer<typeof ProductSchema>;

export const ProductParamsSchema = z.object({ productId: EntityIdSchema }).strict();
export type ProductParams = z.infer<typeof ProductParamsSchema>;

export const CreateProductRequestSchema = z
  .object({
    sku: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    measurement: ProductMeasurementSchema,
    unitLabel: z.string().trim().min(1).max(40),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    unitLabel: z.string().trim().min(1).max(40).optional(),
    status: ProductStatusSchema.optional(),
  })
  .strict()
  .refine((request) => Object.keys(request).length > 0, 'At least one field is required');
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

export const ProductResponseSchema = z.object({ data: ProductSchema }).strict();
export type ProductResponse = z.infer<typeof ProductResponseSchema>;

export const ListProductsQuerySchema = PaginationQuerySchema.extend({
  status: ProductStatusSchema.optional(),
  measurement: ProductMeasurementSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

export const ListProductsResponseSchema = z
  .object({ data: z.array(ProductSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListProductsResponse = z.infer<typeof ListProductsResponseSchema>;

const ProductConversionPeriodFields = {
  effectiveFrom: IsoDateSchema,
  effectiveTo: IsoDateSchema.nullable(),
};
const ProductConversionItemQuantitySchema = PositiveUnitQuantitySchema.max(2_147_483_647);
const ProductConversionWeightKilogramsSchema = PositiveKilogramsDecimalSchema.refine(
  (value) => (value.split('.')[0]?.length ?? 0) <= 11,
  'Weight exceeds NUMERIC(14,3) storage capacity',
);
const QueryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

function hasOrderedConversionPeriod(period: {
  effectiveFrom: string;
  effectiveTo: string | null;
}): boolean {
  return period.effectiveTo === null || period.effectiveTo > period.effectiveFrom;
}

/**
 * Exact conversion ratio: `itemQuantity` items correspond to `weightKilograms` kg.
 * Kilograms stay a decimal string so callers never need a floating-point approximation.
 */
export const ProductConversionSchema = z
  .object({
    id: EntityIdSchema,
    productId: EntityIdSchema,
    version: z.number().int().positive().safe(),
    itemQuantity: ProductConversionItemQuantitySchema,
    weightKilograms: ProductConversionWeightKilogramsSchema,
    ...ProductConversionPeriodFields,
    reason: AuditReasonSchema,
    createdByAccountId: EntityIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    retiredAt: IsoDateTimeSchema.nullable(),
    retiredByAccountId: EntityIdSchema.nullable(),
    retirementReason: AuditReasonSchema.nullable(),
  })
  .strict()
  .superRefine((conversion, context) => {
    const storedPeriodIsValid =
      conversion.effectiveTo === null ||
      conversion.effectiveTo > conversion.effectiveFrom ||
      (conversion.effectiveTo === conversion.effectiveFrom && conversion.retiredAt !== null);
    if (!storedPeriodIsValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'effectiveTo must be later, or equal only for a retired pre-effective version',
        path: ['effectiveTo'],
      });
    }
    const retirementFields = [
      conversion.retiredAt,
      conversion.retiredByAccountId,
      conversion.retirementReason,
    ];
    if (
      !retirementFields.every((value) => value === null) &&
      retirementFields.some((value) => value === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retirement audit fields must be set together',
        path: ['retiredAt'],
      });
    }
    if (conversion.retiredAt !== null && conversion.effectiveTo === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retired conversions require an effectiveTo date',
        path: ['effectiveTo'],
      });
    }
  });
export type ProductConversion = z.infer<typeof ProductConversionSchema>;

export const ProductConversionParamsSchema = z
  .object({ productId: EntityIdSchema, conversionId: EntityIdSchema })
  .strict();
export type ProductConversionParams = z.infer<typeof ProductConversionParamsSchema>;

export const CreateProductConversionRequestSchema = z
  .object({
    ...ProductConversionPeriodFields,
    itemQuantity: ProductConversionItemQuantitySchema,
    weightKilograms: ProductConversionWeightKilogramsSchema,
    reason: AuditReasonSchema,
    /**
     * Compare-and-append guard. Omit (or send zero) for the first conversion; when history
     * exists this must match the latest immutable version before a retired series can resume.
     */
    expectedVersion: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .refine(hasOrderedConversionPeriod, {
    message: 'effectiveTo must be later than effectiveFrom',
    path: ['effectiveTo'],
  });
export type CreateProductConversionRequest = z.infer<typeof CreateProductConversionRequestSchema>;

/** Replaces a conversion by creating the next immutable version. */
export const UpdateProductConversionRequestSchema = z
  .object({
    ...ProductConversionPeriodFields,
    itemQuantity: ProductConversionItemQuantitySchema,
    weightKilograms: ProductConversionWeightKilogramsSchema,
    reason: AuditReasonSchema,
    expectedVersion: z.number().int().positive().safe(),
  })
  .strict()
  .refine(hasOrderedConversionPeriod, {
    message: 'effectiveTo must be later than effectiveFrom',
    path: ['effectiveTo'],
  });
export type UpdateProductConversionRequest = z.infer<typeof UpdateProductConversionRequestSchema>;

/** Retires a conversion without removing its historical row. */
export const DeleteProductConversionRequestSchema = z
  .object({
    reason: AuditReasonSchema,
    expectedVersion: z.number().int().positive().safe(),
  })
  .strict();
export type DeleteProductConversionRequest = z.infer<typeof DeleteProductConversionRequestSchema>;

export const ProductConversionResponseSchema = z.object({ data: ProductConversionSchema }).strict();
export type ProductConversionResponse = z.infer<typeof ProductConversionResponseSchema>;

export const ListProductConversionsQuerySchema = PaginationQuerySchema.extend({
  effectiveAt: IsoDateSchema.optional(),
  includeRetired: QueryBooleanSchema.default(false),
}).strict();
export type ListProductConversionsQuery = z.infer<typeof ListProductConversionsQuerySchema>;

export const ListProductConversionsResponseSchema = z
  .object({ data: z.array(ProductConversionSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListProductConversionsResponse = z.infer<typeof ListProductConversionsResponseSchema>;

import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
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

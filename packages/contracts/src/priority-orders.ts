import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema } from './common.js';

const Quantity = z.number().int().positive().max(10000);
export const PriorityOrderInputSchema = z
  .object({
    storeId: EntityIdSchema,
    sources: z
      .array(z.object({ id: EntityIdSchema, revision: z.string().min(1).max(100) }).strict())
      .min(1)
      .max(100),
    additionalLines: z
      .array(z.object({ productId: EntityIdSchema, quantity: Quantity }).strict())
      .min(1)
      .max(100),
    notes: z.string().trim().max(500).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sources.map((s) => s.id)).size !== value.sources.length)
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Nguồn hàng bị lặp.' });
    if (
      new Set(value.additionalLines.map((s) => s.productId)).size !== value.additionalLines.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['additionalLines'],
        message: 'Mỗi mặt hàng chỉ có một dòng đặt thêm.',
      });
  });
export type PriorityOrderInput = z.infer<typeof PriorityOrderInputSchema>;
export const PriorityOrderQuerySchema = z
  .object({
    storeId: EntityIdSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PriorityOrderQuery = z.infer<typeof PriorityOrderQuerySchema>;
export const PriorityAvailabilitySchema = z
  .object({
    productId: EntityIdSchema,
    name: z.string(),
    sku: z.string(),
    availableBags: z.number().int().nonnegative(),
    maxAdditionalBags: z.number().int().nonnegative(),
    orderable: z.boolean(),
    blockingReason: z.string().nullable(),
    observedAt: IsoDateTimeSchema,
  })
  .strict();
export type PriorityAvailability = z.infer<typeof PriorityAvailabilitySchema>;
export const PrioritySourceSchema = z
  .object({
    id: EntityIdSchema,
    revision: z.string(),
    productId: EntityIdSchema,
    name: z.string(),
    quantity: Quantity,
    status: z.enum(['active', 'issued']),
    heldSince: IsoDateTimeSchema,
    reshareCode: z.string().nullable(),
  })
  .strict();
export type PrioritySource = z.infer<typeof PrioritySourceSchema>;
export const PriorityContextSchema = z
  .object({
    stores: z.array(z.object({ id: EntityIdSchema, name: z.string() }).strict()),
    sources: z.array(PrioritySourceSchema),
    sourcePage: z.number().int().positive(),
    sourcesHaveMore: z.boolean(),
    products: z.array(PriorityAvailabilitySchema),
    waitDocuments: z.array(z.object({ id: EntityIdSchema, code: z.string() }).strict()),
  })
  .strict();
export type PriorityContext = z.infer<typeof PriorityContextSchema>;
export const PriorityOrderSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string(),
    type: z.literal('EMERGENCY_PRIORITY_ORDER'),
    storeId: EntityIdSchema,
    storeName: z.string(),
    actorName: z.string(),
    approvedAt: IsoDateTimeSchema,
    status: z.string(),
    version: z.number().int(),
    totalQuantity: Quantity,
    outboundRequestId: EntityIdSchema,
    reshareId: EntityIdSchema,
    reshareCode: z.string(),
    reshareQuantity: Quantity,
    reshareStatus: z.enum(['ORDERED', 'NOT_ORDERED']),
    notes: z.string(),
    lines: z.array(
      z
        .object({
          productId: EntityIdSchema,
          name: z.string(),
          held: z.number().int().nonnegative(),
          additional: z.number().int().nonnegative(),
          total: Quantity,
        })
        .strict(),
    ),
    sources: z.array(
      z
        .object({
          reservationId: EntityIdSchema,
          productId: EntityIdSchema,
          quantity: Quantity,
          kind: z.enum(['held', 'additional']),
          reshareCode: z.string(),
        })
        .strict(),
    ),
    history: z.array(
      z
        .object({ action: z.string(), actorName: z.string(), createdAt: IsoDateTimeSchema })
        .strict(),
    ),
  })
  .strict();
export type PriorityOrder = z.infer<typeof PriorityOrderSchema>;
export const PriorityOrderPageSchema = z
  .object({
    data: z.array(PriorityOrderSchema),
    pagination: z
      .object({
        page: z.number(),
        pageSize: z.number(),
        totalItems: z.number(),
        totalPages: z.number(),
      })
      .strict(),
  })
  .strict();
export type PriorityOrderPage = z.infer<typeof PriorityOrderPageSchema>;
export const PriorityStatusInputSchema = z
  .object({
    status: z.enum(['ORDERED', 'NOT_ORDERED']),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type PriorityStatusInput = z.infer<typeof PriorityStatusInputSchema>;

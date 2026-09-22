import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
  PositiveKilogramsDecimalSchema,
} from './common.js';
import { kilogramsToGramsForRefinement, sumRefinementValues } from './refinement-values.js';

/**
 * Goods a store receives straight from another partner, outside the warehouse allocation
 * flow. The slip is store-owned and final on save: there is no HTKD review step, because
 * nothing here was dispatched by the warehouse and there is no dispatch to reconcile.
 *
 * Every received unit is one physical bag with its own weight, exactly like warehouse
 * stock, so partner goods land in the same store inventory and can be opened, sold and
 * transferred without a second stock model.
 */
export const PartnerInboundLineSchema = z
  .object({
    productId: EntityIdSchema,
    quantity: z.number().int().positive().safe(),
    bagWeightsKg: z.array(PositiveKilogramsDecimalSchema).min(1).max(2_000),
  })
  .strict()
  .superRefine((line, context) => {
    if (line.bagWeightsKg.length !== line.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bagWeightsKg'],
        message: 'Provide one weight for each received unit',
      });
    }
  });
export type PartnerInboundLine = z.infer<typeof PartnerInboundLineSchema>;

const PartnerInboundLinesSchema = z
  .array(PartnerInboundLineSchema)
  .min(1)
  .max(200)
  .refine(
    (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
    'A product may appear only once in a partner inbound slip',
  );

export const StorePartnerInboundSchema = z
  .object({
    id: EntityIdSchema,
    referenceCode: z.string().trim().min(1).max(100),
    storeId: EntityIdSchema,
    partnerName: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1_000).nullable(),
    lines: PartnerInboundLinesSchema,
    totalQuantity: z.number().int().positive().safe(),
    totalWeightKg: PositiveKilogramsDecimalSchema,
    createdByAccountId: EntityIdSchema,
    receivedAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((slip, context) => {
    const declaredQuantity = slip.lines.reduce((sum, line) => sum + line.quantity, 0);
    if (declaredQuantity !== slip.totalQuantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalQuantity'],
        message: 'Total quantity must equal the sum of line quantities',
      });
    }
    const lineTotal = sumRefinementValues(
      slip.lines.flatMap((line) => line.bagWeightsKg.map(kilogramsToGramsForRefinement)),
    );
    const declaredTotal = kilogramsToGramsForRefinement(slip.totalWeightKg);
    if (lineTotal !== null && declaredTotal !== null && lineTotal !== declaredTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalWeightKg'],
        message: 'Total weight must equal the sum of bag weights',
      });
    }
  });
export type StorePartnerInbound = z.infer<typeof StorePartnerInboundSchema>;

export const CreateStorePartnerInboundRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    partnerName: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1_000).nullable().default(null),
    receivedAt: IsoDateTimeSchema,
    lines: PartnerInboundLinesSchema,
  })
  .strict();
export type CreateStorePartnerInboundRequest = z.infer<
  typeof CreateStorePartnerInboundRequestSchema
>;

/** Server-owned sequence; Vietnam calendar date, independent of server timezone. */
export function formatPartnerInboundNumber(sequence: string, now: Date): string {
  if (!/^[1-9]\d*$/.test(sequence)) throw new Error('Invalid partner inbound sequence');
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
  return `PNDT${sequence.padStart(5, '0')}-${date}`;
}

export const StorePartnerInboundParamsSchema = z
  .object({ partnerInboundId: EntityIdSchema })
  .strict();
export type StorePartnerInboundParams = z.infer<typeof StorePartnerInboundParamsSchema>;

export const StorePartnerInboundResponseSchema = z
  .object({ data: StorePartnerInboundSchema })
  .strict();
export type StorePartnerInboundResponse = z.infer<typeof StorePartnerInboundResponseSchema>;

export const ListStorePartnerInboundsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  partner: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ListStorePartnerInboundsQuery = z.infer<typeof ListStorePartnerInboundsQuerySchema>;

export const ListStorePartnerInboundsResponseSchema = z
  .object({ data: z.array(StorePartnerInboundSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStorePartnerInboundsResponse = z.infer<
  typeof ListStorePartnerInboundsResponseSchema
>;

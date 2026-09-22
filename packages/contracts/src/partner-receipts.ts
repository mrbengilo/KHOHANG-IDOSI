import { z } from 'zod';

import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';

export const PartnerReceiptStatusSchema = z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']);
export type PartnerReceiptStatus = z.infer<typeof PartnerReceiptStatusSchema>;

export const PartnerReceiptLineSchema = z
  .object({
    id: EntityIdSchema,
    partnerReceiptId: EntityIdSchema,
    productId: EntityIdSchema,
    productName: z.string(),
    quantity: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type PartnerReceiptLine = z.infer<typeof PartnerReceiptLineSchema>;

export const PartnerReceiptSchema = z
  .object({
    id: EntityIdSchema,
    receiptNumber: z.string().trim().min(1).max(100),
    storeId: EntityIdSchema,
    storeName: z.string(),
    partnerName: z.string().trim().min(2).max(200),
    status: PartnerReceiptStatusSchema,
    notes: z.string().nullable(),
    totalQuantity: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    createdByAccountId: EntityIdSchema.nullable(),
    createdByName: z.string().nullable(),
    confirmedByAccountId: EntityIdSchema.nullable(),
    confirmedByName: z.string().nullable(),
    confirmedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lines: z.array(PartnerReceiptLineSchema),
  })
  .strict();
export type PartnerReceipt = z.infer<typeof PartnerReceiptSchema>;

export const CreatePartnerReceiptLineInputSchema = z
  .object({
    productId: EntityIdSchema,
    quantity: z.number().int().positive(),
  })
  .strict();
export type CreatePartnerReceiptLineInput = z.infer<typeof CreatePartnerReceiptLineInputSchema>;

export const CreatePartnerReceiptRequestSchema = z
  .object({
    storeId: EntityIdSchema,
    partnerName: z.string().trim().min(2).max(200),
    notes: z.string().trim().max(1000).optional(),
    lines: z.array(CreatePartnerReceiptLineInputSchema).min(1).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    const productIds = request.lines.map((line) => line.productId);
    if (new Set(productIds).size !== productIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'Mỗi mặt hàng chỉ được xuất hiện một lần',
      });
    }
  });
export type CreatePartnerReceiptRequest = z.infer<typeof CreatePartnerReceiptRequestSchema>;

export const CreatePartnerReceiptResponseSchema = z
  .object({
    data: PartnerReceiptSchema,
  })
  .strict();
export type CreatePartnerReceiptResponse = z.infer<typeof CreatePartnerReceiptResponseSchema>;

export const ListPartnerReceiptsQuerySchema = PaginationQuerySchema.extend({
  storeId: EntityIdSchema.optional(),
  status: PartnerReceiptStatusSchema.optional(),
  partnerName: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ListPartnerReceiptsQuery = z.infer<typeof ListPartnerReceiptsQuerySchema>;

export const ListPartnerReceiptsResponseSchema = z
  .object({
    data: z.array(PartnerReceiptSchema),
    pagination: PaginationMetaSchema,
  })
  .strict();
export type ListPartnerReceiptsResponse = z.infer<typeof ListPartnerReceiptsResponseSchema>;

export const GetPartnerReceiptResponseSchema = z
  .object({
    data: PartnerReceiptSchema,
  })
  .strict();
export type GetPartnerReceiptResponse = z.infer<typeof GetPartnerReceiptResponseSchema>;

export const PartnerReceiptParamsSchema = z
  .object({
    receiptId: EntityIdSchema,
  })
  .strict();
export type PartnerReceiptParams = z.infer<typeof PartnerReceiptParamsSchema>;

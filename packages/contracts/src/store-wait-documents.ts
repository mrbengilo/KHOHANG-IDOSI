import { z } from 'zod';

import {
  AuditReasonSchema,
  EntityIdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PaginationMetaSchema,
  PaginationQuerySchema,
} from './common.js';
import { AccountRoleSchema } from './identity.js';
import { ProductUnitSchema } from './order-history.js';
import { WaitTicketCancelPreviewSchema } from './waitlist.js';

/**
 * The store-level wait document "phiếu chờ" (docs/store-active-wait-document.md): at most one
 * current document per store, listing every product it still waits for; processed documents stay
 * readable with what they handed over to their successor.
 */
export const StoreWaitDocumentStatusSchema = z.enum([
  'CURRENT',
  'MERGED',
  'ROLLED_OVER',
  'COMPLETED',
  'CANCELLED',
]);
export type StoreWaitDocumentStatus = z.infer<typeof StoreWaitDocumentStatusSchema>;

export const StoreWaitDocumentViewSchema = z.enum(['ACTIVE', 'HISTORY', 'ALL']);
export type StoreWaitDocumentView = z.infer<typeof StoreWaitDocumentViewSchema>;

export const StoreWaitDocumentEventKindSchema = z.enum([
  'ALLOCATION_RUN',
  'RESULT_ACCEPTED',
  'RESULT_WAITLISTED',
  'WAIT_TICKET_CANCELLED',
  'WAIT_DOCUMENT_CANCELLED',
  'PRIORITY_OFFER_RESPONSE',
  'RECEIPT_SHORTAGE',
  'RECEIPT_ADJUSTMENT',
  'SYSTEM_SYNC',
  'MIGRATION_BACKFILL',
]);
export type StoreWaitDocumentEventKind = z.infer<typeof StoreWaitDocumentEventKindSchema>;

const QuantitySchema = z.number().int().nonnegative().safe();

export const ListStoreWaitDocumentsQuerySchema = PaginationQuerySchema.extend({
  /** ACTIVE (default): current documents; HISTORY: processed ones; ALL: both. */
  view: StoreWaitDocumentViewSchema.default('ACTIVE'),
  status: StoreWaitDocumentStatusSchema.optional(),
  storeId: EntityIdSchema.optional(),
  productId: EntityIdSchema.optional(),
  /** Document code (PCT), line ticket code (PC), priority offer code (PUT), product or SKU. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Inclusive opening dates in Asia/Ho_Chi_Minh. */
  openedFrom: IsoDateSchema.optional(),
  openedTo: IsoDateSchema.optional(),
})
  .strict()
  .superRefine((query, context) => {
    if (query.openedFrom && query.openedTo && query.openedFrom > query.openedTo) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['openedTo'],
        message: 'openedTo must not precede openedFrom',
      });
    }
  });
export type ListStoreWaitDocumentsQuery = z.infer<typeof ListStoreWaitDocumentsQuerySchema>;

export const StoreWaitDocumentParamsSchema = z.object({ documentId: EntityIdSchema }).strict();

export const StoreWaitDocumentEventSchema = z
  .object({
    id: EntityIdSchema,
    kind: StoreWaitDocumentEventKindSchema,
    occurredAt: IsoDateTimeSchema,
    /** Who acted (null for the 09:00 run, catch-up and backfill), as named at the time. */
    actor: z
      .object({
        accountId: EntityIdSchema,
        role: AccountRoleSchema.nullable(),
        displayName: z.string().nullable(),
      })
      .strict()
      .nullable(),
    reason: z.string().nullable(),
    session: z.object({ id: EntityIdSchema, code: z.string() }).strict().nullable(),
    allocationRunId: EntityIdSchema.nullable(),
    allocationDecisionId: EntityIdSchema.nullable(),
    reshareOrderCode: z.string().nullable(),
    waitTicket: z.object({ id: EntityIdSchema, code: z.string() }).strict().nullable(),
    priorityOffer: z.object({ id: EntityIdSchema, code: z.string() }).strict().nullable(),
    storeReceipt: z.object({ id: EntityIdSchema, number: z.string() }).strict().nullable(),
  })
  .strict();
export type StoreWaitDocumentEvent = z.infer<typeof StoreWaitDocumentEventSchema>;

export const StoreWaitDocumentLineSchema = z
  .object({
    productId: EntityIdSchema,
    sku: z.string(),
    productName: z.string(),
    unit: ProductUnitSchema,
    /** Opening snapshot: bags handed over by the previous document and bags added by this one. */
    carriedInQuantity: QuantitySchema,
    addedQuantity: QuantitySchema,
    openingRemainingQuantity: QuantitySchema,
    openingPendingQuantity: QuantitySchema,
    /** Closing snapshot (null while the document is current). */
    confirmedQuantity: QuantitySchema.nullable(),
    cancelledQuantity: QuantitySchema.nullable(),
    adjustedQuantity: QuantitySchema.nullable(),
    carriedOutQuantity: QuantitySchema.nullable(),
    /** Live split of a current document: waiting for allocation / granted awaiting the answer. */
    remainingQuantity: QuantitySchema.nullable(),
    pendingQuantity: QuantitySchema.nullable(),
  })
  .strict();
export type StoreWaitDocumentLine = z.infer<typeof StoreWaitDocumentLineSchema>;

const DocumentLinkSchema = z.object({ id: EntityIdSchema, code: z.string() }).strict();

export const StoreWaitDocumentSchema = z
  .object({
    id: EntityIdSchema,
    code: z.string(),
    storeId: EntityIdSchema,
    storeCode: z.string(),
    storeName: z.string(),
    status: StoreWaitDocumentStatusSchema,
    version: z.number().int().positive(),
    chainId: EntityIdSchema,
    chainSequence: z.number().int().positive(),
    openedAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.nullable(),
    /** Earliest wait of the open demand; never reset by a new document. */
    waitingSince: IsoDateTimeSchema,
    predecessor: DocumentLinkSchema.nullable(),
    successor: DocumentLinkSchema.nullable(),
    openedEvent: StoreWaitDocumentEventSchema,
    closedEvent: StoreWaitDocumentEventSchema.nullable(),
    lines: z.array(StoreWaitDocumentLineSchema).min(1),
  })
  .strict();
export type StoreWaitDocument = z.infer<typeof StoreWaitDocumentSchema>;

export const ListStoreWaitDocumentsResponseSchema = z
  .object({ data: z.array(StoreWaitDocumentSchema), pagination: PaginationMetaSchema })
  .strict();
export type ListStoreWaitDocumentsResponse = z.infer<typeof ListStoreWaitDocumentsResponseSchema>;

export const StoreWaitDocumentDetailSchema = StoreWaitDocumentSchema.extend({
  members: z.array(
    z
      .object({
        waitTicketId: EntityIdSchema,
        code: z.string(),
        productId: EntityIdSchema,
        status: z.enum(['ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED']),
        originalQuantity: QuantitySchema,
        remainingQuantity: QuantitySchema,
        fulfilledQuantity: QuantitySchema,
        queuedAt: IsoDateTimeSchema,
      })
      .strict(),
  ),
  /** Results still holding goods of the current document for the store's answer. */
  pendingResults: z.array(
    z
      .object({
        allocationDecisionId: EntityIdSchema,
        decisionVersion: z.number().int().positive(),
        session: z.object({ id: EntityIdSchema, code: z.string() }).strict(),
        productId: EntityIdSchema,
        quantity: QuantitySchema,
      })
      .strict(),
  ),
  chain: z.array(
    z
      .object({
        id: EntityIdSchema,
        code: z.string(),
        status: StoreWaitDocumentStatusSchema,
        chainSequence: z.number().int().positive(),
        openedAt: IsoDateTimeSchema,
        closedAt: IsoDateTimeSchema.nullable(),
        openedEventKind: StoreWaitDocumentEventKindSchema,
        closedEventKind: StoreWaitDocumentEventKindSchema.nullable(),
      })
      .strict(),
  ),
  /** The store's current document (where a processed document's demand went), if any. */
  currentDocument: DocumentLinkSchema.nullable(),
}).strict();
export type StoreWaitDocumentDetail = z.infer<typeof StoreWaitDocumentDetailSchema>;

export const StoreWaitDocumentDetailResponseSchema = z
  .object({ data: StoreWaitDocumentDetailSchema })
  .strict();

export const StoreWaitDocumentCancelPreviewSchema = z
  .object({
    documentId: EntityIdSchema,
    code: z.string(),
    storeId: EntityIdSchema,
    version: z.number().int().positive(),
    /** Every ticket line the cancellation cancels, with what it revokes and protects. */
    tickets: z.array(WaitTicketCancelPreviewSchema),
    /** Goods it cannot cancel: they only wait for the store's answer on their result. */
    awaitingAnswer: z.array(
      z
        .object({
          waitTicketId: EntityIdSchema,
          productId: EntityIdSchema,
          quantity: QuantitySchema,
        })
        .strict(),
    ),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type StoreWaitDocumentCancelPreview = z.infer<typeof StoreWaitDocumentCancelPreviewSchema>;

export const StoreWaitDocumentCancelPreviewResponseSchema = z
  .object({ data: StoreWaitDocumentCancelPreviewSchema })
  .strict();

export const CancelStoreWaitDocumentRequestSchema = z
  .object({
    reason: AuditReasonSchema,
    expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CancelStoreWaitDocumentRequest = z.infer<typeof CancelStoreWaitDocumentRequestSchema>;

export const CancelledStoreWaitDocumentSchema = z
  .object({
    documentId: EntityIdSchema,
    cancelledQuantity: QuantitySchema,
    revokedQuantity: QuantitySchema,
    /** The document holding what is left (goods awaiting an answer), or null. */
    currentDocumentId: EntityIdSchema.nullable(),
  })
  .strict();
export type CancelledStoreWaitDocument = z.infer<typeof CancelledStoreWaitDocumentSchema>;

export const CancelStoreWaitDocumentResponseSchema = z
  .object({ data: CancelledStoreWaitDocumentSchema })
  .strict();

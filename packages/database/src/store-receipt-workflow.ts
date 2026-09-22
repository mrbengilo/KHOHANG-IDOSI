import { and, eq, isNull, or } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  htkdAssignments,
  outboundRequestLines,
  outboundRequests,
  storeReceiptLines,
  storeReceipts,
  stores,
  users,
  type JsonObject,
} from './schema.js';
import { StoreOperationConflictError, StoreOperationValidationError } from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

export interface DeclareStoreReceiptLineInput {
  readonly productId: string;
  readonly approvedQuantity: number;
  readonly receivedQuantity: number;
}

export interface DeclareStoreReceiptInput {
  readonly outboundRequestId: string;
  readonly storeId: string;
  readonly declaredByUserId: string;
  readonly lines: readonly DeclareStoreReceiptLineInput[];
  readonly discrepancyNote?: string | null;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface SubmitStoreReceiptInput {
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly submittedByUserId: string;
  readonly lines: readonly DeclareStoreReceiptLineInput[];
  readonly discrepancyNote?: string | null;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ReturnStoreReceiptForCorrectionInput {
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly reviewedByUserId: string;
  readonly reason: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface StoreReceiptWorkflowResult {
  readonly receiptId: string;
  readonly status: 'draft' | 'pending_htkd' | 'returned';
  readonly version: number;
}

export interface DispatchedStoreReceiptLine {
  readonly productId: string;
  readonly approvedQuantity: number;
}

export class StoreReceiptAuthorizationError extends Error {
  public readonly code = 'STORE_RECEIPT_FORBIDDEN';

  public constructor(message = 'The account is not allowed to act on this store receipt.') {
    super(message);
    this.name = 'StoreReceiptAuthorizationError';
  }
}

/**
 * Validates the store declaration against server-owned dispatch quantities.
 * The current schema deliberately supports only full/short receipts. Wrong, excess, or
 * quarantined goods must not be coerced into an existing product line.
 */
export function validateStoreReceiptDeclaration(
  lines: readonly DeclareStoreReceiptLineInput[],
  dispatchedLines: readonly DispatchedStoreReceiptLine[],
  discrepancyNote?: string | null,
): void {
  if (
    lines.length === 0 ||
    dispatchedLines.length === 0 ||
    lines.length > 500 ||
    dispatchedLines.length > 500
  ) {
    throw new StoreOperationValidationError(
      'A store receipt must contain between 1 and 500 dispatched product lines.',
    );
  }

  const dispatchedByProduct = new Map<string, number>();
  for (const line of dispatchedLines) {
    if (
      line.productId.trim().length === 0 ||
      !Number.isSafeInteger(line.approvedQuantity) ||
      line.approvedQuantity <= 0 ||
      dispatchedByProduct.has(line.productId)
    ) {
      throw new StoreOperationValidationError('Dispatched receipt lines are invalid.');
    }
    dispatchedByProduct.set(line.productId, line.approvedQuantity);
  }

  const declaredProducts = new Set<string>();
  let hasShortage = false;
  for (const line of lines) {
    if (line.productId.trim().length === 0 || declaredProducts.has(line.productId)) {
      throw new StoreOperationValidationError('Receipt products must be non-blank and unique.');
    }
    declaredProducts.add(line.productId);

    if (
      !Number.isSafeInteger(line.approvedQuantity) ||
      line.approvedQuantity <= 0 ||
      !Number.isSafeInteger(line.receivedQuantity) ||
      line.receivedQuantity < 0
    ) {
      throw new StoreOperationValidationError(
        'Receipt quantities must be safe integers with a positive approved quantity.',
      );
    }

    const dispatchedQuantity = dispatchedByProduct.get(line.productId);
    if (
      dispatchedQuantity === undefined ||
      line.approvedQuantity !== dispatchedQuantity ||
      line.receivedQuantity > dispatchedQuantity
    ) {
      throw new StoreOperationValidationError(
        'Receipt lines must exactly match dispatched products and cannot declare excess goods.',
      );
    }
    hasShortage ||= line.receivedQuantity < dispatchedQuantity;
  }

  if (declaredProducts.size !== dispatchedByProduct.size) {
    throw new StoreOperationValidationError(
      'Receipt lines must exactly match every dispatched product.',
    );
  }

  const normalizedNote = normalizeOptionalNote(discrepancyNote, 'discrepancyNote', 1_000);
  if (hasShortage && normalizedNote === null) {
    throw new StoreOperationValidationError('A short receipt requires a discrepancy note.');
  }
}

export async function declareStoreReceipt(
  database: Database,
  input: DeclareStoreReceiptInput,
): Promise<IdempotencyResult<StoreReceiptWorkflowResult>> {
  return withIdempotency(
    database,
    {
      scope: `store-receipt.declare:${input.outboundRequestId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const declared = await declareStoreReceiptInTransaction(tx, input);
      return asIdempotentResult(declared, 201);
    },
  );
}

export async function declareStoreReceiptInTransaction(
  tx: Transaction,
  input: Omit<DeclareStoreReceiptInput, 'idempotencyKey' | 'requestHash'>,
): Promise<StoreReceiptWorkflowResult> {
  return withAdvisoryLock(tx, 'store-receipt-outbound', input.outboundRequestId, async () => {
    const [outbound] = await tx
      .select({
        id: outboundRequests.id,
        requestNumber: outboundRequests.requestNumber,
        storeId: outboundRequests.storeId,
        status: outboundRequests.status,
      })
      .from(outboundRequests)
      .where(
        and(eq(outboundRequests.id, input.outboundRequestId), isNull(outboundRequests.deletedAt)),
      )
      .for('update')
      .limit(1);

    if (!outbound || outbound.storeId !== input.storeId || outbound.status !== 'dispatched') {
      throw new StoreOperationConflictError(
        'The outbound request is missing, stale, or not ready for receipt declaration.',
      );
    }

    await assertStoreAccountMayDeclare(tx, input.declaredByUserId, input.storeId);

    const [existingReceipt] = await tx
      .select({ id: storeReceipts.id })
      .from(storeReceipts)
      .where(and(eq(storeReceipts.outboundRequestId, outbound.id), isNull(storeReceipts.deletedAt)))
      .limit(1);
    if (existingReceipt) {
      throw new StoreOperationConflictError('This outbound request already has a store receipt.');
    }

    const outboundLines = await tx
      .select({
        id: outboundRequestLines.id,
        productId: outboundRequestLines.productId,
        approvedQuantity: outboundRequestLines.approvedQuantity,
        dispatchedQuantity: outboundRequestLines.dispatchedQuantity,
      })
      .from(outboundRequestLines)
      .where(eq(outboundRequestLines.outboundRequestId, outbound.id))
      .orderBy(outboundRequestLines.productId)
      .for('update');

    const dispatchedLines = outboundLines.filter((line) => line.dispatchedQuantity > 0);
    if (
      outboundLines.some(
        (line) => line.approvedQuantity > 0 && line.approvedQuantity !== line.dispatchedQuantity,
      )
    ) {
      throw new StoreOperationValidationError(
        'A store receipt cannot be declared until all approved quantities are dispatched.',
      );
    }
    validateStoreReceiptDeclaration(
      input.lines,
      dispatchedLines.map((line) => ({
        productId: line.productId,
        approvedQuantity: line.dispatchedQuantity,
      })),
      input.discrepancyNote,
    );

    const declaredByProduct = new Map(input.lines.map((line) => [line.productId, line]));
    const now = new Date();
    const discrepancyNote = normalizeOptionalNote(input.discrepancyNote, 'discrepancyNote', 1_000);
    const [created] = await tx
      .insert(storeReceipts)
      .values({
        receiptNumber: `SR-${outbound.requestNumber}`,
        outboundRequestId: outbound.id,
        storeId: outbound.storeId,
        status: 'draft',
        discrepancyNote,
        declaredByUserId: input.declaredByUserId,
      })
      .returning({ id: storeReceipts.id, version: storeReceipts.version });
    if (!created) {
      throw new Error('Store receipt insert returned no row.');
    }

    await tx.insert(storeReceiptLines).values(
      dispatchedLines.map((line) => {
        const declared = declaredByProduct.get(line.productId);
        if (!declared) {
          throw new StoreOperationValidationError('A dispatched receipt product is missing.');
        }
        const shortage = line.dispatchedQuantity - declared.receivedQuantity;
        return {
          storeReceiptId: created.id,
          outboundRequestLineId: line.id,
          productId: line.productId,
          approvedQuantity: line.dispatchedQuantity,
          receivedQuantity: declared.receivedQuantity,
          shortageReason: shortage > 0 ? discrepancyNote : null,
        };
      }),
    );

    const result: StoreReceiptWorkflowResult = {
      receiptId: created.id,
      status: 'draft',
      version: created.version,
    };
    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.declaredByUserId,
      actorRole: 'store',
      actorStoreId: outbound.storeId,
      action: 'STORE_RECEIPT_DECLARED',
      entityType: 'store_receipt',
      entityId: created.id,
      after: {
        status: result.status,
        version: result.version,
        outboundRequestId: outbound.id,
        discrepancyNote,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          approvedQuantity: line.approvedQuantity,
          receivedQuantity: line.receivedQuantity,
        })),
      },
      createdAt: now,
    });

    return result;
  });
}

export async function submitStoreReceipt(
  database: Database,
  input: SubmitStoreReceiptInput,
): Promise<IdempotencyResult<StoreReceiptWorkflowResult>> {
  validateExpectedVersion(input.expectedVersion);
  return withIdempotency(
    database,
    {
      scope: `store-receipt.submit:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const submitted = await submitStoreReceiptInTransaction(tx, input);
      return asIdempotentResult(submitted, 200);
    },
  );
}

export async function submitStoreReceiptInTransaction(
  tx: Transaction,
  input: Omit<SubmitStoreReceiptInput, 'idempotencyKey' | 'requestHash'>,
): Promise<StoreReceiptWorkflowResult> {
  validateExpectedVersion(input.expectedVersion);
  return withAdvisoryLock(tx, 'store-receipt', input.receiptId, async () => {
    const [receipt] = await tx
      .select({
        id: storeReceipts.id,
        storeId: storeReceipts.storeId,
        status: storeReceipts.status,
        version: storeReceipts.version,
      })
      .from(storeReceipts)
      .where(and(eq(storeReceipts.id, input.receiptId), isNull(storeReceipts.deletedAt)))
      .for('update')
      .limit(1);
    if (
      !receipt ||
      (receipt.status !== 'draft' && receipt.status !== 'returned') ||
      receipt.version !== input.expectedVersion
    ) {
      throw new StoreOperationConflictError(
        'Store receipt is stale or cannot be submitted from its current status.',
      );
    }

    await assertStoreAccountMayDeclare(tx, input.submittedByUserId, receipt.storeId);
    const persistedLines = await tx
      .select({
        id: storeReceiptLines.id,
        productId: storeReceiptLines.productId,
        approvedQuantity: storeReceiptLines.approvedQuantity,
      })
      .from(storeReceiptLines)
      .where(eq(storeReceiptLines.storeReceiptId, receipt.id))
      .orderBy(storeReceiptLines.productId)
      .for('update');
    validateStoreReceiptDeclaration(input.lines, persistedLines, input.discrepancyNote);

    const discrepancyNote = normalizeOptionalNote(input.discrepancyNote, 'discrepancyNote', 1_000);
    const suppliedByProduct = new Map(input.lines.map((line) => [line.productId, line]));
    const now = new Date();
    for (const persistedLine of persistedLines) {
      const suppliedLine = suppliedByProduct.get(persistedLine.productId);
      if (!suppliedLine) {
        throw new StoreOperationValidationError('A persisted receipt product is missing.');
      }
      await tx
        .update(storeReceiptLines)
        .set({
          receivedQuantity: suppliedLine.receivedQuantity,
          shortageReason:
            suppliedLine.receivedQuantity < persistedLine.approvedQuantity ? discrepancyNote : null,
          pricePerKgVnd: null,
          goodsCostVnd: 0n,
          updatedAt: now,
        })
        .where(eq(storeReceiptLines.id, persistedLine.id));
    }

    const [submitted] = await tx
      .update(storeReceipts)
      .set({
        status: 'pending_htkd',
        discrepancyNote,
        reviewNote: null,
        declaredByUserId: input.submittedByUserId,
        reviewedByUserId: null,
        submittedAt: now,
        finalizedAt: null,
        goodsCostVnd: 0n,
        freightVnd: 0n,
        handlingVnd: 0n,
        totalCostVnd: 0n,
        version: receipt.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeReceipts.id, receipt.id),
          eq(storeReceipts.version, input.expectedVersion),
          or(eq(storeReceipts.status, 'draft'), eq(storeReceipts.status, 'returned')),
          isNull(storeReceipts.deletedAt),
        ),
      )
      .returning({ version: storeReceipts.version });
    if (!submitted) {
      throw new StoreOperationConflictError('Store receipt changed during submission.');
    }

    const result: StoreReceiptWorkflowResult = {
      receiptId: receipt.id,
      status: 'pending_htkd',
      version: submitted.version,
    };
    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.submittedByUserId,
      actorRole: 'store',
      actorStoreId: receipt.storeId,
      action: 'STORE_RECEIPT_SUBMITTED',
      entityType: 'store_receipt',
      entityId: receipt.id,
      before: { status: receipt.status, version: receipt.version },
      after: {
        status: result.status,
        version: result.version,
        discrepancyNote,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          approvedQuantity: line.approvedQuantity,
          receivedQuantity: line.receivedQuantity,
        })),
      },
    });

    return result;
  });
}

export async function returnStoreReceiptForCorrection(
  database: Database,
  input: ReturnStoreReceiptForCorrectionInput,
): Promise<IdempotencyResult<StoreReceiptWorkflowResult>> {
  validateExpectedVersion(input.expectedVersion);
  normalizeRequiredNote(input.reason, 'reason', 500);
  return withIdempotency(
    database,
    {
      scope: `store-receipt.return:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const returned = await returnStoreReceiptForCorrectionInTransaction(tx, input);
      return asIdempotentResult(returned, 200);
    },
  );
}

export async function returnStoreReceiptForCorrectionInTransaction(
  tx: Transaction,
  input: Omit<ReturnStoreReceiptForCorrectionInput, 'idempotencyKey' | 'requestHash'>,
): Promise<StoreReceiptWorkflowResult> {
  validateExpectedVersion(input.expectedVersion);
  const reason = normalizeRequiredNote(input.reason, 'reason', 500);
  return withAdvisoryLock(tx, 'store-receipt', input.receiptId, async () => {
    const [receipt] = await tx
      .select({
        id: storeReceipts.id,
        storeId: storeReceipts.storeId,
        status: storeReceipts.status,
        version: storeReceipts.version,
      })
      .from(storeReceipts)
      .where(and(eq(storeReceipts.id, input.receiptId), isNull(storeReceipts.deletedAt)))
      .for('update')
      .limit(1);
    if (
      !receipt ||
      receipt.status !== 'pending_htkd' ||
      receipt.version !== input.expectedVersion
    ) {
      throw new StoreOperationConflictError(
        'Store receipt is stale or is not awaiting HTKD review.',
      );
    }

    const reviewerRole = await assertReviewerMayAccessStore(
      tx,
      input.reviewedByUserId,
      receipt.storeId,
    );
    const now = new Date();
    const [returned] = await tx
      .update(storeReceipts)
      .set({
        status: 'returned',
        reviewedByUserId: input.reviewedByUserId,
        reviewNote: reason,
        version: receipt.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeReceipts.id, receipt.id),
          eq(storeReceipts.version, input.expectedVersion),
          eq(storeReceipts.status, 'pending_htkd'),
          isNull(storeReceipts.deletedAt),
        ),
      )
      .returning({ version: storeReceipts.version });
    if (!returned) {
      throw new StoreOperationConflictError('Store receipt changed during review.');
    }

    const result: StoreReceiptWorkflowResult = {
      receiptId: receipt.id,
      status: 'returned',
      version: returned.version,
    };
    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.reviewedByUserId,
      actorRole: reviewerRole,
      actorStoreId: receipt.storeId,
      action: 'STORE_RECEIPT_RETURNED',
      entityType: 'store_receipt',
      entityId: receipt.id,
      before: { status: receipt.status, version: receipt.version },
      after: { status: result.status, version: result.version, reason },
    });

    return result;
  });
}

async function assertStoreAccountMayDeclare(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id, kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!store) {
    throw new StoreReceiptAuthorizationError('The receipt store is inactive or deleted.');
  }

  const [user] = await tx
    .select({ role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active') {
    throw new StoreReceiptAuthorizationError();
  }
  // A store account speaks only for the store it belongs to. The wholesale desk has no
  // store of its own and speaks for every wholesale store, so its reach is bounded by the
  // store's kind instead - it can never touch a retail store this way.
  const mayDeclare =
    (user.role === 'store' && user.storeId === storeId) ||
    (user.role === 'wholesale' && store.kind === 'wholesale');
  if (!mayDeclare) {
    throw new StoreReceiptAuthorizationError();
  }
}

async function assertReviewerMayAccessStore(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<'admin' | 'htkd'> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!store) {
    throw new StoreReceiptAuthorizationError('The receipt store is inactive or deleted.');
  }

  const [user] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active' || (user.role !== 'admin' && user.role !== 'htkd')) {
    throw new StoreReceiptAuthorizationError('The reviewer must be an active admin or HTKD.');
  }
  if (user.role === 'admin') {
    return 'admin';
  }

  const [assignment] = await tx
    .select({ id: htkdAssignments.id })
    .from(htkdAssignments)
    .where(
      and(
        eq(htkdAssignments.userId, userId),
        eq(htkdAssignments.storeId, storeId),
        isNull(htkdAssignments.revokedAt),
      ),
    )
    .limit(1);
  if (!assignment) {
    throw new StoreReceiptAuthorizationError('The HTKD reviewer is not assigned to this store.');
  }
  return 'htkd';
}

function asIdempotentResult(
  result: StoreReceiptWorkflowResult,
  responseStatus: number,
): {
  readonly value: StoreReceiptWorkflowResult;
  readonly responseStatus: number;
  readonly responseBody: JsonObject;
  readonly resourceType: string;
  readonly resourceId: string;
} {
  return {
    value: result,
    responseStatus,
    responseBody: { ...result },
    resourceType: 'store_receipt',
    resourceId: result.receiptId,
  };
}

function validateExpectedVersion(expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new StoreOperationValidationError('expectedVersion must be a non-negative safe integer.');
  }
}

function normalizeOptionalNote(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeRequiredNote(value, field, maxLength);
}

function normalizeRequiredNote(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > maxLength) {
    throw new StoreOperationValidationError(
      `${field} must contain between 3 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

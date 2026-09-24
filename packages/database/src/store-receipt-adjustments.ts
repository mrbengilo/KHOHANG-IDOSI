import {
  applyReceiptMoneyDeltas,
  assessReceiptAdjustmentBag,
  canHoldReceiptAdjustmentBag,
  DomainError,
  OPEN_RECEIPT_ADJUSTMENT_STATUSES,
  planReceiptAdjustmentLine,
  planReceiptAdjustmentMoney,
  planReceiptAdjustmentTransition,
  type ReceiptAdjustmentAction,
  type ReceiptAdjustmentActorRole,
  type ReceiptAdjustmentBagBlocker,
  type ReceiptAdjustmentBagFacts,
  type ReceiptAdjustmentStatus,
  type ReceiptMoneyDelta,
  type ReceiptMoneyState,
  type ReceiptMoneyView,
} from '@idosi/domain';
import { and, asc, count, desc, eq, gte, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  allocationLines,
  auditLogs,
  dailyPriorityOffers,
  htkdAssignments,
  products,
  receiptShortageEntitlements,
  reservations,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storeOutbounds,
  storeReceiptAdjustmentLines,
  storeReceiptAdjustments,
  storeReceiptBags,
  storeReceiptLines,
  storeReceiptReturns,
  storeReceipts,
  stores,
  storeSortingEvents,
  storeTransfers,
  users,
  waitTickets,
  warehouseShortageChecks,
  type JsonObject,
} from './schema.js';
import { livePriorityOfferCondition } from './priority-offer-state.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationConflictError,
  StoreOperationValidationError,
  withStoreProductWaitLocks,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';
import { applyWarehouseMovement, WarehouseBalanceViolationError } from './warehouse.js';

type DatabaseStatus = typeof storeReceiptAdjustments.$inferSelect.status;
type ReturnStatus = typeof storeReceiptReturns.$inferSelect.status;
type BagStatus = typeof storeInventoryBags.$inferSelect.status;
type Reader = Database | Transaction;

const LINE_SOURCE = 'store_receipt_adjustment_line';
const RETURN_SOURCE = 'store_receipt_return';
/** Store ledger event sequences per adjustment line / return, so every write is replay-safe. */
const LINE_EVENT = { hold: 1, releaseOnClose: 2, reclassifyOut: 3, reclassifyIn: 4, keep: 5 };
const RETURN_EVENT = { hold: 1, handover: 2, releaseOnCancel: 3 };
const MAX_LINES = 50;

export class ReceiptAdjustmentAuthorizationError extends Error {
  public readonly code = 'RECEIPT_ADJUSTMENT_FORBIDDEN';

  public constructor(message = 'Tài khoản không có quyền thao tác trên hồ sơ sai lệch này.') {
    super(message);
    this.name = 'ReceiptAdjustmentAuthorizationError';
  }
}

/** Apply refused because a bag cannot be reclassified safely; details name each blocker. */
export class ReceiptAdjustmentBlockedError extends Error {
  public readonly code = 'RECEIPT_ADJUSTMENT_BLOCKED';

  public constructor(
    public readonly blockers: Readonly<Record<string, readonly ReceiptAdjustmentBagBlocker[]>>,
  ) {
    super('Chưa thể áp dụng: có bao đã phát sinh giao dịch cần đối soát trước.');
    this.name = 'ReceiptAdjustmentBlockedError';
  }
}

const statusToDomain: Record<DatabaseStatus, ReceiptAdjustmentStatus> = {
  pending_htkd: 'PENDING_HTKD',
  needs_info: 'NEEDS_INFO',
  pending_admin: 'PENDING_ADMIN',
  applied: 'APPLIED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
};
const statusFromDomain = Object.fromEntries(
  Object.entries(statusToDomain).map(([key, value]) => [value, key]),
) as Record<ReceiptAdjustmentStatus, DatabaseStatus>;
const OPEN_DATABASE_STATUSES = OPEN_RECEIPT_ADJUSTMENT_STATUSES.map(
  (status) => statusFromDomain[status],
);

// ---------------------------------------------------------------------------------------------
// Inputs and records
// ---------------------------------------------------------------------------------------------

export interface ReportedAdjustmentLineInput {
  readonly receiptBagId: string;
  readonly actualProductId: string;
  readonly disposition: 'keep' | 'return';
}

export interface CreateReceiptAdjustmentInput {
  readonly receiptId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly evidenceNote: string | null;
  readonly discoveredAt: Date;
  readonly lines: readonly ReportedAdjustmentLineInput[];
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface VerifiedAdjustmentLineInput {
  readonly receiptBagId: string;
  readonly actualProductId: string;
  readonly weightKg: string;
  readonly pricePerKgVnd: bigint;
  readonly weightChangeNote: string | null;
}

export type ReceiptAdjustmentTransitionInput = {
  readonly adjustmentId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
} & (
  | {
      readonly action: 'RESUBMIT';
      readonly reason: string;
      readonly evidenceNote: string | null;
      readonly discoveredAt: Date;
      readonly lines: readonly ReportedAdjustmentLineInput[];
    }
  | {
      readonly action: 'VERIFY';
      readonly cause: 'source_misclassification' | 'warehouse_mispick';
      readonly note: string;
      readonly lines: readonly VerifiedAdjustmentLineInput[];
      readonly freightDeltaVnd: bigint;
      readonly handlingDeltaVnd: bigint;
      readonly vatDeltaVnd: bigint;
    }
  | {
      readonly action: 'CANCEL' | 'REQUEST_INFO' | 'RETURN_TO_VERIFIER' | 'REJECT';
      readonly note: string;
    }
  | { readonly action: 'APPLY'; readonly note: string | null }
);

export interface ReceiptAdjustmentMutationResult {
  readonly adjustmentId: string;
  readonly status: DatabaseStatus;
  readonly version: number;
}

export interface EntitlementProgress {
  readonly waitTicketId: string;
  readonly waitTicketCode: string;
  readonly waitMode: 'created' | 'merged';
  readonly quantity: number;
  readonly productId: string;
  readonly waitStatus: typeof waitTickets.$inferSelect.status;
  readonly waitRemainingQuantity: number;
  readonly waitFulfilledQuantity: number;
  readonly hasOpenOffer: boolean;
  /** Ticket-level allocations since the right was granted, by where the goods are now. */
  readonly heldQuantity: number;
  readonly shippingQuantity: number;
  readonly receivedQuantity: number;
  readonly createdAt: Date;
}

export interface ReceiptReturnRecord {
  readonly id: string;
  readonly code: string;
  readonly adjustmentId: string;
  readonly adjustmentCode: string;
  readonly adjustmentLineId: string;
  readonly storeId: string;
  readonly inventoryBagId: string;
  readonly bagDisplayCode: string;
  readonly productId: string;
  readonly quantity: number;
  readonly weightKg: string;
  readonly costVnd: bigint;
  readonly status: ReturnStatus;
  readonly version: number;
  readonly reason: string;
  readonly createdByUserId: string;
  readonly handedOverByUserId: string | null;
  readonly handedOverAt: Date | null;
  readonly receivedByUserId: string | null;
  readonly receivedAt: Date | null;
  readonly receivedQuantity: number | null;
  readonly receiveNote: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
  readonly cancelledByUserId: string | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReceiptAdjustmentLineRecord {
  readonly id: string;
  readonly receiptBagId: string;
  readonly receiptBagNumber: number;
  readonly inventoryBagId: string;
  readonly bagDisplayCode: string;
  readonly bagStatus: BagStatus;
  readonly bagCurrentWeightKg: string;
  readonly approvedProductId: string | null;
  readonly recordedProductId: string;
  readonly actualProductId: string;
  readonly disposition: 'keep' | 'return';
  readonly recordedWeightKg: string;
  readonly recordedPricePerKgVnd: bigint;
  readonly recordedCostVnd: bigint;
  readonly verifiedWeightKg: string | null;
  readonly verifiedPricePerKgVnd: bigint | null;
  readonly verifiedCostVnd: bigint | null;
  readonly weightChangeNote: string | null;
  readonly shortageQuantity: number;
  readonly holdState: typeof storeReceiptAdjustmentLines.$inferSelect.holdState;
  /** Live dependency check; empty for closed documents. */
  readonly blockers: readonly ReceiptAdjustmentBagBlocker[];
  readonly entitlement: EntitlementProgress | null;
  readonly returns: readonly ReceiptReturnRecord[];
}

export interface ReceiptAdjustmentRecord {
  readonly id: string;
  readonly code: string;
  readonly receiptId: string;
  readonly receiptNumber: string;
  readonly receiptFinalizedAt: Date | null;
  readonly storeId: string;
  readonly status: DatabaseStatus;
  readonly version: number;
  readonly reason: string;
  readonly evidenceNote: string | null;
  readonly discoveredAt: Date;
  readonly cause: typeof storeReceiptAdjustments.$inferSelect.cause;
  readonly baseAppliedCount: number;
  readonly appliedSequence: number | null;
  readonly goodsDeltaVnd: bigint;
  readonly freightDeltaVnd: bigint;
  readonly handlingDeltaVnd: bigint;
  readonly vatDeltaVnd: bigint;
  /** Receipt money: original, effective before this document, and after it (null until verified). */
  readonly money: {
    readonly original: ReceiptMoneyView;
    readonly before: ReceiptMoneyView;
    readonly after: ReceiptMoneyView | null;
  };
  readonly reportedByUserId: string;
  readonly reportedAt: Date;
  readonly verifiedByUserId: string | null;
  readonly verifiedAt: Date | null;
  readonly verificationNote: string | null;
  readonly infoRequestNote: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly appliedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lines: readonly ReceiptAdjustmentLineRecord[];
}

export interface ReceiptAdjustmentSummaryRecord {
  readonly id: string;
  readonly code: string;
  readonly receiptId: string;
  readonly receiptNumber: string;
  readonly storeId: string;
  readonly status: DatabaseStatus;
  readonly version: number;
  readonly reason: string;
  readonly lineCount: number;
  readonly shortageQuantity: number;
  readonly goodsDeltaVnd: bigint;
  readonly reportedAt: Date;
  readonly appliedAt: Date | null;
  readonly updatedAt: Date;
}

export interface ReceiptAdjustmentContextBag {
  readonly receiptBagId: string;
  readonly receiptLineId: string;
  readonly bagNumber: number;
  readonly inventoryBagId: string | null;
  readonly bagDisplayCode: string | null;
  readonly bagStatus: BagStatus | null;
  readonly currentWeightKg: string | null;
  readonly approvedProductId: string | null;
  readonly effectiveProductId: string;
  readonly effectiveWeightKg: string;
  readonly effectivePricePerKgVnd: bigint;
  readonly effectiveCostVnd: bigint;
  readonly shortageGranted: boolean;
  readonly openAdjustmentId: string | null;
  readonly openReturnId: string | null;
  /** Transactions already booked on the bag; reported now, enforced when applying. */
  readonly dependencies: readonly ReceiptAdjustmentBagBlocker[];
}

export interface ReceiptAdjustmentContext {
  readonly receiptId: string;
  readonly receiptNumber: string;
  readonly storeId: string;
  readonly receiptStatus: typeof storeReceipts.$inferSelect.status;
  readonly finalizedAt: Date | null;
  readonly money: { readonly original: ReceiptMoneyView; readonly effective: ReceiptMoneyView };
  readonly appliedCount: number;
  readonly bags: readonly ReceiptAdjustmentContextBag[];
}

export interface ReceiptAdjustmentMoneySummary {
  readonly appliedCount: number;
  readonly openCount: number;
  readonly original: ReceiptMoneyView;
  readonly effective: ReceiptMoneyView;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export async function createReceiptAdjustment(
  database: Database,
  input: CreateReceiptAdjustmentInput,
): Promise<IdempotencyResult<ReceiptAdjustmentMutationResult>> {
  const reason = requiredNote(input.reason, 'Lý do', 1_000);
  const evidenceNote = optionalNote(input.evidenceNote, 'Bằng chứng', 2_000);
  validateReportedLines(input.lines);
  validateDiscoveredAt(input.discoveredAt);
  return withIdempotency(
    database,
    {
      scope: `receipt-adjustment.create:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-receipt-adjustment', input.receiptId, async () => {
        const receipt = await loadFinalizedReceipt(tx, input.receiptId);
        await resolveActor(tx, input.actorUserId, receipt.storeId, ['STORE']);
        if (receipt.finalizedAt && input.discoveredAt < receipt.finalizedAt) {
          throw new StoreOperationValidationError(
            'Thời điểm phát hiện không được trước thời điểm chốt phiếu.',
          );
        }
        await assertActiveProducts(
          tx,
          input.lines.map((line) => line.actualProductId),
        );
        const states = await loadEffectiveBagStates(tx, receipt.id);
        const byReceiptBag = new Map(states.map((state) => [state.receiptBagId, state]));
        const selected = input.lines.map((line) => {
          const state = byReceiptBag.get(line.receiptBagId);
          if (!state || !state.inventoryBagId) {
            throw new StoreOperationValidationError('Bao được chọn không thuộc phiếu nhận này.');
          }
          return { line, state, inventoryBagId: state.inventoryBagId };
        });
        const now = new Date();
        const appliedCount = await countApplied(tx, receipt.id);
        const [created] = await tx
          .insert(storeReceiptAdjustments)
          .values({
            storeReceiptId: receipt.id,
            storeId: receipt.storeId,
            status: 'pending_htkd',
            reason,
            evidenceNote,
            discoveredAt: input.discoveredAt,
            baseAppliedCount: appliedCount,
            reportedByUserId: input.actorUserId,
            reportedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storeReceiptAdjustments.id, code: storeReceiptAdjustments.code });
        if (!created) throw new Error('Receipt adjustment insert returned no row.');

        const lineSnapshots: JsonObject[] = [];
        for (const { line, state, inventoryBagId } of sortByBag(selected)) {
          await withAdvisoryLock(tx, 'store-inventory-bag', inventoryBagId, async () => {
            const bag = await lockInventoryBag(tx, inventoryBagId);
            if (bag.storeId !== receipt.storeId) throw new ReceiptAdjustmentAuthorizationError();
            await assertBagNotInOpenDocument(tx, state.receiptBagId, inventoryBagId);
            // Planning with neutral money validates the SKU rules before anything is written.
            planLineOrThrow({
              approvedProductId: state.approvedProductId,
              recordedProductId: state.effectiveProductId,
              actualProductId: line.actualProductId,
              recordedWeightKg: state.effectiveWeightKg,
              recordedCostVnd: state.effectiveCostVnd,
              verifiedWeightKg: state.effectiveWeightKg,
              verifiedPricePerKgVnd: state.effectivePricePerKgVnd,
              shortageAlreadyGranted: state.shortageGranted,
            });
            const hold = canHoldReceiptAdjustmentBag(bag.status);
            const [inserted] = await tx
              .insert(storeReceiptAdjustmentLines)
              .values({
                adjustmentId: created.id,
                storeReceiptLineId: state.receiptLineId,
                storeReceiptBagId: state.receiptBagId,
                storeInventoryBagId: inventoryBagId,
                approvedProductId: state.approvedProductId,
                recordedProductId: state.effectiveProductId,
                actualProductId: line.actualProductId,
                disposition: line.disposition,
                recordedWeightKg: state.effectiveWeightKg,
                recordedPricePerKgVnd: state.effectivePricePerKgVnd,
                recordedCostVnd: state.effectiveCostVnd,
                holdState: hold ? 'held' : 'none',
                holdPreviousStatus: hold ? bag.status : null,
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: storeReceiptAdjustmentLines.id });
            if (!inserted) throw new Error('Adjustment line insert returned no row.');
            if (hold) {
              await setBagHold(tx, {
                bag,
                status: 'quarantined',
                eventType: 'quarantine',
                sourceType: LINE_SOURCE,
                sourceId: inserted.id,
                eventSequence: LINE_EVENT.hold,
                reason: `Tạm giữ theo hồ sơ sai lệch ${created.code}`,
                actorUserId: input.actorUserId,
                now,
              });
            }
            lineSnapshots.push({
              receiptBagId: state.receiptBagId,
              inventoryBagId,
              recordedProductId: state.effectiveProductId,
              actualProductId: line.actualProductId,
              disposition: line.disposition,
              held: hold,
            });
          });
        }

        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: input.actorUserId,
          actorRole: 'store',
          actorStoreId: receipt.storeId,
          action: 'RECEIPT_ADJUSTMENT_REPORTED',
          entityType: 'store_receipt_adjustment',
          entityId: created.id,
          after: {
            status: 'pending_htkd',
            version: 0,
            code: created.code,
            receiptId: receipt.id,
            reason,
            evidenceNote,
            discoveredAt: input.discoveredAt.toISOString(),
            lines: lineSnapshots,
          },
        });
        return mutationResult(
          { adjustmentId: created.id, status: 'pending_htkd', version: 0 },
          201,
        );
      }),
  );
}

export async function transitionReceiptAdjustment(
  database: Database,
  input: ReceiptAdjustmentTransitionInput,
): Promise<IdempotencyResult<ReceiptAdjustmentMutationResult>> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new StoreOperationValidationError('expectedVersion không hợp lệ.');
  }
  validateTransitionInput(input);
  return withIdempotency(
    database,
    {
      scope: `receipt-adjustment.${input.action.toLowerCase()}:${input.adjustmentId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const [located] = await tx
        .select({ receiptId: storeReceiptAdjustments.storeReceiptId })
        .from(storeReceiptAdjustments)
        .where(eq(storeReceiptAdjustments.id, input.adjustmentId))
        .limit(1);
      if (!located) throw new StoreOperationValidationError('Không tìm thấy hồ sơ sai lệch.');
      // Every command on any adjustment of a receipt is serialized by the same receipt lock, so
      // applied sequences and effective values are computed against a stable base.
      return withAdvisoryLock(tx, 'store-receipt-adjustment', located.receiptId, async () => {
        const [adjustment] = await tx
          .select()
          .from(storeReceiptAdjustments)
          .where(eq(storeReceiptAdjustments.id, input.adjustmentId))
          .for('update')
          .limit(1);
        if (!adjustment) throw new StoreOperationValidationError('Không tìm thấy hồ sơ sai lệch.');
        const actor = await resolveActor(tx, input.actorUserId, adjustment.storeId, [
          'ADMIN',
          'HTKD',
          'STORE',
        ]);
        if (adjustment.version !== input.expectedVersion) {
          throw new StoreOperationConflictError('Hồ sơ sai lệch đã thay đổi; hãy tải lại.');
        }
        const next = planTransition(adjustment.status, input.action, actor.role);
        const now = new Date();
        const context: TransitionContext = { tx, adjustment, actor, now, next, input };
        switch (input.action) {
          case 'RESUBMIT':
            await resubmit(context, input);
            break;
          case 'VERIFY':
            await verify(context, input);
            break;
          case 'APPLY':
            await apply(context, input.note);
            break;
          case 'CANCEL':
          case 'REJECT':
            await close(context, input.note);
            break;
          case 'REQUEST_INFO':
          case 'RETURN_TO_VERIFIER':
            await sendBack(context, input.note);
            break;
        }
        return mutationResult(
          { adjustmentId: adjustment.id, status: next, version: adjustment.version + 1 },
          200,
        );
      });
    },
  );
}

interface TransitionContext {
  readonly tx: Transaction;
  readonly adjustment: typeof storeReceiptAdjustments.$inferSelect;
  readonly actor: ResolvedActor;
  readonly now: Date;
  readonly next: DatabaseStatus;
  readonly input: ReceiptAdjustmentTransitionInput;
}

async function resubmit(
  context: TransitionContext,
  input: Extract<ReceiptAdjustmentTransitionInput, { action: 'RESUBMIT' }>,
): Promise<void> {
  const { tx, adjustment, now } = context;
  const reason = requiredNote(input.reason, 'Lý do', 1_000);
  const evidenceNote = optionalNote(input.evidenceNote, 'Bằng chứng', 2_000);
  const lines = await loadLines(tx, adjustment.id);
  const supplied = new Map(input.lines.map((line) => [line.receiptBagId, line]));
  if (
    supplied.size !== lines.length ||
    lines.some((line) => !supplied.has(line.storeReceiptBagId))
  ) {
    throw new StoreOperationValidationError(
      'Bổ sung hồ sơ phải giữ nguyên danh sách bao; hãy hủy và báo hồ sơ mới nếu cần đổi bao.',
    );
  }
  await assertActiveProducts(
    tx,
    input.lines.map((line) => line.actualProductId),
  );
  const granted = await grantedReceiptBags(
    tx,
    lines.map((line) => line.storeReceiptBagId),
  );
  for (const line of lines) {
    const next = supplied.get(line.storeReceiptBagId)!;
    planLineOrThrow({
      approvedProductId: line.approvedProductId,
      recordedProductId: line.recordedProductId,
      actualProductId: next.actualProductId,
      recordedWeightKg: line.recordedWeightKg,
      recordedCostVnd: line.recordedCostVnd,
      verifiedWeightKg: line.recordedWeightKg,
      verifiedPricePerKgVnd: line.recordedPricePerKgVnd,
      shortageAlreadyGranted: granted.has(line.storeReceiptBagId),
    });
    await tx
      .update(storeReceiptAdjustmentLines)
      .set({
        actualProductId: next.actualProductId,
        disposition: next.disposition,
        verifiedWeightKg: null,
        verifiedPricePerKgVnd: null,
        verifiedCostVnd: null,
        weightChangeNote: null,
        shortageQuantity: 0,
        updatedAt: now,
      })
      .where(eq(storeReceiptAdjustmentLines.id, line.id));
  }
  await updateHeader(context, {
    reason,
    evidenceNote,
    discoveredAt: input.discoveredAt,
    ...clearedVerification,
  });
  await audit(context, 'RECEIPT_ADJUSTMENT_RESUBMITTED', {
    reason,
    evidenceNote,
    discoveredAt: input.discoveredAt.toISOString(),
    lines: input.lines.map((line) => ({ ...line })),
  });
}

const clearedVerification = {
  cause: null,
  verification: null,
  verifiedByUserId: null,
  verifiedAt: null,
  verificationNote: null,
  goodsDeltaVnd: 0n,
  freightDeltaVnd: 0n,
  handlingDeltaVnd: 0n,
  vatDeltaVnd: 0n,
} as const;

async function verify(
  context: TransitionContext,
  input: Extract<ReceiptAdjustmentTransitionInput, { action: 'VERIFY' }>,
): Promise<void> {
  const { tx, adjustment, now } = context;
  const note = requiredNote(input.note, 'Ghi chú xác minh', 1_000);
  const lines = await loadLines(tx, adjustment.id);
  const supplied = new Map(input.lines.map((line) => [line.receiptBagId, line]));
  if (
    supplied.size !== lines.length ||
    lines.some((line) => !supplied.has(line.storeReceiptBagId))
  ) {
    throw new StoreOperationValidationError('Cần xác minh đủ từng bao trong hồ sơ.');
  }
  await assertActiveProducts(
    tx,
    input.lines.map((line) => line.actualProductId),
  );
  const granted = await grantedReceiptBags(
    tx,
    lines.map((line) => line.storeReceiptBagId),
  );
  let goodsDeltaVnd = 0n;
  const verifiedLines: JsonObject[] = [];
  const blockers: Record<string, ReceiptAdjustmentBagBlocker[]> = {};
  for (const line of lines) {
    const verified = supplied.get(line.storeReceiptBagId)!;
    const recordedGrams = kilogramsToGramsExact(line.recordedWeightKg);
    const verifiedGrams = kilogramsToGramsExact(verified.weightKg);
    const weightChangeNote = optionalNote(verified.weightChangeNote, 'Căn cứ cân lại', 500);
    if (verifiedGrams !== recordedGrams && weightChangeNote === null) {
      throw new StoreOperationValidationError(
        'Chỉ đổi kg khi có căn cứ cân lại; hãy ghi căn cứ cho bao có kg thay đổi.',
      );
    }
    const plan = planLineOrThrow({
      approvedProductId: line.approvedProductId,
      recordedProductId: line.recordedProductId,
      actualProductId: verified.actualProductId,
      recordedWeightKg: line.recordedWeightKg,
      recordedCostVnd: line.recordedCostVnd,
      verifiedWeightKg: verified.weightKg,
      verifiedPricePerKgVnd: verified.pricePerKgVnd,
      shortageAlreadyGranted: granted.has(line.storeReceiptBagId),
    });
    goodsDeltaVnd += plan.goodsDeltaVnd;
    await tx
      .update(storeReceiptAdjustmentLines)
      .set({
        actualProductId: verified.actualProductId,
        verifiedWeightKg: gramsToKilogramsExact(verifiedGrams),
        verifiedPricePerKgVnd: verified.pricePerKgVnd,
        verifiedCostVnd: plan.verifiedCostVnd,
        weightChangeNote: verifiedGrams === recordedGrams ? null : weightChangeNote,
        shortageQuantity: plan.shortageQuantity,
        updatedAt: now,
      })
      .where(eq(storeReceiptAdjustmentLines.id, line.id));
    const facts = await bagFacts(tx, line, adjustment.id);
    const found = assessReceiptAdjustmentBag(facts);
    if (found.length > 0) blockers[line.storeReceiptBagId] = found;
    verifiedLines.push({
      receiptBagId: line.storeReceiptBagId,
      recordedProductId: line.recordedProductId,
      actualProductId: verified.actualProductId,
      recordedWeightKg: line.recordedWeightKg,
      verifiedWeightKg: gramsToKilogramsExact(verifiedGrams),
      recordedCostVnd: line.recordedCostVnd.toString(),
      verifiedCostVnd: plan.verifiedCostVnd.toString(),
      goodsDeltaVnd: plan.goodsDeltaVnd.toString(),
      shortageQuantity: plan.shortageQuantity,
      disposition: line.disposition,
    });
  }
  const receipt = await loadFinalizedReceipt(tx, adjustment.storeReceiptId);
  const appliedCount = await countApplied(tx, receipt.id);
  const before = await effectiveMoney(tx, receipt);
  const delta: ReceiptMoneyDelta = {
    goodsVnd: goodsDeltaVnd,
    freightVnd: input.freightDeltaVnd,
    handlingVnd: input.handlingDeltaVnd,
    vatVnd: input.vatDeltaVnd,
  };
  const money = domainOrValidation(() => planReceiptAdjustmentMoney(before, delta));
  const verification: JsonObject = {
    money: {
      before: moneyJson(money.before),
      delta: {
        goodsVnd: delta.goodsVnd.toString(),
        freightVnd: delta.freightVnd.toString(),
        handlingVnd: delta.handlingVnd.toString(),
        vatVnd: delta.vatVnd.toString(),
        costVnd: money.delta.costVnd.toString(),
        totalVnd: money.delta.totalVnd.toString(),
      },
      after: moneyJson(money.after),
    },
    baseAppliedCount: appliedCount,
    cause: input.cause,
    lines: verifiedLines,
    blockers,
  };
  await updateHeader(context, {
    cause: input.cause,
    verification,
    baseAppliedCount: appliedCount,
    verifiedByUserId: context.actor.userId,
    verifiedAt: now,
    verificationNote: note,
    infoRequestNote: null,
    goodsDeltaVnd: delta.goodsVnd,
    freightDeltaVnd: delta.freightVnd,
    handlingDeltaVnd: delta.handlingVnd,
    vatDeltaVnd: delta.vatVnd,
  });
  await audit(context, 'RECEIPT_ADJUSTMENT_VERIFIED', { note, ...verification });
}

async function sendBack(context: TransitionContext, rawNote: string): Promise<void> {
  const note = requiredNote(rawNote, 'Nội dung yêu cầu', 1_000);
  await updateHeader(context, {
    ...clearedVerification,
    infoRequestNote: context.next === 'needs_info' ? note : context.adjustment.infoRequestNote,
  });
  await audit(
    context,
    context.input.action === 'REQUEST_INFO'
      ? 'RECEIPT_ADJUSTMENT_INFO_REQUESTED'
      : 'RECEIPT_ADJUSTMENT_RETURNED_TO_VERIFIER',
    { note },
  );
}

/** Rejecting or cancelling frees only the bags this document itself holds. */
async function close(context: TransitionContext, rawNote: string): Promise<void> {
  const { tx, adjustment, now } = context;
  const note = requiredNote(rawNote, 'Lý do', 1_000);
  const lines = await loadLines(tx, adjustment.id);
  const released: string[] = [];
  for (const line of sortLinesByBag(lines)) {
    if (line.holdState !== 'held') continue;
    await withAdvisoryLock(tx, 'store-inventory-bag', line.storeInventoryBagId, async () => {
      const bag = await lockInventoryBag(tx, line.storeInventoryBagId);
      if (bag.status !== 'quarantined' || line.holdPreviousStatus === null) {
        throw new StoreOperationConflictError('Bao đang giữ đã bị thay đổi ngoài hồ sơ.');
      }
      await setBagHold(tx, {
        bag,
        status: line.holdPreviousStatus,
        eventType: 'release',
        sourceType: LINE_SOURCE,
        sourceId: line.id,
        eventSequence: LINE_EVENT.releaseOnClose,
        reason: `Gỡ giữ hàng: hồ sơ ${adjustment.code} ${context.next === 'rejected' ? 'bị từ chối' : 'đã hủy'}`,
        actorUserId: context.actor.userId,
        now,
      });
      await tx
        .update(storeReceiptAdjustmentLines)
        .set({ holdState: 'released', updatedAt: now })
        .where(eq(storeReceiptAdjustmentLines.id, line.id));
      released.push(line.storeInventoryBagId);
    });
  }
  await updateHeader(context, {
    decidedByUserId: context.actor.userId,
    decidedAt: now,
    decisionNote: note,
  });
  await audit(
    context,
    context.next === 'rejected' ? 'RECEIPT_ADJUSTMENT_REJECTED' : 'RECEIPT_ADJUSTMENT_CANCELLED',
    { note, releasedInventoryBagIds: released },
  );
}

/**
 * One transaction: reclassify the bags, book the approved money delta, grant the missing
 * approved SKU as a P0B wait, correct the warehouse for a verified mispick, move held bags to
 * a return document or back to sale, and audit. Any failure rolls every part back.
 */
async function apply(context: TransitionContext, rawNote: string | null): Promise<void> {
  const { tx, adjustment, now, actor } = context;
  const note = optionalNote(rawNote, 'Ghi chú duyệt', 1_000);
  if (!adjustment.cause || !adjustment.verification) {
    throw new StoreOperationConflictError('Hồ sơ chưa được xác minh.');
  }
  const receipt = await loadFinalizedReceipt(tx, adjustment.storeReceiptId);
  const appliedCount = await countApplied(tx, receipt.id);
  if (appliedCount !== adjustment.baseAppliedCount) {
    throw new StoreOperationConflictError(
      'Phiếu nhận đã có điều chỉnh khác được áp dụng sau khi xác minh; cần HTKD xác minh lại.',
    );
  }
  const before = await effectiveMoney(tx, receipt);
  const money = domainOrValidation(() =>
    planReceiptAdjustmentMoney(before, {
      goodsVnd: adjustment.goodsDeltaVnd,
      freightVnd: adjustment.freightDeltaVnd,
      handlingVnd: adjustment.handlingDeltaVnd,
      vatVnd: adjustment.vatDeltaVnd,
    }),
  );

  const lines = sortLinesByBag(await loadLines(tx, adjustment.id));
  const granted = await grantedReceiptBags(
    tx,
    lines.map((line) => line.storeReceiptBagId),
  );
  const blockers: Record<string, ReceiptAdjustmentBagBlocker[]> = {};
  const bags = new Map<string, InventoryBagRow>();
  // Lock every bag first, in one order, and re-check dependencies inside the transaction.
  const lockAll = async (index: number): Promise<void> => {
    const line = lines[index];
    if (!line) return;
    await withAdvisoryLock(tx, 'store-inventory-bag', line.storeInventoryBagId, async () => {
      bags.set(line.storeInventoryBagId, await lockInventoryBag(tx, line.storeInventoryBagId));
      const found = assessReceiptAdjustmentBag(await bagFacts(tx, line, adjustment.id));
      if (found.length > 0) blockers[line.storeReceiptBagId] = found;
      await lockAll(index + 1);
    });
  };
  await lockAll(0);
  if (Object.keys(blockers).length > 0) throw new ReceiptAdjustmentBlockedError(blockers);

  const entitlements: JsonObject[] = [];
  const returnsCreated: JsonObject[] = [];
  const warehouseMovements: JsonObject[] = [];
  for (const line of lines) {
    const bag = bags.get(line.storeInventoryBagId)!;
    if (
      line.verifiedCostVnd === null ||
      line.verifiedWeightKg === null ||
      line.verifiedPricePerKgVnd === null
    ) {
      throw new StoreOperationConflictError('Bao chưa được xác minh kg và giá.');
    }
    if (line.shortageQuantity > 0 && granted.has(line.storeReceiptBagId)) {
      throw new StoreOperationConflictError('Quyền chờ bù của bao này đã được ghi nhận.');
    }
    const weightKg = gramsToKilogramsExact(kilogramsToGramsExact(line.verifiedWeightKg));
    const keep = line.disposition === 'keep';
    const [updated] = await tx
      .update(storeInventoryBags)
      .set({
        productId: line.actualProductId,
        costVnd: line.verifiedCostVnd,
        initialWeightKg: weightKg,
        currentWeightKg: weightKg,
        status: keep ? line.holdPreviousStatus! : 'quarantined',
        version: bag.version + 1,
        updatedAt: now,
      })
      .where(and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)))
      .returning({ id: storeInventoryBags.id });
    if (!updated) throw new StoreOperationConflictError('Bao đã thay đổi trong khi áp dụng.');
    // The old SKU leaves and the verified SKU enters on the same physical bag: per-SKU ledger
    // sums stay equal to current bag weights and no second stock bag is created.
    await tx.insert(storeInventoryLedgerEntries).values([
      {
        storeInventoryBagId: bag.id,
        storeId: bag.storeId,
        productId: line.recordedProductId,
        eventType: 'adjust',
        weightBeforeKg: bag.currentWeightKg,
        weightAfterKg: '0.000',
        sourceType: LINE_SOURCE,
        sourceId: line.id,
        eventSequence: LINE_EVENT.reclassifyOut,
        reason: `Phân loại lại theo ${adjustment.code}: ghi giảm mặt hàng đã ghi nhận`,
        metadata: { adjustmentId: adjustment.id, receiptBagId: line.storeReceiptBagId },
        actorUserId: actor.userId,
        occurredAt: now,
      },
      {
        storeInventoryBagId: bag.id,
        storeId: bag.storeId,
        productId: line.actualProductId,
        eventType: 'adjust',
        weightBeforeKg: '0.000',
        weightAfterKg: weightKg,
        sourceType: LINE_SOURCE,
        sourceId: line.id,
        eventSequence: LINE_EVENT.reclassifyIn,
        reason: `Phân loại lại theo ${adjustment.code}: ghi tăng mặt hàng thực tế`,
        metadata: { adjustmentId: adjustment.id, receiptBagId: line.storeReceiptBagId },
        actorUserId: actor.userId,
        occurredAt: now,
      },
      ...(keep
        ? [
            {
              storeInventoryBagId: bag.id,
              storeId: bag.storeId,
              productId: line.actualProductId,
              eventType: 'release' as const,
              weightBeforeKg: weightKg,
              weightAfterKg: weightKg,
              sourceType: LINE_SOURCE,
              sourceId: line.id,
              eventSequence: LINE_EVENT.keep,
              reason: `Cửa hàng giữ bán theo ${adjustment.code}`,
              metadata: {},
              actorUserId: actor.userId,
              occurredAt: now,
            },
          ]
        : []),
    ]);
    await tx
      .update(storeReceiptAdjustmentLines)
      .set({ holdState: keep ? 'released' : 'returning', updatedAt: now })
      .where(eq(storeReceiptAdjustmentLines.id, line.id));

    if (!keep) {
      const [created] = await tx
        .insert(storeReceiptReturns)
        .values({
          adjustmentLineId: line.id,
          storeId: bag.storeId,
          storeInventoryBagId: bag.id,
          productId: line.actualProductId,
          weightKg,
          costVnd: line.verifiedCostVnd,
          reason: adjustment.reason,
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: storeReceiptReturns.id, code: storeReceiptReturns.code });
      if (!created) throw new Error('Receipt return insert returned no row.');
      returnsCreated.push({ returnId: created.id, code: created.code, inventoryBagId: bag.id });
    }

    if (line.shortageQuantity > 0) {
      entitlements.push(
        await grantShortageEntitlement(tx, {
          adjustmentCode: adjustment.code,
          line,
          storeId: bag.storeId,
          actorUserId: actor.userId,
          requestId: context.input.requestId ?? null,
          now,
        }),
      );
    }

    if (adjustment.cause === 'warehouse_mispick') {
      warehouseMovements.push(
        ...(await correctWarehouseMispick(tx, {
          adjustment,
          line,
          actorUserId: actor.userId,
          now,
        })),
      );
    }
  }

  await updateHeader(context, {
    appliedSequence: appliedCount + 1,
    appliedAt: now,
    decidedByUserId: actor.userId,
    decidedAt: now,
    decisionNote: note,
  });
  await audit(context, 'RECEIPT_ADJUSTMENT_APPLIED', {
    appliedSequence: appliedCount + 1,
    note,
    money: {
      before: moneyJson(money.before),
      after: moneyJson(money.after),
      delta: {
        goodsVnd: adjustment.goodsDeltaVnd.toString(),
        freightVnd: adjustment.freightDeltaVnd.toString(),
        handlingVnd: adjustment.handlingDeltaVnd.toString(),
        vatVnd: adjustment.vatDeltaVnd.toString(),
      },
    },
    lines: lines.map((line) => ({
      lineId: line.id,
      inventoryBagId: line.storeInventoryBagId,
      fromProductId: line.recordedProductId,
      toProductId: line.actualProductId,
      fromCostVnd: line.recordedCostVnd.toString(),
      toCostVnd: line.verifiedCostVnd?.toString() ?? null,
      disposition: line.disposition,
    })),
    entitlements,
    returns: returnsCreated,
    warehouseMovements,
  });
}

async function grantShortageEntitlement(
  tx: Transaction,
  input: {
    readonly adjustmentCode: string;
    readonly line: AdjustmentLineRow;
    readonly storeId: string;
    readonly actorUserId: string;
    readonly requestId: string | null;
    readonly now: Date;
  },
): Promise<JsonObject> {
  const { line, storeId, now } = input;
  const productId = line.approvedProductId;
  if (!productId) throw new StoreOperationValidationError('Dòng hàng dư không có quyền chờ bù.');
  const [receiptLine] = await tx
    .select({ outboundRequestLineId: storeReceiptLines.outboundRequestLineId })
    .from(storeReceiptLines)
    .where(eq(storeReceiptLines.id, line.storeReceiptLineId))
    .limit(1);
  if (!receiptLine?.outboundRequestLineId) {
    throw new StoreOperationValidationError('Dòng phiếu nhận không có lệnh xuất gốc.');
  }
  const sources = await tx
    .select({
      orderRequestItemId: allocationLines.orderRequestItemId,
      waitSourceItemId: waitTickets.sourceOrderRequestItemId,
    })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .leftJoin(waitTickets, eq(waitTickets.id, allocationLines.waitTicketId))
    .where(eq(reservations.outboundRequestLineId, receiptLine.outboundRequestLineId))
    .orderBy(asc(reservations.createdAt), asc(reservations.id));
  const sourceOrderRequestItemId = sources
    .map((row) => row.orderRequestItemId ?? row.waitSourceItemId)
    .find((id): id is string => id !== null);
  if (!sourceOrderRequestItemId) {
    throw new StoreOperationValidationError('Không truy được đơn đặt gốc của dòng hàng thiếu.');
  }

  return withStoreProductWaitLocks(tx, storeId, [productId], async () => {
    const [active] = await tx
      .select()
      .from(waitTickets)
      .where(
        and(
          eq(waitTickets.storeId, storeId),
          eq(waitTickets.productId, productId),
          eq(waitTickets.status, 'active'),
          isNull(waitTickets.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    let ticketId: string;
    let mode: 'created' | 'merged';
    if (active) {
      // Same rule as a receipt shortage before finalization: the store's one active wait for
      // the SKU absorbs the unit and is served at P0B.
      await tx
        .update(waitTickets)
        .set({
          originalQuantity: active.originalQuantity + line.shortageQuantity,
          remainingQuantity: active.remainingQuantity + line.shortageQuantity,
          priorityLevel: 'P0B',
          updatedAt: now,
        })
        .where(eq(waitTickets.id, active.id));
      ticketId = active.id;
      mode = 'merged';
    } else {
      const [created] = await tx
        .insert(waitTickets)
        .values({
          storeId,
          productId,
          sourceOrderRequestItemId,
          status: 'active',
          priorityLevel: 'P0B',
          originalQuantity: line.shortageQuantity,
          remainingQuantity: line.shortageQuantity,
          fulfilledQuantity: 0,
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: waitTickets.id });
      if (!created) throw new Error('Wait ticket insert returned no row.');
      ticketId = created.id;
      mode = 'created';
    }
    await tx.insert(receiptShortageEntitlements).values({
      adjustmentLineId: line.id,
      storeReceiptBagId: line.storeReceiptBagId,
      storeReceiptLineId: line.storeReceiptLineId,
      storeId,
      productId,
      quantity: line.shortageQuantity,
      waitTicketId: ticketId,
      waitMode: mode,
      sourceOrderRequestItemId,
      createdAt: now,
    });
    const [ticket] = await tx
      .select({
        code: waitTickets.code,
        originalQuantity: waitTickets.originalQuantity,
        remainingQuantity: waitTickets.remainingQuantity,
      })
      .from(waitTickets)
      .where(eq(waitTickets.id, ticketId))
      .limit(1);
    await tx.insert(auditLogs).values({
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      actorRole: 'admin',
      actorStoreId: storeId,
      action: 'RECEIPT_ADJUSTMENT_SHORTAGE_PRIORITIZED',
      entityType: 'wait_ticket',
      entityId: ticketId,
      before: active
        ? {
            originalQuantity: active.originalQuantity,
            remainingQuantity: active.remainingQuantity,
            priorityLevel: active.priorityLevel,
          }
        : null,
      after: {
        status: 'active',
        priorityLevel: 'P0B',
        originalQuantity: ticket?.originalQuantity ?? line.shortageQuantity,
        remainingQuantity: ticket?.remainingQuantity ?? line.shortageQuantity,
      },
      metadata: {
        adjustmentCode: input.adjustmentCode,
        adjustmentLineId: line.id,
        receiptBagId: line.storeReceiptBagId,
        productId,
        quantity: line.shortageQuantity,
        waitMode: mode,
      },
    });
    return {
      waitTicketId: ticketId,
      waitTicketCode: ticket?.code ?? '',
      productId,
      quantity: line.shortageQuantity,
      waitMode: mode,
    };
  });
}

/**
 * The warehouse shipped the verified SKU in place of the approved one. The shipped unit leaves
 * the verified SKU's on-hand; the approved unit may still be on the shelf, so it comes back
 * on-hand but stays reserved in a shortage check until someone confirms it (never free stock).
 */
async function correctWarehouseMispick(
  tx: Transaction,
  input: {
    readonly adjustment: typeof storeReceiptAdjustments.$inferSelect;
    readonly line: AdjustmentLineRow;
    readonly actorUserId: string;
    readonly now: Date;
  },
): Promise<JsonObject[]> {
  const { adjustment, line, now } = input;
  const [check] = await tx
    .insert(warehouseShortageChecks)
    .values({
      storeReceiptLineId: line.storeReceiptLineId,
      storeReceiptId: adjustment.storeReceiptId,
      storeId: adjustment.storeId,
      productId: line.recordedProductId,
      storeReceiptAdjustmentLineId: line.id,
      quantity: 1,
      shortageReason: `Kho giao nhầm theo ${adjustment.code}: ${adjustment.reason}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: warehouseShortageChecks.id });
  if (!check) throw new Error('Warehouse shortage check insert returned no row.');
  // Balance locks are taken in product order to avoid deadlocks with other movements.
  const movements = [
    {
      productId: line.actualProductId,
      eventType: 'adjustment' as const,
      onHandDelta: -1,
      reservedDelta: 0,
      sourceType: LINE_SOURCE,
      sourceId: line.id,
      eventSequence: 1,
      reason: `Kho giao nhầm theo ${adjustment.code}: bao thực tế đã rời kho`,
    },
    {
      productId: line.recordedProductId,
      eventType: 'adjustment' as const,
      onHandDelta: 1,
      reservedDelta: 1,
      sourceType: 'warehouse_shortage_check',
      sourceId: check.id,
      eventSequence: 1,
      reason: `Kho giao nhầm theo ${adjustment.code}: giữ chờ kiểm kệ, chưa được phân bổ`,
    },
  ].sort((left, right) => left.productId.localeCompare(right.productId));
  for (const movement of movements) {
    try {
      await applyWarehouseMovement(tx, {
        ...movement,
        metadata: { adjustmentId: adjustment.id, adjustmentLineId: line.id },
        actorUserId: input.actorUserId,
        occurredAt: now,
      });
    } catch (error) {
      if (error instanceof WarehouseBalanceViolationError) {
        throw new StoreOperationValidationError(
          'Kho tổng không còn hàng chưa giữ của mặt hàng thực tế để ghi giảm; cần kiểm kê trước khi chọn nguyên nhân kho giao nhầm.',
        );
      }
      throw error;
    }
  }
  await tx.insert(auditLogs).values({
    actorUserId: input.actorUserId,
    actorStoreId: adjustment.storeId,
    action: 'WAREHOUSE_SHORTAGE_CHECK_OPENED',
    entityType: 'warehouse_shortage_check',
    entityId: check.id,
    after: {
      status: 'pending',
      productId: line.recordedProductId,
      quantity: 1,
      storeReceiptId: adjustment.storeReceiptId,
      adjustmentId: adjustment.id,
    },
  });
  return movements.map((movement) => ({
    productId: movement.productId,
    onHandDelta: movement.onHandDelta,
    reservedDelta: movement.reservedDelta,
    shortageCheckId: movement.sourceType === 'warehouse_shortage_check' ? check.id : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------------------------

export interface CreateReceiptReturnInput {
  readonly adjustmentId: string;
  readonly adjustmentLineId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type ReceiptReturnTransitionInput = {
  readonly returnId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly requestId?: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
} & (
  | { readonly action: 'HANDOVER' }
  | {
      readonly action: 'RECEIVE';
      readonly outcome: 'RECEIVED' | 'NOT_RECEIVED' | 'WRONG_ITEM';
      readonly note: string | null;
    }
  | { readonly action: 'RESOLVE'; readonly outcome: 'RECEIVED' | 'LOST'; readonly note: string }
  | { readonly action: 'CANCEL'; readonly note: string }
);

export interface ReceiptReturnMutationResult {
  readonly returnId: string;
  readonly status: ReturnStatus;
  readonly version: number;
}

/** A store that kept the bag may still send it back later; the P0B right is not touched. */
export async function createReceiptReturn(
  database: Database,
  input: CreateReceiptReturnInput,
): Promise<IdempotencyResult<ReceiptReturnMutationResult>> {
  const reason = requiredNote(input.reason, 'Lý do trả', 1_000);
  return withIdempotency(
    database,
    {
      scope: `receipt-return.create:${input.adjustmentLineId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const [line] = await tx
        .select({ line: storeReceiptAdjustmentLines, adjustment: storeReceiptAdjustments })
        .from(storeReceiptAdjustmentLines)
        .innerJoin(
          storeReceiptAdjustments,
          eq(storeReceiptAdjustments.id, storeReceiptAdjustmentLines.adjustmentId),
        )
        .where(
          and(
            eq(storeReceiptAdjustmentLines.id, input.adjustmentLineId),
            eq(storeReceiptAdjustmentLines.adjustmentId, input.adjustmentId),
          ),
        )
        .limit(1);
      if (!line) throw new StoreOperationValidationError('Không tìm thấy bao trong hồ sơ.');
      await resolveActor(tx, input.actorUserId, line.adjustment.storeId, ['STORE']);
      return withAdvisoryLock(
        tx,
        'store-inventory-bag',
        line.line.storeInventoryBagId,
        async () => {
          const [current] = await tx
            .select()
            .from(storeReceiptAdjustmentLines)
            .where(eq(storeReceiptAdjustmentLines.id, input.adjustmentLineId))
            .for('update')
            .limit(1);
          if (
            line.adjustment.status !== 'applied' ||
            !current ||
            current.holdState !== 'released'
          ) {
            throw new StoreOperationConflictError(
              'Chỉ tạo phiếu trả cho bao đã được áp dụng điều chỉnh và đang giữ bán.',
            );
          }
          const bag = await lockInventoryBag(tx, current.storeInventoryBagId);
          const facts = await bagFacts(tx, current, null);
          const blocking = assessReceiptAdjustmentBag({
            ...facts,
            heldByThisAdjustment: true,
            matchesRecordedState: bag.productId === current.actualProductId,
          }).filter((code) => code !== 'BAG_NOT_HELD');
          if (!canHoldReceiptAdjustmentBag(bag.status) || blocking.length > 0) {
            throw new ReceiptAdjustmentBlockedError({ [current.storeReceiptBagId]: blocking });
          }
          const now = new Date();
          const [created] = await tx
            .insert(storeReceiptReturns)
            .values({
              adjustmentLineId: current.id,
              storeId: bag.storeId,
              storeInventoryBagId: bag.id,
              productId: bag.productId,
              weightKg: bag.currentWeightKg,
              costVnd: bag.costVnd,
              reason,
              createdByUserId: input.actorUserId,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: storeReceiptReturns.id, code: storeReceiptReturns.code });
          if (!created) throw new Error('Receipt return insert returned no row.');
          await setBagHold(tx, {
            bag,
            status: 'quarantined',
            eventType: 'quarantine',
            sourceType: RETURN_SOURCE,
            sourceId: created.id,
            eventSequence: RETURN_EVENT.hold,
            reason: `Giữ hàng chờ trả kho theo ${created.code}`,
            actorUserId: input.actorUserId,
            now,
          });
          await tx
            .update(storeReceiptAdjustmentLines)
            .set({ holdState: 'returning', holdPreviousStatus: bag.status, updatedAt: now })
            .where(eq(storeReceiptAdjustmentLines.id, current.id));
          await tx.insert(auditLogs).values({
            requestId: input.requestId ?? null,
            actorUserId: input.actorUserId,
            actorRole: 'store',
            actorStoreId: bag.storeId,
            action: 'STORE_RECEIPT_RETURN_CREATED',
            entityType: 'store_receipt_return',
            entityId: created.id,
            after: {
              status: 'pending_handover',
              code: created.code,
              adjustmentId: input.adjustmentId,
              adjustmentLineId: current.id,
              switchedFrom: 'keep',
              inventoryBagId: bag.id,
              productId: bag.productId,
              weightKg: bag.currentWeightKg,
              costVnd: bag.costVnd.toString(),
              reason,
            },
          });
          return returnResult(
            { returnId: created.id, status: 'pending_handover', version: 0 },
            201,
          );
        },
      );
    },
  );
}

export async function transitionReceiptReturn(
  database: Database,
  input: ReceiptReturnTransitionInput,
): Promise<IdempotencyResult<ReceiptReturnMutationResult>> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new StoreOperationValidationError('expectedVersion không hợp lệ.');
  }
  return withIdempotency(
    database,
    {
      scope: `receipt-return.${input.action.toLowerCase()}:${input.returnId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const [located] = await tx
        .select({ bagId: storeReceiptReturns.storeInventoryBagId })
        .from(storeReceiptReturns)
        .where(eq(storeReceiptReturns.id, input.returnId))
        .limit(1);
      if (!located) throw new StoreOperationValidationError('Không tìm thấy phiếu trả.');
      return withAdvisoryLock(tx, 'store-inventory-bag', located.bagId, async () => {
        const [row] = await tx
          .select()
          .from(storeReceiptReturns)
          .where(eq(storeReceiptReturns.id, input.returnId))
          .for('update')
          .limit(1);
        if (!row) throw new StoreOperationValidationError('Không tìm thấy phiếu trả.');
        const allowedRoles: readonly ReceiptAdjustmentActorRole[] =
          input.action === 'HANDOVER'
            ? ['STORE']
            : input.action === 'CANCEL'
              ? ['STORE', 'HTKD', 'ADMIN']
              : ['ADMIN'];
        const actor = await resolveActor(tx, input.actorUserId, row.storeId, allowedRoles);
        if (row.version !== input.expectedVersion) {
          throw new StoreOperationConflictError('Phiếu trả đã thay đổi; hãy tải lại.');
        }
        const requiredStatus: Record<ReceiptReturnTransitionInput['action'], ReturnStatus> = {
          HANDOVER: 'pending_handover',
          CANCEL: 'pending_handover',
          RECEIVE: 'in_transit',
          RESOLVE: 'disputed',
        };
        if (row.status !== requiredStatus[input.action]) {
          throw new StoreOperationConflictError('Phiếu trả không ở trạng thái cho thao tác này.');
        }
        const now = new Date();
        let next: ReturnStatus;
        let changes: Partial<typeof storeReceiptReturns.$inferInsert> = {};
        const after: Record<string, string | number | null> = {};
        switch (input.action) {
          case 'HANDOVER': {
            const bag = await lockInventoryBag(tx, row.storeInventoryBagId);
            if (bag.status !== 'quarantined' || bag.currentWeightKg !== row.weightKg) {
              throw new StoreOperationConflictError('Bao chờ trả đã thay đổi ngoài phiếu trả.');
            }
            // The bag leaves store stock now; it is in transit, not on any shelf.
            const [updated] = await tx
              .update(storeInventoryBags)
              .set({
                status: 'returned',
                currentWeightKg: '0.000',
                depletedAt: now,
                version: bag.version + 1,
                updatedAt: now,
              })
              .where(
                and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)),
              )
              .returning({ id: storeInventoryBags.id });
            if (!updated) throw new StoreOperationConflictError('Bao đã thay đổi khi bàn giao.');
            await tx.insert(storeInventoryLedgerEntries).values({
              storeInventoryBagId: bag.id,
              storeId: bag.storeId,
              productId: bag.productId,
              eventType: 'consume',
              weightBeforeKg: bag.currentWeightKg,
              weightAfterKg: '0.000',
              sourceType: RETURN_SOURCE,
              sourceId: row.id,
              eventSequence: RETURN_EVENT.handover,
              reason: `Bàn giao trả kho theo ${row.code}`,
              actorUserId: actor.userId,
              occurredAt: now,
            });
            next = 'in_transit';
            changes = { handedOverByUserId: actor.userId, handedOverAt: now };
            break;
          }
          case 'RECEIVE': {
            const received = input.outcome === 'RECEIVED';
            const note = received
              ? optionalNote(input.note, 'Ghi chú', 1_000)
              : requiredNote(input.note ?? '', 'Ghi chú đối soát', 1_000);
            if (received) await bookReturnIntoWarehouse(tx, row, actor.userId, now);
            next = received ? 'received' : 'disputed';
            changes = {
              receivedByUserId: actor.userId,
              receivedAt: now,
              receivedQuantity: received ? row.quantity : 0,
              receiveNote: note ?? (received ? null : input.outcome),
            };
            after.outcome = input.outcome;
            break;
          }
          case 'RESOLVE': {
            const note = requiredNote(input.note, 'Kết quả đối soát', 1_000);
            if (input.outcome === 'RECEIVED') {
              await bookReturnIntoWarehouse(tx, row, actor.userId, now);
            }
            next = input.outcome === 'RECEIVED' ? 'received' : 'lost';
            changes = {
              resolvedByUserId: actor.userId,
              resolvedAt: now,
              resolutionNote: note,
              ...(input.outcome === 'RECEIVED' ? { receivedQuantity: row.quantity } : {}),
            };
            after.outcome = input.outcome;
            break;
          }
          case 'CANCEL': {
            const note = requiredNote(input.note, 'Lý do', 1_000);
            const [line] = await tx
              .select()
              .from(storeReceiptAdjustmentLines)
              .where(eq(storeReceiptAdjustmentLines.id, row.adjustmentLineId))
              .for('update')
              .limit(1);
            const bag = await lockInventoryBag(tx, row.storeInventoryBagId);
            if (!line || line.holdState !== 'returning' || bag.status !== 'quarantined') {
              throw new StoreOperationConflictError('Bao chờ trả đã thay đổi ngoài phiếu trả.');
            }
            await setBagHold(tx, {
              bag,
              status: line.holdPreviousStatus ?? 'available',
              eventType: 'release',
              sourceType: RETURN_SOURCE,
              sourceId: row.id,
              eventSequence: RETURN_EVENT.releaseOnCancel,
              reason: `Hủy phiếu trả ${row.code}: cửa hàng giữ bán`,
              actorUserId: actor.userId,
              now,
            });
            await tx
              .update(storeReceiptAdjustmentLines)
              .set({ holdState: 'released', updatedAt: now })
              .where(eq(storeReceiptAdjustmentLines.id, line.id));
            next = 'cancelled';
            changes = {
              cancelledByUserId: actor.userId,
              cancelledAt: now,
              cancellationReason: note,
            };
            break;
          }
        }
        const [updated] = await tx
          .update(storeReceiptReturns)
          .set({ ...changes, status: next, version: row.version + 1, updatedAt: now })
          .where(
            and(eq(storeReceiptReturns.id, row.id), eq(storeReceiptReturns.version, row.version)),
          )
          .returning({ version: storeReceiptReturns.version });
        if (!updated) throw new StoreOperationConflictError('Phiếu trả đã thay đổi khi xử lý.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: actor.userId,
          actorRole: actor.databaseRole,
          actorStoreId: row.storeId,
          action: `STORE_RECEIPT_RETURN_${
            {
              HANDOVER: 'HANDED_OVER',
              RECEIVE: next === 'received' ? 'RECEIVED' : 'DISPUTED',
              RESOLVE: next === 'received' ? 'RECEIVED_AFTER_RECONCILIATION' : 'LOST',
              CANCEL: 'CANCELLED',
            }[input.action]
          }`,
          entityType: 'store_receipt_return',
          entityId: row.id,
          before: { status: row.status, version: row.version },
          after: { ...after, status: next, version: updated.version, ...jsonChanges(changes) },
        });
        return returnResult({ returnId: row.id, status: next, version: updated.version }, 200);
      });
    },
  );
}

/** Warehouse on-hand grows from a return only once, when the warehouse confirms it arrived. */
async function bookReturnIntoWarehouse(
  tx: Transaction,
  row: typeof storeReceiptReturns.$inferSelect,
  actorUserId: string,
  now: Date,
): Promise<void> {
  await applyWarehouseMovement(tx, {
    productId: row.productId,
    eventType: 'return',
    onHandDelta: row.quantity,
    reservedDelta: 0,
    sourceType: RETURN_SOURCE,
    sourceId: row.id,
    eventSequence: 1,
    reason: `Kho nhận hàng trả ${row.code}`,
    metadata: { storeId: row.storeId, adjustmentLineId: row.adjustmentLineId },
    actorUserId,
    occurredAt: now,
  });
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export async function getReceiptAdjustmentContext(
  database: Database,
  receiptId: string,
): Promise<ReceiptAdjustmentContext | null> {
  const [receipt] = await database
    .select()
    .from(storeReceipts)
    .where(and(eq(storeReceipts.id, receiptId), isNull(storeReceipts.deletedAt)))
    .limit(1);
  if (!receipt) return null;
  const states =
    receipt.status === 'finalized' ? await loadEffectiveBagStates(database, receipt.id) : [];
  const bags: ReceiptAdjustmentContextBag[] = [];
  for (const state of states) {
    let dependencies: ReceiptAdjustmentBagBlocker[] = [];
    if (state.inventoryBagId && state.bag) {
      const facts = await bagFactsFor(database, state.bag, null);
      dependencies = assessReceiptAdjustmentBag({
        ...facts,
        heldByThisAdjustment: true,
        matchesRecordedState: true,
      }).filter((code) => code !== 'BAG_NOT_HELD');
    }
    bags.push({
      receiptBagId: state.receiptBagId,
      receiptLineId: state.receiptLineId,
      bagNumber: state.bagNumber,
      inventoryBagId: state.inventoryBagId,
      bagDisplayCode: state.bag?.displayCode ?? null,
      bagStatus: state.bag?.status ?? null,
      currentWeightKg: state.bag?.currentWeightKg ?? null,
      approvedProductId: state.approvedProductId,
      effectiveProductId: state.effectiveProductId,
      effectiveWeightKg: state.effectiveWeightKg,
      effectivePricePerKgVnd: state.effectivePricePerKgVnd,
      effectiveCostVnd: state.effectiveCostVnd,
      shortageGranted: state.shortageGranted,
      openAdjustmentId: state.openAdjustmentId,
      openReturnId: state.openReturnId,
      dependencies,
    });
  }
  const summary = await receiptAdjustmentMoneySummary(database, receipt);
  return {
    receiptId: receipt.id,
    receiptNumber: receipt.receiptNumber,
    storeId: receipt.storeId,
    receiptStatus: receipt.status,
    finalizedAt: receipt.finalizedAt,
    money: { original: summary.original, effective: summary.effective },
    appliedCount: summary.appliedCount,
    bags,
  };
}

/** Original finalized money, the effective money after applied adjustments, and counts. */
export async function receiptAdjustmentMoneySummary(
  database: Reader,
  receipt: Pick<
    typeof storeReceipts.$inferSelect,
    'id' | 'goodsCostVnd' | 'freightVnd' | 'handlingVnd' | 'vatAmountVnd'
  >,
): Promise<ReceiptAdjustmentMoneySummary> {
  const [totals] = await database
    .select({
      applied:
        sql<number>`count(*) FILTER (WHERE ${storeReceiptAdjustments.status} = 'applied')`.mapWith(
          Number,
        ),
      open: sql<number>`count(*) FILTER (WHERE ${storeReceiptAdjustments.status} IN ('pending_htkd', 'needs_info', 'pending_admin'))`.mapWith(
        Number,
      ),
      goods: sql<string>`coalesce(sum(${storeReceiptAdjustments.goodsDeltaVnd}) FILTER (WHERE ${storeReceiptAdjustments.status} = 'applied'), 0)`,
      freight: sql<string>`coalesce(sum(${storeReceiptAdjustments.freightDeltaVnd}) FILTER (WHERE ${storeReceiptAdjustments.status} = 'applied'), 0)`,
      handling: sql<string>`coalesce(sum(${storeReceiptAdjustments.handlingDeltaVnd}) FILTER (WHERE ${storeReceiptAdjustments.status} = 'applied'), 0)`,
      vat: sql<string>`coalesce(sum(${storeReceiptAdjustments.vatDeltaVnd}) FILTER (WHERE ${storeReceiptAdjustments.status} = 'applied'), 0)`,
    })
    .from(storeReceiptAdjustments)
    .where(eq(storeReceiptAdjustments.storeReceiptId, receipt.id));
  const original: ReceiptMoneyState = {
    goodsVnd: receipt.goodsCostVnd,
    freightVnd: receipt.freightVnd,
    handlingVnd: receipt.handlingVnd,
    vatVnd: receipt.vatAmountVnd,
  };
  const effective = applyReceiptMoneyDeltas(original, [
    {
      goodsVnd: BigInt(totals?.goods ?? 0),
      freightVnd: BigInt(totals?.freight ?? 0),
      handlingVnd: BigInt(totals?.handling ?? 0),
      vatVnd: BigInt(totals?.vat ?? 0),
    },
  ]);
  return {
    appliedCount: totals?.applied ?? 0,
    openCount: totals?.open ?? 0,
    original: moneyView(original),
    effective: moneyView(effective),
  };
}

export interface ListReceiptAdjustmentsInput {
  readonly storeIds?: readonly string[];
  readonly receiptId?: string;
  readonly status?: DatabaseStatus;
  readonly page: number;
  readonly pageSize: number;
}

export async function listReceiptAdjustments(
  database: Database,
  input: ListReceiptAdjustmentsInput,
): Promise<{ readonly data: ReceiptAdjustmentSummaryRecord[]; readonly totalItems: number }> {
  if (input.storeIds !== undefined && input.storeIds.length === 0)
    return { data: [], totalItems: 0 };
  const predicates: SQL[] = [];
  if (input.storeIds !== undefined) {
    predicates.push(inArray(storeReceiptAdjustments.storeId, [...input.storeIds]));
  }
  if (input.receiptId !== undefined) {
    predicates.push(eq(storeReceiptAdjustments.storeReceiptId, input.receiptId));
  }
  if (input.status !== undefined) predicates.push(eq(storeReceiptAdjustments.status, input.status));
  const where = predicates.length === 0 ? undefined : and(...predicates);
  const [rows, totals] = await Promise.all([
    database
      .select({
        adjustment: storeReceiptAdjustments,
        receiptNumber: storeReceipts.receiptNumber,
        lineCount:
          sql<number>`(SELECT count(*) FROM ${storeReceiptAdjustmentLines} WHERE ${storeReceiptAdjustmentLines.adjustmentId} = ${storeReceiptAdjustments.id})`.mapWith(
            Number,
          ),
        shortageQuantity:
          sql<number>`(SELECT coalesce(sum(${storeReceiptAdjustmentLines.shortageQuantity}), 0) FROM ${storeReceiptAdjustmentLines} WHERE ${storeReceiptAdjustmentLines.adjustmentId} = ${storeReceiptAdjustments.id})`.mapWith(
            Number,
          ),
      })
      .from(storeReceiptAdjustments)
      .innerJoin(storeReceipts, eq(storeReceipts.id, storeReceiptAdjustments.storeReceiptId))
      .where(where)
      .orderBy(desc(storeReceiptAdjustments.updatedAt), desc(storeReceiptAdjustments.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    database.select({ value: count() }).from(storeReceiptAdjustments).where(where),
  ]);
  return {
    data: rows.map(({ adjustment, receiptNumber, lineCount, shortageQuantity }) => ({
      id: adjustment.id,
      code: adjustment.code,
      receiptId: adjustment.storeReceiptId,
      receiptNumber,
      storeId: adjustment.storeId,
      status: adjustment.status,
      version: adjustment.version,
      reason: adjustment.reason,
      lineCount,
      shortageQuantity,
      goodsDeltaVnd: adjustment.goodsDeltaVnd,
      reportedAt: adjustment.reportedAt,
      appliedAt: adjustment.appliedAt,
      updatedAt: adjustment.updatedAt,
    })),
    totalItems: totals[0]?.value ?? 0,
  };
}

export async function getReceiptAdjustment(
  database: Database,
  adjustmentId: string,
): Promise<ReceiptAdjustmentRecord | null> {
  const [row] = await database
    .select({ adjustment: storeReceiptAdjustments, receipt: storeReceipts })
    .from(storeReceiptAdjustments)
    .innerJoin(storeReceipts, eq(storeReceipts.id, storeReceiptAdjustments.storeReceiptId))
    .where(eq(storeReceiptAdjustments.id, adjustmentId))
    .limit(1);
  if (!row) return null;
  const { adjustment, receipt } = row;
  const lines = await loadLines(database, adjustment.id);
  const open = OPEN_DATABASE_STATUSES.includes(adjustment.status);
  const bagRows = lines.length
    ? await database
        .select()
        .from(storeInventoryBags)
        .where(
          inArray(
            storeInventoryBags.id,
            lines.map((line) => line.storeInventoryBagId),
          ),
        )
    : [];
  const bagsById = new Map(bagRows.map((bag) => [bag.id, bag]));
  const receiptBagRows = lines.length
    ? await database
        .select({ id: storeReceiptBags.id, bagNumber: storeReceiptBags.bagNumber })
        .from(storeReceiptBags)
        .where(
          inArray(
            storeReceiptBags.id,
            lines.map((line) => line.storeReceiptBagId),
          ),
        )
    : [];
  const bagNumbers = new Map(receiptBagRows.map((bag) => [bag.id, bag.bagNumber]));
  const entitlements = await loadEntitlementProgress(
    database,
    lines.map((line) => line.id),
  );
  const returns = await listReceiptReturnRecords(database, {
    adjustmentLineIds: lines.map((line) => line.id),
  });
  const lineRecords: ReceiptAdjustmentLineRecord[] = [];
  for (const line of lines) {
    const bag = bagsById.get(line.storeInventoryBagId);
    if (!bag) throw new Error('Adjustment line lost its inventory bag.');
    lineRecords.push({
      id: line.id,
      receiptBagId: line.storeReceiptBagId,
      receiptBagNumber: bagNumbers.get(line.storeReceiptBagId) ?? 0,
      inventoryBagId: line.storeInventoryBagId,
      bagDisplayCode: bag.displayCode,
      bagStatus: bag.status,
      bagCurrentWeightKg: bag.currentWeightKg,
      approvedProductId: line.approvedProductId,
      recordedProductId: line.recordedProductId,
      actualProductId: line.actualProductId,
      disposition: line.disposition,
      recordedWeightKg: line.recordedWeightKg,
      recordedPricePerKgVnd: line.recordedPricePerKgVnd,
      recordedCostVnd: line.recordedCostVnd,
      verifiedWeightKg: line.verifiedWeightKg,
      verifiedPricePerKgVnd: line.verifiedPricePerKgVnd,
      verifiedCostVnd: line.verifiedCostVnd,
      weightChangeNote: line.weightChangeNote,
      shortageQuantity: line.shortageQuantity,
      holdState: line.holdState,
      blockers: open
        ? assessReceiptAdjustmentBag(await bagFactsFor(database, bag, line, adjustment.id))
        : [],
      entitlement: entitlements.get(line.id) ?? null,
      returns: returns.filter((item) => item.adjustmentLineId === line.id),
    });
  }
  const summary = await receiptAdjustmentMoneySummary(database, receipt);
  const verification = adjustment.verification as {
    money?: { before?: MoneyJson; after?: MoneyJson };
  } | null;
  const before = verification?.money?.before
    ? moneyFromJson(verification.money.before)
    : summary.effective;
  const after =
    adjustment.status === 'pending_admin' || adjustment.status === 'applied'
      ? verification?.money?.after
        ? moneyFromJson(verification.money.after)
        : null
      : null;
  return {
    id: adjustment.id,
    code: adjustment.code,
    receiptId: receipt.id,
    receiptNumber: receipt.receiptNumber,
    receiptFinalizedAt: receipt.finalizedAt,
    storeId: adjustment.storeId,
    status: adjustment.status,
    version: adjustment.version,
    reason: adjustment.reason,
    evidenceNote: adjustment.evidenceNote,
    discoveredAt: adjustment.discoveredAt,
    cause: adjustment.cause,
    baseAppliedCount: adjustment.baseAppliedCount,
    appliedSequence: adjustment.appliedSequence,
    goodsDeltaVnd: adjustment.goodsDeltaVnd,
    freightDeltaVnd: adjustment.freightDeltaVnd,
    handlingDeltaVnd: adjustment.handlingDeltaVnd,
    vatDeltaVnd: adjustment.vatDeltaVnd,
    money: { original: summary.original, before, after },
    reportedByUserId: adjustment.reportedByUserId,
    reportedAt: adjustment.reportedAt,
    verifiedByUserId: adjustment.verifiedByUserId,
    verifiedAt: adjustment.verifiedAt,
    verificationNote: adjustment.verificationNote,
    infoRequestNote: adjustment.infoRequestNote,
    decidedByUserId: adjustment.decidedByUserId,
    decidedAt: adjustment.decidedAt,
    decisionNote: adjustment.decisionNote,
    appliedAt: adjustment.appliedAt,
    createdAt: adjustment.createdAt,
    updatedAt: adjustment.updatedAt,
    lines: lineRecords,
  };
}

export interface ListReceiptReturnsInput {
  readonly storeIds?: readonly string[];
  readonly status?: ReturnStatus;
  readonly adjustmentLineIds?: readonly string[];
  readonly page?: number;
  readonly pageSize?: number;
}

export async function listReceiptReturns(
  database: Database,
  input: ListReceiptReturnsInput & { readonly page: number; readonly pageSize: number },
): Promise<{ readonly data: ReceiptReturnRecord[]; readonly totalItems: number }> {
  const where = returnPredicates(input);
  if (where === null) return { data: [], totalItems: 0 };
  const [data, totals] = await Promise.all([
    listReceiptReturnRecords(database, input),
    database.select({ value: count() }).from(storeReceiptReturns).where(where),
  ]);
  return { data, totalItems: totals[0]?.value ?? 0 };
}

export async function getReceiptReturn(
  database: Database,
  returnId: string,
): Promise<ReceiptReturnRecord | null> {
  const [record] = await listReceiptReturnRecords(database, { returnId });
  return record ?? null;
}

async function listReceiptReturnRecords(
  database: Reader,
  input: ListReceiptReturnsInput & { readonly returnId?: string },
): Promise<ReceiptReturnRecord[]> {
  const where = returnPredicates(input);
  if (where === null) return [];
  let query = database
    .select({
      row: storeReceiptReturns,
      adjustmentId: storeReceiptAdjustments.id,
      adjustmentCode: storeReceiptAdjustments.code,
      displayCode: storeInventoryBags.displayCode,
    })
    .from(storeReceiptReturns)
    .innerJoin(
      storeReceiptAdjustmentLines,
      eq(storeReceiptAdjustmentLines.id, storeReceiptReturns.adjustmentLineId),
    )
    .innerJoin(
      storeReceiptAdjustments,
      eq(storeReceiptAdjustments.id, storeReceiptAdjustmentLines.adjustmentId),
    )
    .innerJoin(
      storeInventoryBags,
      eq(storeInventoryBags.id, storeReceiptReturns.storeInventoryBagId),
    )
    .where(where)
    .orderBy(desc(storeReceiptReturns.createdAt), desc(storeReceiptReturns.id))
    .$dynamic();
  if (input.page !== undefined && input.pageSize !== undefined) {
    query = query.limit(input.pageSize).offset((input.page - 1) * input.pageSize);
  }
  const rows = await query;
  return rows.map(({ row, adjustmentId, adjustmentCode, displayCode }) => ({
    id: row.id,
    code: row.code,
    adjustmentId,
    adjustmentCode,
    adjustmentLineId: row.adjustmentLineId,
    storeId: row.storeId,
    inventoryBagId: row.storeInventoryBagId,
    bagDisplayCode: displayCode,
    productId: row.productId,
    quantity: row.quantity,
    weightKg: row.weightKg,
    costVnd: row.costVnd,
    status: row.status,
    version: row.version,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    handedOverByUserId: row.handedOverByUserId,
    handedOverAt: row.handedOverAt,
    receivedByUserId: row.receivedByUserId,
    receivedAt: row.receivedAt,
    receivedQuantity: row.receivedQuantity,
    receiveNote: row.receiveNote,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    cancelledByUserId: row.cancelledByUserId,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function returnPredicates(
  input: ListReceiptReturnsInput & { readonly returnId?: string },
): SQL | undefined | null {
  if (input.storeIds !== undefined && input.storeIds.length === 0) return null;
  if (input.adjustmentLineIds !== undefined && input.adjustmentLineIds.length === 0) return null;
  const predicates: SQL[] = [];
  if (input.storeIds !== undefined) {
    predicates.push(inArray(storeReceiptReturns.storeId, [...input.storeIds]));
  }
  if (input.status !== undefined) predicates.push(eq(storeReceiptReturns.status, input.status));
  if (input.adjustmentLineIds !== undefined) {
    predicates.push(inArray(storeReceiptReturns.adjustmentLineId, [...input.adjustmentLineIds]));
  }
  if (input.returnId !== undefined) predicates.push(eq(storeReceiptReturns.id, input.returnId));
  return predicates.length === 0 ? undefined : and(...predicates);
}

/** Store-visible progress of each granted right, through the existing wait/allocation chain. */
async function loadEntitlementProgress(
  database: Reader,
  adjustmentLineIds: readonly string[],
): Promise<Map<string, EntitlementProgress>> {
  if (adjustmentLineIds.length === 0) return new Map();
  const rows = await database
    .select({ entitlement: receiptShortageEntitlements, ticket: waitTickets })
    .from(receiptShortageEntitlements)
    .innerJoin(waitTickets, eq(waitTickets.id, receiptShortageEntitlements.waitTicketId))
    .where(inArray(receiptShortageEntitlements.adjustmentLineId, [...adjustmentLineIds]));
  const result = new Map<string, EntitlementProgress>();
  for (const { entitlement, ticket } of rows) {
    const [offer] = await database
      .select({ id: dailyPriorityOffers.id })
      .from(dailyPriorityOffers)
      .where(
        and(
          eq(dailyPriorityOffers.waitTicketId, ticket.id),
          livePriorityOfferCondition(),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      )
      .limit(1);
    const [progress] = await database
      .select({
        held: sql<number>`coalesce(sum(${reservations.quantity}) FILTER (WHERE ${reservations.status} = 'active' AND ${reservations.outboundRequestLineId} IS NULL), 0)`.mapWith(
          Number,
        ),
        shipping:
          sql<number>`coalesce(sum(${reservations.quantity}) FILTER (WHERE ${reservations.status} = 'active' AND ${reservations.outboundRequestLineId} IS NOT NULL), 0)`.mapWith(
            Number,
          ),
        received:
          sql<number>`coalesce(sum(${reservations.consumedQuantity}) FILTER (WHERE ${reservations.status} = 'consumed'), 0)`.mapWith(
            Number,
          ),
      })
      .from(reservations)
      .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
      .where(
        and(
          eq(allocationLines.waitTicketId, ticket.id),
          gte(reservations.createdAt, entitlement.createdAt),
          isNull(reservations.deletedAt),
        ),
      );
    result.set(entitlement.adjustmentLineId, {
      waitTicketId: ticket.id,
      waitTicketCode: ticket.code,
      waitMode: entitlement.waitMode as 'created' | 'merged',
      quantity: entitlement.quantity,
      productId: entitlement.productId,
      waitStatus: ticket.status,
      waitRemainingQuantity: ticket.remainingQuantity,
      waitFulfilledQuantity: ticket.fulfilledQuantity,
      hasOpenOffer: Boolean(offer),
      heldQuantity: progress?.held ?? 0,
      shippingQuantity: progress?.shipping ?? 0,
      receivedQuantity: progress?.received ?? 0,
      createdAt: entitlement.createdAt,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

type InventoryBagRow = typeof storeInventoryBags.$inferSelect;
type AdjustmentLineRow = typeof storeReceiptAdjustmentLines.$inferSelect;

interface ResolvedActor {
  readonly userId: string;
  readonly role: ReceiptAdjustmentActorRole;
  readonly databaseRole: 'admin' | 'htkd' | 'store';
}

/**
 * Role, account status, store and HTKD assignment are all re-read inside the transaction, so a
 * locked account or a revoked assignment is refused even with a still-open session.
 */
async function resolveActor(
  tx: Transaction,
  userId: string,
  storeId: string,
  roles: readonly ReceiptAdjustmentActorRole[],
): Promise<ResolvedActor> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  const [user] = await tx
    .select({ role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!store || !user || user.status !== 'active') throw new ReceiptAdjustmentAuthorizationError();
  let role: ReceiptAdjustmentActorRole | null = null;
  if (user.role === 'admin') role = 'ADMIN';
  else if (user.role === 'store' && user.storeId === storeId) role = 'STORE';
  else if (user.role === 'htkd') {
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
    if (assignment) role = 'HTKD';
  }
  if (role === null || !roles.includes(role)) throw new ReceiptAdjustmentAuthorizationError();
  return { userId, role, databaseRole: user.role as ResolvedActor['databaseRole'] };
}

function planTransition(
  status: DatabaseStatus,
  action: ReceiptAdjustmentAction,
  role: ReceiptAdjustmentActorRole,
): DatabaseStatus {
  try {
    return statusFromDomain[planReceiptAdjustmentTransition(statusToDomain[status], action, role)];
  } catch (error) {
    if (error instanceof DomainError && error.code === 'ACTION_NOT_PERMITTED') {
      throw new ReceiptAdjustmentAuthorizationError();
    }
    if (error instanceof DomainError) {
      throw new StoreOperationConflictError('Hồ sơ không ở trạng thái cho thao tác này.');
    }
    throw error;
  }
}

async function loadFinalizedReceipt(tx: Reader, receiptId: string) {
  const [receipt] = await tx
    .select()
    .from(storeReceipts)
    .where(and(eq(storeReceipts.id, receiptId), isNull(storeReceipts.deletedAt)))
    .limit(1);
  if (!receipt) throw new StoreOperationValidationError('Không tìm thấy phiếu nhận hàng.');
  if (receipt.status !== 'finalized') {
    throw new StoreOperationConflictError(
      'Chỉ báo sai lệch sau khui bao cho phiếu nhận đã chốt; phiếu chưa chốt hãy sửa khai nhận.',
    );
  }
  return receipt;
}

async function countApplied(tx: Reader, receiptId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(storeReceiptAdjustments)
    .where(
      and(
        eq(storeReceiptAdjustments.storeReceiptId, receiptId),
        eq(storeReceiptAdjustments.status, 'applied'),
      ),
    );
  return row?.value ?? 0;
}

async function effectiveMoney(
  tx: Reader,
  receipt: typeof storeReceipts.$inferSelect,
): Promise<ReceiptMoneyState> {
  const summary = await receiptAdjustmentMoneySummary(tx, receipt);
  return {
    goodsVnd: summary.effective.goodsVnd,
    freightVnd: summary.effective.freightVnd,
    handlingVnd: summary.effective.handlingVnd,
    vatVnd: summary.effective.vatVnd,
  };
}

interface EffectiveBagState {
  readonly receiptBagId: string;
  readonly receiptLineId: string;
  readonly bagNumber: number;
  readonly inventoryBagId: string | null;
  readonly bag: InventoryBagRow | null;
  readonly approvedProductId: string | null;
  readonly effectiveProductId: string;
  readonly effectiveWeightKg: string;
  readonly effectivePricePerKgVnd: bigint;
  readonly effectiveCostVnd: bigint;
  readonly shortageGranted: boolean;
  readonly openAdjustmentId: string | null;
  readonly openReturnId: string | null;
}

/**
 * The value in effect for each physical bag is the latest applied adjustment of that bag, or
 * the finalized receipt bag when none was applied. The original rows are never rewritten.
 */
async function loadEffectiveBagStates(tx: Reader, receiptId: string): Promise<EffectiveBagState[]> {
  const rows = await tx
    .select({ bag: storeReceiptBags, line: storeReceiptLines, inventory: storeInventoryBags })
    .from(storeReceiptBags)
    .innerJoin(storeReceiptLines, eq(storeReceiptLines.id, storeReceiptBags.storeReceiptLineId))
    .leftJoin(
      storeInventoryBags,
      eq(storeInventoryBags.sourceStoreReceiptBagId, storeReceiptBags.id),
    )
    .where(eq(storeReceiptLines.storeReceiptId, receiptId))
    .orderBy(asc(storeReceiptLines.productId), asc(storeReceiptBags.bagNumber));
  if (rows.length === 0) return [];
  const receiptBagIds = rows.map((row) => row.bag.id);
  const adjustmentLines = await tx
    .select({ line: storeReceiptAdjustmentLines, adjustment: storeReceiptAdjustments })
    .from(storeReceiptAdjustmentLines)
    .innerJoin(
      storeReceiptAdjustments,
      eq(storeReceiptAdjustments.id, storeReceiptAdjustmentLines.adjustmentId),
    )
    .where(inArray(storeReceiptAdjustmentLines.storeReceiptBagId, receiptBagIds))
    .orderBy(asc(storeReceiptAdjustments.appliedSequence));
  const granted = await grantedReceiptBags(tx, receiptBagIds);
  const openReturns = await tx
    .select({ id: storeReceiptReturns.id, bagId: storeReceiptReturns.storeInventoryBagId })
    .from(storeReceiptReturns)
    .where(
      and(
        inArray(
          storeReceiptReturns.storeInventoryBagId,
          rows.flatMap((row) => (row.inventory ? [row.inventory.id] : [])),
        ),
        eq(storeReceiptReturns.status, 'pending_handover'),
      ),
    );
  return rows.map(({ bag, line, inventory }) => {
    const history = adjustmentLines.filter((entry) => entry.line.storeReceiptBagId === bag.id);
    const latest = history.filter((entry) => entry.adjustment.status === 'applied').at(-1);
    const open = history.find((entry) => OPEN_DATABASE_STATUSES.includes(entry.adjustment.status));
    return {
      receiptBagId: bag.id,
      receiptLineId: line.id,
      bagNumber: bag.bagNumber,
      inventoryBagId: inventory?.id ?? null,
      bag: inventory,
      // Excess bags were never approved, so a wrong excess bag creates no shortage right.
      approvedProductId:
        line.outboundRequestLineId !== null && bag.bagNumber <= line.receivedQuantity
          ? line.productId
          : null,
      effectiveProductId: latest?.line.actualProductId ?? line.productId,
      effectiveWeightKg: latest?.line.verifiedWeightKg ?? bag.weightKg,
      effectivePricePerKgVnd: latest?.line.verifiedPricePerKgVnd ?? bag.pricePerKgVnd,
      effectiveCostVnd: latest?.line.verifiedCostVnd ?? bag.goodsCostVnd,
      shortageGranted: granted.has(bag.id),
      openAdjustmentId: open?.adjustment.id ?? null,
      openReturnId: openReturns.find((entry) => entry.bagId === inventory?.id)?.id ?? null,
    };
  });
}

async function grantedReceiptBags(
  tx: Reader,
  receiptBagIds: readonly string[],
): Promise<Set<string>> {
  if (receiptBagIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: receiptShortageEntitlements.storeReceiptBagId })
    .from(receiptShortageEntitlements)
    .where(inArray(receiptShortageEntitlements.storeReceiptBagId, [...receiptBagIds]));
  return new Set(rows.map((row) => row.id));
}

async function assertBagNotInOpenDocument(
  tx: Transaction,
  receiptBagId: string,
  inventoryBagId: string,
): Promise<void> {
  const [open] = await tx
    .select({ code: storeReceiptAdjustments.code })
    .from(storeReceiptAdjustmentLines)
    .innerJoin(
      storeReceiptAdjustments,
      eq(storeReceiptAdjustments.id, storeReceiptAdjustmentLines.adjustmentId),
    )
    .where(
      and(
        eq(storeReceiptAdjustmentLines.storeReceiptBagId, receiptBagId),
        inArray(storeReceiptAdjustments.status, OPEN_DATABASE_STATUSES),
      ),
    )
    .limit(1);
  if (open) {
    throw new StoreOperationConflictError(`Bao đang nằm trong hồ sơ sai lệch ${open.code}.`);
  }
  const [returning] = await tx
    .select({ id: storeReceiptAdjustmentLines.id })
    .from(storeReceiptAdjustmentLines)
    .where(
      and(
        eq(storeReceiptAdjustmentLines.storeInventoryBagId, inventoryBagId),
        eq(storeReceiptAdjustmentLines.holdState, 'returning'),
      ),
    )
    .limit(1);
  if (returning) throw new StoreOperationConflictError('Bao đang được giữ chờ trả kho.');
}

async function lockInventoryBag(tx: Transaction, bagId: string): Promise<InventoryBagRow> {
  const [bag] = await tx
    .select()
    .from(storeInventoryBags)
    .where(eq(storeInventoryBags.id, bagId))
    .for('update')
    .limit(1);
  if (!bag) throw new StoreOperationValidationError('Không tìm thấy bao tồn cửa hàng.');
  return bag;
}

async function setBagHold(
  tx: Transaction,
  input: {
    readonly bag: InventoryBagRow;
    readonly status: BagStatus;
    readonly eventType: 'quarantine' | 'release';
    readonly sourceType: string;
    readonly sourceId: string;
    readonly eventSequence: number;
    readonly reason: string;
    readonly actorUserId: string;
    readonly now: Date;
  },
): Promise<void> {
  const { bag, now } = input;
  const [updated] = await tx
    .update(storeInventoryBags)
    .set({ status: input.status, version: bag.version + 1, updatedAt: now })
    .where(and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)))
    .returning({ id: storeInventoryBags.id });
  if (!updated) throw new StoreOperationConflictError('Bao đã thay đổi; hãy tải lại.');
  await tx.insert(storeInventoryLedgerEntries).values({
    storeInventoryBagId: bag.id,
    storeId: bag.storeId,
    productId: bag.productId,
    eventType: input.eventType,
    weightBeforeKg: bag.currentWeightKg,
    weightAfterKg: bag.currentWeightKg,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    eventSequence: input.eventSequence,
    reason: input.reason,
    metadata: { statusBefore: bag.status, statusAfter: input.status },
    actorUserId: input.actorUserId,
    occurredAt: now,
  });
}

async function bagFacts(
  tx: Reader,
  line: AdjustmentLineRow,
  adjustmentId: string | null,
): Promise<ReceiptAdjustmentBagFacts> {
  const [bag] = await tx
    .select()
    .from(storeInventoryBags)
    .where(eq(storeInventoryBags.id, line.storeInventoryBagId))
    .limit(1);
  if (!bag) throw new StoreOperationValidationError('Không tìm thấy bao tồn cửa hàng.');
  return bagFactsFor(tx, bag, line, adjustmentId ?? undefined);
}

async function bagFactsFor(
  tx: Reader,
  bag: InventoryBagRow,
  line: AdjustmentLineRow | null,
  adjustmentId?: string,
): Promise<ReceiptAdjustmentBagFacts> {
  const [outbounds, transfers, sorting] = await Promise.all([
    tx
      .select({ status: storeOutbounds.status, value: count() })
      .from(storeOutbounds)
      .where(and(eq(storeOutbounds.storeInventoryBagId, bag.id), isNull(storeOutbounds.deletedAt)))
      .groupBy(storeOutbounds.status),
    tx
      .select({ status: storeTransfers.status, value: count() })
      .from(storeTransfers)
      .where(eq(storeTransfers.sourceInventoryBagId, bag.id))
      .groupBy(storeTransfers.status),
    tx
      .select({ value: count() })
      .from(storeSortingEvents)
      .where(eq(storeSortingEvents.storeInventoryBagId, bag.id)),
  ]);
  const byStatus = <T extends string>(rows: { status: T; value: number }[], status: T) =>
    rows.find((row) => row.status === status)?.value ?? 0;
  return {
    status: bag.status,
    initialGrams: kilogramsToGramsExact(bag.initialWeightKg),
    currentGrams: kilogramsToGramsExact(bag.currentWeightKg),
    normalSaleConsumedGrams: kilogramsToGramsExact(bag.normalSaleConsumedKg),
    approvedOutboundCount: byStatus(outbounds, 'approved'),
    pendingOutboundCount: byStatus(outbounds, 'pending'),
    completedTransferCount: byStatus(transfers, 'in_transit') + byStatus(transfers, 'received'),
    draftTransferCount: byStatus(transfers, 'draft'),
    sortingEventCount: sorting[0]?.value ?? 0,
    heldByThisAdjustment:
      line !== null &&
      adjustmentId !== undefined &&
      line.adjustmentId === adjustmentId &&
      line.holdState === 'held' &&
      bag.status === 'quarantined',
    matchesRecordedState:
      line === null ||
      (bag.productId === line.recordedProductId &&
        bag.costVnd === line.recordedCostVnd &&
        kilogramsToGramsExact(bag.initialWeightKg) ===
          kilogramsToGramsExact(line.recordedWeightKg)),
  };
}

async function loadLines(tx: Reader, adjustmentId: string): Promise<AdjustmentLineRow[]> {
  return tx
    .select()
    .from(storeReceiptAdjustmentLines)
    .where(eq(storeReceiptAdjustmentLines.adjustmentId, adjustmentId))
    .orderBy(asc(storeReceiptAdjustmentLines.storeInventoryBagId));
}

function sortLinesByBag(lines: readonly AdjustmentLineRow[]): AdjustmentLineRow[] {
  return [...lines].sort((left, right) =>
    left.storeInventoryBagId.localeCompare(right.storeInventoryBagId),
  );
}

function sortByBag<T extends { readonly inventoryBagId: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.inventoryBagId.localeCompare(right.inventoryBagId));
}

async function assertActiveProducts(tx: Transaction, productIds: readonly string[]): Promise<void> {
  const unique = [...new Set(productIds)];
  const found = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(inArray(products.id, unique), eq(products.isActive, true), isNull(products.deletedAt)),
    );
  if (found.length !== unique.length) {
    throw new StoreOperationValidationError('Mặt hàng thực tế không tồn tại hoặc đã ngừng dùng.');
  }
}

async function updateHeader(
  context: TransitionContext,
  changes: Partial<typeof storeReceiptAdjustments.$inferInsert>,
): Promise<void> {
  const { tx, adjustment, next, now } = context;
  const [updated] = await tx
    .update(storeReceiptAdjustments)
    .set({ ...changes, status: next, version: adjustment.version + 1, updatedAt: now })
    .where(
      and(
        eq(storeReceiptAdjustments.id, adjustment.id),
        eq(storeReceiptAdjustments.version, adjustment.version),
        ne(storeReceiptAdjustments.status, 'applied'),
      ),
    )
    .returning({ id: storeReceiptAdjustments.id });
  if (!updated) throw new StoreOperationConflictError('Hồ sơ sai lệch đã thay đổi khi xử lý.');
}

async function audit(context: TransitionContext, action: string, after: JsonObject): Promise<void> {
  await context.tx.insert(auditLogs).values({
    requestId: context.input.requestId ?? null,
    actorUserId: context.actor.userId,
    actorRole: context.actor.databaseRole,
    actorStoreId: context.adjustment.storeId,
    action,
    entityType: 'store_receipt_adjustment',
    entityId: context.adjustment.id,
    before: { status: context.adjustment.status, version: context.adjustment.version },
    after: { ...after, status: context.next, version: context.adjustment.version + 1 },
  });
}

function planLineOrThrow(input: {
  readonly approvedProductId: string | null;
  readonly recordedProductId: string;
  readonly actualProductId: string;
  readonly recordedWeightKg: string;
  readonly recordedCostVnd: bigint;
  readonly verifiedWeightKg: string;
  readonly verifiedPricePerKgVnd: bigint;
  readonly shortageAlreadyGranted: boolean;
}) {
  const verifiedGrams = kilogramsToGramsExact(input.verifiedWeightKg);
  if (verifiedGrams <= 0n) throw new StoreOperationValidationError('Kg xác minh phải dương.');
  if (input.verifiedPricePerKgVnd < 0n || input.verifiedPricePerKgVnd > 9_007_199_254_740_991n) {
    throw new StoreOperationValidationError('Giá/kg không hợp lệ.');
  }
  return domainOrValidation(() =>
    planReceiptAdjustmentLine({
      approvedProductId: input.approvedProductId,
      recordedProductId: input.recordedProductId,
      actualProductId: input.actualProductId,
      recordedWeightGrams: kilogramsToGramsExact(input.recordedWeightKg),
      recordedCostVnd: input.recordedCostVnd,
      verifiedWeightGrams: verifiedGrams,
      verifiedPricePerKgVnd: input.verifiedPricePerKgVnd,
      shortageAlreadyGranted: input.shortageAlreadyGranted,
    }),
  );
}

const DOMAIN_MESSAGES: Record<string, string> = {
  'The verified SKU must differ from the SKU currently recorded for the bag':
    'Mặt hàng thực tế phải khác mặt hàng đang ghi nhận của bao.',
  'A bag whose missing approved SKU already has a priority wait cannot be reclassified back to that SKU':
    'Bao đã phát sinh quyền chờ bù mặt hàng duyệt; không phân loại ngược về mặt hàng đó. Cần đối soát phiếu chờ trước.',
  'VAT was never captured for this receipt; a VAT adjustment cannot turn it into a known amount':
    'Phiếu cũ chưa ghi nhận VAT; không được điều chỉnh VAT (giữ trạng thái chưa ghi nhận).',
};

function domainOrValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DomainError) {
      const message =
        DOMAIN_MESSAGES[error.message] ??
        (error.message.startsWith('Adjusted ')
          ? 'Giá trị sau điều chỉnh không được âm.'
          : error.message);
      throw new StoreOperationValidationError(message);
    }
    throw error;
  }
}

function validateReportedLines(lines: readonly ReportedAdjustmentLineInput[]): void {
  if (lines.length === 0 || lines.length > MAX_LINES) {
    throw new StoreOperationValidationError(`Chọn từ 1 đến ${MAX_LINES} bao.`);
  }
  if (new Set(lines.map((line) => line.receiptBagId)).size !== lines.length) {
    throw new StoreOperationValidationError('Mỗi bao chỉ chọn một lần.');
  }
}

function validateDiscoveredAt(value: Date): void {
  if (Number.isNaN(value.getTime()) || value.getTime() > Date.now() + 5 * 60_000) {
    throw new StoreOperationValidationError('Thời điểm phát hiện không hợp lệ.');
  }
}

function validateTransitionInput(input: ReceiptAdjustmentTransitionInput): void {
  if (input.action === 'RESUBMIT') {
    validateReportedLines(input.lines);
    validateDiscoveredAt(input.discoveredAt);
  }
  if (input.action === 'VERIFY') {
    if (input.lines.length === 0 || input.lines.length > MAX_LINES) {
      throw new StoreOperationValidationError('Cần xác minh đủ từng bao trong hồ sơ.');
    }
    for (const value of [input.freightDeltaVnd, input.handlingDeltaVnd, input.vatDeltaVnd]) {
      if (value > 9_007_199_254_740_991n || value < -9_007_199_254_740_991n) {
        throw new StoreOperationValidationError('Chênh lệch tiền vượt giới hạn.');
      }
    }
  }
}

function requiredNote(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > max) {
    throw new StoreOperationValidationError(`${field} cần từ 3 đến ${max} ký tự.`);
  }
  return normalized;
}

function optionalNote(value: string | null | undefined, field: string, max: number): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return requiredNote(value, field, max);
}

type MoneyJson = {
  readonly goodsVnd: string;
  readonly freightVnd: string;
  readonly handlingVnd: string;
  readonly vatVnd: string | null;
};

function moneyView(state: ReceiptMoneyState): ReceiptMoneyView {
  const costVnd = state.goodsVnd + state.freightVnd + state.handlingVnd;
  return { ...state, costVnd, totalVnd: state.vatVnd === null ? null : costVnd + state.vatVnd };
}

function moneyJson(view: ReceiptMoneyView): JsonObject {
  return {
    goodsVnd: view.goodsVnd.toString(),
    freightVnd: view.freightVnd.toString(),
    handlingVnd: view.handlingVnd.toString(),
    vatVnd: view.vatVnd === null ? null : view.vatVnd.toString(),
    costVnd: view.costVnd.toString(),
    totalVnd: view.totalVnd === null ? null : view.totalVnd.toString(),
  };
}

function moneyFromJson(value: MoneyJson): ReceiptMoneyView {
  return moneyView({
    goodsVnd: BigInt(value.goodsVnd),
    freightVnd: BigInt(value.freightVnd),
    handlingVnd: BigInt(value.handlingVnd),
    vatVnd: value.vatVnd === null ? null : BigInt(value.vatVnd),
  });
}

function jsonChanges(changes: Partial<typeof storeReceiptReturns.$inferInsert>): JsonObject {
  return Object.fromEntries(
    Object.entries(changes).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : ((value ?? null) as string | number | null),
    ]),
  );
}

function mutationResult(value: ReceiptAdjustmentMutationResult, responseStatus: number) {
  return {
    value,
    responseStatus,
    responseBody: { ...value } as JsonObject,
    resourceType: 'store_receipt_adjustment',
    resourceId: value.adjustmentId,
  };
}

function returnResult(value: ReceiptReturnMutationResult, responseStatus: number) {
  return {
    value,
    responseStatus,
    responseBody: { ...value } as JsonObject,
    resourceType: 'store_receipt_return',
    resourceId: value.returnId,
  };
}

export type ReceiptAdjustmentDatabaseStatus = DatabaseStatus;
export type ReceiptReturnDatabaseStatus = ReturnStatus;

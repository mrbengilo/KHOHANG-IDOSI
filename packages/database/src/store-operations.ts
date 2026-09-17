import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  allocationLines,
  auditLogs,
  htkdAssignments,
  outboundRequestLines,
  outboundRequests,
  reservations,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storeOutbounds,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  stores,
  users,
  waitTickets,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const KILOGRAMS_PATTERN = /^(0|[1-9]\d{0,10})(?:\.(\d{1,3}))?$/;

export interface FinalizeStoreReceiptLineInput {
  readonly productId: string;
  readonly pricePerKgVnd: bigint | null;
  readonly bagWeightsKg: readonly string[];
}

export interface FinalizeStoreReceiptInput {
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly reviewedByUserId: string;
  readonly freightVnd: bigint;
  readonly handlingVnd: bigint;
  readonly lines: readonly FinalizeStoreReceiptLineInput[];
  readonly reviewNote?: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface FinalizedStoreReceipt {
  readonly receiptId: string;
  readonly version: number;
  readonly inventoryBagIds: readonly string[];
}

export interface ReviewStoreOutboundInput {
  readonly outboundId: string;
  readonly expectedVersion: number;
  readonly reviewedByUserId: string;
  readonly decision: 'approve' | 'reject';
  readonly note?: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ReviewedStoreOutbound {
  readonly outboundId: string;
  readonly status: 'approved' | 'rejected';
  readonly version: number;
  readonly inventoryBagVersion: number | null;
}

export interface WaitQuantityState {
  readonly id: string;
  readonly originalQuantity: number;
  readonly remainingQuantity: number;
  readonly fulfilledQuantity: number;
  readonly queuedAt: Date;
}

export interface WaitShortageMergePlan {
  readonly originalQuantity: number;
  readonly remainingQuantity: number;
  readonly fulfilledQuantity: number;
  readonly queuedAt: Date;
}

export class StoreOperationConflictError extends Error {
  public readonly code = 'VERSION_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'StoreOperationConflictError';
  }
}

export class StoreOperationValidationError extends Error {
  public readonly code = 'STORE_OPERATION_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'StoreOperationValidationError';
  }
}

export function kilogramsToGramsExact(value: string): bigint {
  const match = KILOGRAMS_PATTERN.exec(value);
  if (!match) {
    throw new StoreOperationValidationError(
      'Weights must be canonical non-negative kilogram strings with at most three decimals.',
    );
  }

  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, '0'));
}

export function gramsToKilogramsExact(grams: bigint): string {
  if (grams < 0n) {
    throw new StoreOperationValidationError('Weight cannot be negative.');
  }

  const whole = grams / 1_000n;
  const fraction = (grams % 1_000n).toString().padStart(3, '0');
  return `${whole}.${fraction}`;
}

export function calculateWeightedCostVnd(weightKg: string, pricePerKgVnd: bigint): bigint {
  assertVnd(pricePerKgVnd, 'pricePerKgVnd');
  const grams = kilogramsToGramsExact(weightKg);
  if (grams <= 0n) {
    throw new StoreOperationValidationError('Receipt bag weight must be positive.');
  }

  const cost = (grams * pricePerKgVnd + 500n) / 1_000n;
  assertVnd(cost, 'bag goods cost');
  return cost;
}

/**
 * Restores an unreceived allocation into its source wait and folds a newer active wait into it.
 * The cancelled active row keeps its historical quantities; only active demand is consolidated.
 */
export function planWaitShortageMerge(
  source: WaitQuantityState,
  active: WaitQuantityState,
  shortage: number,
): WaitShortageMergePlan {
  if (
    source.id === active.id ||
    !Number.isSafeInteger(shortage) ||
    shortage <= 0 ||
    source.remainingQuantity + source.fulfilledQuantity !== source.originalQuantity ||
    active.remainingQuantity + active.fulfilledQuantity !== active.originalQuantity ||
    active.remainingQuantity <= 0 ||
    source.fulfilledQuantity < shortage
  ) {
    throw new StoreOperationValidationError('Wait shortage merge would violate conservation.');
  }

  return {
    originalQuantity: source.originalQuantity + active.remainingQuantity,
    remainingQuantity: source.remainingQuantity + shortage + active.remainingQuantity,
    fulfilledQuantity: source.fulfilledQuantity - shortage,
    queuedAt:
      source.queuedAt.getTime() <= active.queuedAt.getTime() ? source.queuedAt : active.queuedAt,
  };
}

export async function finalizeStoreReceipt(
  database: Database,
  input: FinalizeStoreReceiptInput,
): Promise<IdempotencyResult<FinalizedStoreReceipt>> {
  validateFinalizationInput(input);

  return withIdempotency(
    database,
    {
      scope: `store-receipt.finalize:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const finalized = await finalizeStoreReceiptInTransaction(tx, input);
      const responseBody: JsonObject = {
        receiptId: finalized.receiptId,
        version: finalized.version,
        inventoryBagIds: [...finalized.inventoryBagIds],
      };

      return {
        value: finalized,
        responseStatus: 200,
        responseBody,
        resourceType: 'store_receipt',
        resourceId: finalized.receiptId,
      };
    },
  );
}

export async function finalizeStoreReceiptInTransaction(
  tx: Transaction,
  input: Omit<FinalizeStoreReceiptInput, 'idempotencyKey' | 'requestHash'>,
): Promise<FinalizedStoreReceipt> {
  validateFinalizationInput(input);

  return withAdvisoryLock(tx, 'store-receipt', input.receiptId, async () => {
    const [receipt] = await tx
      .select({
        id: storeReceipts.id,
        receiptNumber: storeReceipts.receiptNumber,
        outboundRequestId: storeReceipts.outboundRequestId,
        storeId: storeReceipts.storeId,
        status: storeReceipts.status,
        discrepancyNote: storeReceipts.discrepancyNote,
        declaredByUserId: storeReceipts.declaredByUserId,
        submittedAt: storeReceipts.submittedAt,
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
      throw new StoreOperationConflictError('Store receipt is stale or not awaiting HTKD review.');
    }
    if (!receipt.declaredByUserId || !receipt.submittedAt) {
      throw new StoreOperationValidationError('Store receipt is missing its store declaration.');
    }

    await assertReviewerMayAccessStore(tx, input.reviewedByUserId, receipt.storeId);

    const persistedLines = await tx
      .select({
        id: storeReceiptLines.id,
        outboundRequestLineId: storeReceiptLines.outboundRequestLineId,
        productId: storeReceiptLines.productId,
        approvedQuantity: storeReceiptLines.approvedQuantity,
        receivedQuantity: storeReceiptLines.receivedQuantity,
      })
      .from(storeReceiptLines)
      .where(eq(storeReceiptLines.storeReceiptId, receipt.id))
      .orderBy(storeReceiptLines.productId)
      .for('update');

    const suppliedByProduct = new Map(input.lines.map((line) => [line.productId, line]));
    if (
      persistedLines.length === 0 ||
      suppliedByProduct.size !== input.lines.length ||
      suppliedByProduct.size !== persistedLines.length
    ) {
      throw new StoreOperationValidationError(
        'Final receipt lines must exactly match the submitted declaration.',
      );
    }

    if (
      persistedLines.some((line) => line.receivedQuantity < line.approvedQuantity) &&
      (!receipt.discrepancyNote || receipt.discrepancyNote.trim().length < 3)
    ) {
      throw new StoreOperationValidationError('A short receipt requires a discrepancy note.');
    }

    const sortedProductIds = persistedLines.map((line) => line.productId).sort();
    return withStoreProductWaitLocks(tx, receipt.storeId, sortedProductIds, async () => {
      let goodsCostVnd = 0n;
      const inventoryBagIds: string[] = [];
      const now = new Date();
      let hasShortage = false;

      for (const persistedLine of persistedLines) {
        const suppliedLine = suppliedByProduct.get(persistedLine.productId);
        if (!suppliedLine) {
          throw new StoreOperationValidationError('A persisted receipt product is missing.');
        }
        if (persistedLine.receivedQuantity > 0 && suppliedLine.pricePerKgVnd === null) {
          throw new StoreOperationValidationError(
            `Product "${persistedLine.productId}" requires a price per kg.`,
          );
        }
        if (suppliedLine.pricePerKgVnd !== null) {
          assertVnd(suppliedLine.pricePerKgVnd, 'pricePerKgVnd');
        }
        if (suppliedLine.bagWeightsKg.length !== persistedLine.receivedQuantity) {
          throw new StoreOperationValidationError(
            `Product "${persistedLine.productId}" requires exactly one weight per received bag.`,
          );
        }

        const [outboundLine] = await tx
          .select({
            productId: outboundRequestLines.productId,
            outboundRequestId: outboundRequestLines.outboundRequestId,
            approvedQuantity: outboundRequestLines.approvedQuantity,
            dispatchedQuantity: outboundRequestLines.dispatchedQuantity,
          })
          .from(outboundRequestLines)
          .where(eq(outboundRequestLines.id, persistedLine.outboundRequestLineId))
          .for('update')
          .limit(1);

        if (
          !outboundLine ||
          outboundLine.outboundRequestId !== receipt.outboundRequestId ||
          outboundLine.productId !== persistedLine.productId ||
          outboundLine.approvedQuantity !== persistedLine.approvedQuantity ||
          outboundLine.dispatchedQuantity !== persistedLine.approvedQuantity
        ) {
          throw new StoreOperationValidationError(
            'Receipt line does not match its dispatched outbound line.',
          );
        }

        const activeReservations = await tx
          .select({
            id: reservations.id,
            allocationLineId: reservations.allocationLineId,
            quantity: reservations.quantity,
          })
          .from(reservations)
          .where(
            and(
              eq(reservations.outboundRequestLineId, persistedLine.outboundRequestLineId),
              eq(reservations.status, 'active'),
              isNull(reservations.deletedAt),
            ),
          )
          .orderBy(reservations.createdAt, reservations.id)
          .for('update');

        const reservedQuantity = activeReservations.reduce(
          (total, reservation) => total + reservation.quantity,
          0,
        );
        if (reservedQuantity !== persistedLine.approvedQuantity) {
          throw new StoreOperationValidationError(
            'Active reservations do not conserve the dispatched receipt quantity.',
          );
        }

        const shortage = persistedLine.approvedQuantity - persistedLine.receivedQuantity;
        hasShortage ||= shortage > 0;
        await applyWarehouseMovement(tx, {
          productId: persistedLine.productId,
          eventType: persistedLine.receivedQuantity === 0 ? 'reservation_release' : 'outbound',
          onHandDelta: -persistedLine.receivedQuantity,
          reservedDelta: -reservedQuantity,
          sourceType: 'store_receipt',
          sourceId: receipt.id,
          reason:
            shortage > 0
              ? 'Store receipt finalized with shortage; unused reservation released'
              : 'Store receipt finalized in full',
          metadata: {
            storeId: receipt.storeId,
            outboundRequestLineId: persistedLine.outboundRequestLineId,
            approvedQuantity: persistedLine.approvedQuantity,
            receivedQuantity: persistedLine.receivedQuantity,
          },
          actorUserId: input.reviewedByUserId,
          occurredAt: now,
        });

        await settleReservations(tx, activeReservations, persistedLine.receivedQuantity, now);
        if (shortage > 0) {
          await restoreShortageWait(
            tx,
            receipt.storeId,
            persistedLine.productId,
            shortage,
            activeReservations.map((reservation) => reservation.allocationLineId),
          );
        }

        let lineGoodsCostVnd = 0n;
        for (const [index, weightKg] of suppliedLine.bagWeightsKg.entries()) {
          const pricePerKgVnd = suppliedLine.pricePerKgVnd;
          if (pricePerKgVnd === null) {
            throw new StoreOperationValidationError('A received bag requires a price per kg.');
          }
          const weightGrams = kilogramsToGramsExact(weightKg);
          if (weightGrams <= 0n) {
            throw new StoreOperationValidationError('Receipt bag weights must be positive.');
          }
          const canonicalWeightKg = gramsToKilogramsExact(weightGrams);
          const bagGoodsCostVnd = calculateWeightedCostVnd(canonicalWeightKg, pricePerKgVnd);
          lineGoodsCostVnd += bagGoodsCostVnd;
          assertVnd(lineGoodsCostVnd, 'line goods cost');

          const bagNumber = index + 1;
          const bagCode = `SRB-${receipt.id}-${persistedLine.id}-${bagNumber}`;
          const [receiptBag] = await tx
            .insert(storeReceiptBags)
            .values({
              storeReceiptLineId: persistedLine.id,
              bagNumber,
              bagCode,
              weightKg: canonicalWeightKg,
              pricePerKgVnd,
              goodsCostVnd: bagGoodsCostVnd,
            })
            .returning({ id: storeReceiptBags.id });
          if (!receiptBag) {
            throw new Error('Store receipt bag insert returned no row.');
          }

          const [inventoryBag] = await tx
            .insert(storeInventoryBags)
            .values({
              bagCode,
              storeId: receipt.storeId,
              productId: persistedLine.productId,
              sourceStoreReceiptBagId: receiptBag.id,
              outboundRequestLineId: persistedLine.outboundRequestLineId,
              status: 'available',
              initialWeightKg: canonicalWeightKg,
              currentWeightKg: canonicalWeightKg,
              costVnd: bagGoodsCostVnd,
              receivedAt: now,
            })
            .returning({ id: storeInventoryBags.id });
          if (!inventoryBag) {
            throw new Error('Store inventory bag insert returned no row.');
          }
          inventoryBagIds.push(inventoryBag.id);

          await tx.insert(storeInventoryLedgerEntries).values({
            storeInventoryBagId: inventoryBag.id,
            storeId: receipt.storeId,
            productId: persistedLine.productId,
            eventType: 'receive',
            weightBeforeKg: '0.000',
            weightAfterKg: canonicalWeightKg,
            sourceType: 'store_receipt_bag',
            sourceId: receiptBag.id,
            reason: 'Store receipt finalized',
            actorUserId: input.reviewedByUserId,
            occurredAt: now,
          });
        }

        goodsCostVnd += lineGoodsCostVnd;
        assertVnd(goodsCostVnd, 'receipt goods cost');
        await tx
          .update(storeReceiptLines)
          .set({
            pricePerKgVnd: suppliedLine.pricePerKgVnd,
            goodsCostVnd: lineGoodsCostVnd,
            shortageReason: shortage > 0 ? receipt.discrepancyNote : null,
            updatedAt: now,
          })
          .where(eq(storeReceiptLines.id, persistedLine.id));

        await tx
          .update(outboundRequestLines)
          .set({
            receivedQuantity: persistedLine.receivedQuantity,
            shortageReason: shortage > 0 ? receipt.discrepancyNote : null,
            updatedAt: now,
          })
          .where(eq(outboundRequestLines.id, persistedLine.outboundRequestLineId));
      }

      const totalCostVnd = goodsCostVnd + input.freightVnd + input.handlingVnd;
      assertVnd(totalCostVnd, 'receipt total cost');

      const [finalized] = await tx
        .update(storeReceipts)
        .set({
          status: 'finalized',
          goodsCostVnd,
          freightVnd: input.freightVnd,
          handlingVnd: input.handlingVnd,
          totalCostVnd,
          reviewedByUserId: input.reviewedByUserId,
          reviewNote: input.reviewNote ?? null,
          finalizedAt: now,
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
      if (!finalized) {
        throw new StoreOperationConflictError('Store receipt changed during finalization.');
      }

      await tx
        .update(outboundRequests)
        .set({
          status: hasShortage ? 'partially_received' : 'received',
          receivedByUserId: receipt.declaredByUserId,
          receivedAt: now,
          version: sql`${outboundRequests.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboundRequests.id, receipt.outboundRequestId),
            eq(outboundRequests.storeId, receipt.storeId),
            isNull(outboundRequests.deletedAt),
          ),
        );

      await tx.insert(auditLogs).values({
        requestId: input.requestId ?? null,
        actorUserId: input.reviewedByUserId,
        actorStoreId: receipt.storeId,
        action: 'STORE_RECEIPT_FINALIZED',
        entityType: 'store_receipt',
        entityId: receipt.id,
        after: {
          status: 'finalized',
          version: finalized.version,
          goodsCostVnd: goodsCostVnd.toString(),
          freightVnd: input.freightVnd.toString(),
          handlingVnd: input.handlingVnd.toString(),
          totalCostVnd: totalCostVnd.toString(),
          inventoryBagIds,
        },
      });

      return { receiptId: receipt.id, version: finalized.version, inventoryBagIds };
    });
  });
}

export async function reviewStoreOutbound(
  database: Database,
  input: ReviewStoreOutboundInput,
): Promise<IdempotencyResult<ReviewedStoreOutbound>> {
  validateOutboundReviewInput(input);

  return withIdempotency(
    database,
    {
      scope: `store-outbound.review:${input.outboundId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const reviewed = await reviewStoreOutboundInTransaction(tx, input);
      const responseBody: JsonObject = { ...reviewed };
      return {
        value: reviewed,
        responseStatus: 200,
        responseBody,
        resourceType: 'store_outbound',
        resourceId: reviewed.outboundId,
      };
    },
  );
}

export async function reviewStoreOutboundInTransaction(
  tx: Transaction,
  input: Omit<ReviewStoreOutboundInput, 'idempotencyKey' | 'requestHash'>,
): Promise<ReviewedStoreOutbound> {
  validateOutboundReviewInput(input);

  return withAdvisoryLock(tx, 'store-outbound', input.outboundId, async () => {
    const [outbound] = await tx
      .select()
      .from(storeOutbounds)
      .where(and(eq(storeOutbounds.id, input.outboundId), isNull(storeOutbounds.deletedAt)))
      .for('update')
      .limit(1);
    if (!outbound || outbound.status !== 'pending' || outbound.version !== input.expectedVersion) {
      throw new StoreOperationConflictError('Store outbound is stale or is no longer pending.');
    }

    await assertReviewerMayAccessStore(tx, input.reviewedByUserId, outbound.storeId);
    const now = new Date();
    let inventoryBagVersion: number | null = null;

    if (input.decision === 'approve') {
      const [bag] = await tx
        .select()
        .from(storeInventoryBags)
        .where(eq(storeInventoryBags.id, outbound.storeInventoryBagId))
        .for('update')
        .limit(1);
      if (
        !bag ||
        bag.storeId !== outbound.storeId ||
        (bag.status !== 'available' && bag.status !== 'opened')
      ) {
        throw new StoreOperationValidationError('Inventory bag is unavailable for outbound.');
      }

      const beforeGrams = kilogramsToGramsExact(bag.currentWeightKg);
      const outboundGrams = kilogramsToGramsExact(outbound.weightKg);
      if (outboundGrams <= 0n || outboundGrams > beforeGrams) {
        throw new StoreOperationValidationError(
          'Outbound weight exceeds the remaining bag weight.',
        );
      }
      const afterGrams = beforeGrams - outboundGrams;
      const afterWeightKg = gramsToKilogramsExact(afterGrams);
      const [updatedBag] = await tx
        .update(storeInventoryBags)
        .set({
          currentWeightKg: afterWeightKg,
          status: afterGrams === 0n ? 'depleted' : 'opened',
          openedAt: bag.openedAt ?? now,
          depletedAt: afterGrams === 0n ? now : null,
          version: bag.version + 1,
          updatedAt: now,
        })
        .where(and(eq(storeInventoryBags.id, bag.id), eq(storeInventoryBags.version, bag.version)))
        .returning({ version: storeInventoryBags.version });
      if (!updatedBag) {
        throw new StoreOperationConflictError('Inventory bag changed during outbound approval.');
      }
      inventoryBagVersion = updatedBag.version;

      await tx.insert(storeInventoryLedgerEntries).values({
        storeInventoryBagId: bag.id,
        storeId: bag.storeId,
        productId: bag.productId,
        eventType: 'consume',
        weightBeforeKg: gramsToKilogramsExact(beforeGrams),
        weightAfterKg: afterWeightKg,
        sourceType: 'store_outbound',
        sourceId: outbound.id,
        reason: `Approved store outbound: ${outbound.reason}`,
        actorUserId: input.reviewedByUserId,
        occurredAt: now,
      });
    }

    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const [reviewed] = await tx
      .update(storeOutbounds)
      .set({
        status,
        reviewedByUserId: input.reviewedByUserId,
        reviewNote: input.note ?? null,
        reviewedAt: now,
        version: outbound.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storeOutbounds.id, outbound.id),
          eq(storeOutbounds.version, input.expectedVersion),
          eq(storeOutbounds.status, 'pending'),
        ),
      )
      .returning({ version: storeOutbounds.version });
    if (!reviewed) {
      throw new StoreOperationConflictError('Store outbound changed during review.');
    }

    await tx.insert(auditLogs).values({
      actorUserId: input.reviewedByUserId,
      actorStoreId: outbound.storeId,
      action: status === 'approved' ? 'STORE_OUTBOUND_APPROVED' : 'STORE_OUTBOUND_REJECTED',
      entityType: 'store_outbound',
      entityId: outbound.id,
      after: {
        status,
        version: reviewed.version,
        inventoryBagVersion,
        weightKg: outbound.weightKg,
        reason: outbound.reason,
      },
    });

    return {
      outboundId: outbound.id,
      status,
      version: reviewed.version,
      inventoryBagVersion,
    };
  });
}

async function settleReservations(
  tx: Transaction,
  activeReservations: readonly {
    readonly id: string;
    readonly quantity: number;
  }[],
  receivedQuantity: number,
  now: Date,
): Promise<void> {
  let remainingReceived = receivedQuantity;
  for (const reservation of activeReservations) {
    const consumedQuantity = Math.min(reservation.quantity, remainingReceived);
    remainingReceived -= consumedQuantity;
    await tx
      .update(reservations)
      .set({
        consumedQuantity,
        status: consumedQuantity > 0 ? 'consumed' : 'released',
        consumedAt: consumedQuantity > 0 ? now : null,
        releasedAt: consumedQuantity < reservation.quantity ? now : null,
        releaseReason:
          consumedQuantity < reservation.quantity ? 'Store receipt declared a shortage' : null,
        updatedAt: now,
      })
      .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'active')));
  }

  if (remainingReceived !== 0) {
    throw new StoreOperationValidationError('Received quantity exceeds its reservations.');
  }
}

async function restoreShortageWait(
  tx: Transaction,
  storeId: string,
  productId: string,
  shortage: number,
  allocationLineIds: readonly (string | null)[],
): Promise<void> {
  const sourceLines = allocationLineIds.filter((id): id is string => id !== null);
  const allocations =
    sourceLines.length === 0
      ? []
      : await tx
          .select({
            waitTicketId: allocationLines.waitTicketId,
            orderRequestItemId: allocationLines.orderRequestItemId,
          })
          .from(allocationLines)
          .where(inArray(allocationLines.id, sourceLines));

  const sourceWaitIds = [
    ...new Set(
      allocations
        .map((allocation) => allocation.waitTicketId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (sourceWaitIds.length > 1) {
    throw new StoreOperationValidationError('A receipt line cannot settle multiple wait tickets.');
  }

  const [activeWait] = await tx
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

  const sourceWaitId = sourceWaitIds[0];
  if (activeWait) {
    if (activeWait.id === sourceWaitId) {
      if (activeWait.fulfilledQuantity < shortage) {
        throw new StoreOperationValidationError('Wait fulfillment cannot cover receipt shortage.');
      }
      await tx
        .update(waitTickets)
        .set({
          remainingQuantity: activeWait.remainingQuantity + shortage,
          fulfilledQuantity: activeWait.fulfilledQuantity - shortage,
          priorityLevel: 'P0B',
          resolvedAt: null,
          resolutionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(waitTickets.id, activeWait.id));
    } else if (sourceWaitId) {
      const [sourceWait] = await tx
        .select()
        .from(waitTickets)
        .where(and(eq(waitTickets.id, sourceWaitId), isNull(waitTickets.deletedAt)))
        .for('update')
        .limit(1);
      if (!sourceWait) {
        throw new StoreOperationValidationError('Source wait ticket no longer exists.');
      }
      const plan = planWaitShortageMerge(sourceWait, activeWait, shortage);
      const mergedAt = new Date();
      await tx
        .update(waitTickets)
        .set({
          status: 'cancelled',
          resolvedAt: mergedAt,
          resolutionReason: `Outstanding demand merged into wait ticket ${sourceWait.id}`,
          updatedAt: mergedAt,
        })
        .where(and(eq(waitTickets.id, activeWait.id), eq(waitTickets.status, 'active')));
      await tx
        .update(waitTickets)
        .set({
          status: 'active',
          originalQuantity: plan.originalQuantity,
          remainingQuantity: plan.remainingQuantity,
          fulfilledQuantity: plan.fulfilledQuantity,
          priorityLevel: 'P0B',
          queuedAt: plan.queuedAt,
          resolvedAt: null,
          resolutionReason: null,
          updatedAt: mergedAt,
        })
        .where(eq(waitTickets.id, sourceWait.id));
    } else {
      await tx
        .update(waitTickets)
        .set({
          originalQuantity: activeWait.originalQuantity + shortage,
          remainingQuantity: activeWait.remainingQuantity + shortage,
          updatedAt: new Date(),
        })
        .where(eq(waitTickets.id, activeWait.id));
    }
    return;
  }

  if (sourceWaitId) {
    const [sourceWait] = await tx
      .select()
      .from(waitTickets)
      .where(and(eq(waitTickets.id, sourceWaitId), isNull(waitTickets.deletedAt)))
      .for('update')
      .limit(1);
    if (!sourceWait || sourceWait.fulfilledQuantity < shortage) {
      throw new StoreOperationValidationError('Wait fulfillment cannot cover receipt shortage.');
    }
    await tx
      .update(waitTickets)
      .set({
        status: 'active',
        remainingQuantity: sourceWait.remainingQuantity + shortage,
        fulfilledQuantity: sourceWait.fulfilledQuantity - shortage,
        priorityLevel: 'P0B',
        resolvedAt: null,
        resolutionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(waitTickets.id, sourceWait.id));
    return;
  }

  const sourceOrderRequestItemId = allocations.find(
    (allocation) => allocation.orderRequestItemId !== null,
  )?.orderRequestItemId;
  if (!sourceOrderRequestItemId) {
    throw new StoreOperationValidationError('Receipt shortage has no originating order item.');
  }
  await tx.insert(waitTickets).values({
    storeId,
    productId,
    sourceOrderRequestItemId,
    status: 'active',
    priorityLevel: 'P0B',
    originalQuantity: shortage,
    remainingQuantity: shortage,
    fulfilledQuantity: 0,
  });
}

async function assertReviewerMayAccessStore(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!store) {
    throw new StoreOperationValidationError('Store is inactive or deleted.');
  }

  const [user] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active' || (user.role !== 'admin' && user.role !== 'htkd')) {
    throw new StoreOperationValidationError('Reviewer is not an active admin or HTKD account.');
  }
  if (user.role === 'admin') {
    return;
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
    throw new StoreOperationValidationError('HTKD reviewer is not assigned to this store.');
  }
}

async function withStoreProductWaitLocks<T>(
  tx: Transaction,
  storeId: string,
  productIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const sortedProductIds = [...new Set(productIds)].sort();
  const acquire = async (index: number): Promise<T> => {
    const productId = sortedProductIds[index];
    return productId === undefined
      ? operation()
      : withAdvisoryLock(tx, 'store-product-wait', `${storeId}:${productId}`, () =>
          acquire(index + 1),
        );
  };
  return acquire(0);
}

function validateFinalizationInput(
  input: Omit<FinalizeStoreReceiptInput, 'idempotencyKey' | 'requestHash'>,
): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new StoreOperationValidationError('expectedVersion must be a non-negative safe integer.');
  }
  assertVnd(input.freightVnd, 'freightVnd');
  assertVnd(input.handlingVnd, 'handlingVnd');
  if (input.lines.length === 0) {
    throw new StoreOperationValidationError('A receipt must contain at least one line.');
  }
  if (new Set(input.lines.map((line) => line.productId)).size !== input.lines.length) {
    throw new StoreOperationValidationError('Receipt products must be unique.');
  }
  for (const line of input.lines) {
    if (line.pricePerKgVnd !== null) {
      assertVnd(line.pricePerKgVnd, 'pricePerKgVnd');
    }
    for (const weightKg of line.bagWeightsKg) {
      if (kilogramsToGramsExact(weightKg) <= 0n) {
        throw new StoreOperationValidationError('Receipt bag weights must be positive.');
      }
    }
  }
}

function validateOutboundReviewInput(
  input: Omit<ReviewStoreOutboundInput, 'idempotencyKey' | 'requestHash'>,
): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new StoreOperationValidationError('expectedVersion must be a non-negative safe integer.');
  }
  if (input.decision === 'reject' && (input.note?.trim().length ?? 0) < 3) {
    throw new StoreOperationValidationError(
      'A rejection requires a note of at least 3 characters.',
    );
  }
}

function assertVnd(value: bigint, field: string): void {
  if (value < 0n || value > POSTGRES_BIGINT_MAX) {
    throw new StoreOperationValidationError(`${field} is outside the supported VND range.`);
  }
}

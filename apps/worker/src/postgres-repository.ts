import { createHash } from 'node:crypto';

import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  auditLogs,
  dailyPriorityOffers,
  inventorySnapshotItems,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  products,
  reservations,
  stores,
  waitTickets,
  warehouseBalances,
  warehouseLedgerEntries,
  withAdvisoryLock,
  withSerializableTransaction,
  type Database,
  type DatabaseClient,
  type JsonObject,
  type Transaction,
} from '@idosi/database';
import {
  businessDate,
  createStoreOrderRequest,
  isoTimestamp,
  mergeOrderRequests,
  type AllocationRemainder,
  type DailyPriorityOffer,
  type MergedDemand,
  type StoreOrderRequest,
  type WaitTicket,
} from '@idosi/domain';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, sql } from 'drizzle-orm';

import { planPriorityOffers, planProductAllocation } from './planning.js';
import {
  isRunnableSessionStatus,
  mapDatabaseNewOrderPriority,
  mapDatabaseOfferStatus,
  mapDatabaseOrderRequestStatus,
} from './state-mappers.js';
import type {
  AllocationJobRepository,
  DueSessionQuery,
  JobExecutionResult,
  ScheduledAllocationSession,
} from './types.js';

const LOCK_NAMESPACE = 'idosi-allocation-worker';
const ACTIVE_SESSION_STATUSES = ['open', 'closed', 'allocating'] as const;

type SnapshotRow = typeof inventorySnapshots.$inferSelect;
type SnapshotItemRow = typeof inventorySnapshotItems.$inferSelect;
type WaitTicketRow = typeof waitTickets.$inferSelect;
type OfferRow = typeof dailyPriorityOffers.$inferSelect;

interface PersistedMergedDemand {
  readonly demand: MergedDemand;
  readonly mergedOrderId: string;
  readonly mergedOrderItemId: string;
}

interface MergedDemandResolution {
  readonly allocatedQuantity: number;
  readonly waitlistedQuantity: number;
}

/** PostgreSQL adapter. Every scheduled job is one serializable, advisory-locked transaction. */
export class PostgresAllocationJobRepository implements AllocationJobRepository {
  readonly #client: DatabaseClient;
  readonly #database: Database;

  public constructor(client: DatabaseClient) {
    this.#client = client;
    this.#database = client.db;
  }

  public async listDueSessions(
    query: DueSessionQuery,
  ): Promise<readonly ScheduledAllocationSession[]> {
    const rows = await this.#database
      .select({
        id: orderSessions.id,
        businessDate: orderSessions.businessDate,
        snapshotDueAt: orderSessions.inventorySnapshotDueAt,
        finalDueAt: orderSessions.requestDeadlineAt,
        policyVersion: orderSessions.policyVersion,
      })
      .from(orderSessions)
      .where(
        and(
          inArray(orderSessions.status, ACTIVE_SESSION_STATUSES),
          isNull(orderSessions.deletedAt),
          gte(orderSessions.businessDate, query.earliestBusinessDate),
          lte(orderSessions.inventorySnapshotDueAt, query.now),
        ),
      )
      .orderBy(
        asc(orderSessions.businessDate),
        asc(orderSessions.inventorySnapshotDueAt),
        asc(orderSessions.id),
      )
      .limit(query.limit);

    return rows;
  }

  public async captureSnapshotAndCreateOffers(
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult> {
    return withSerializableTransaction(this.#database, (tx) =>
      withAdvisoryLock(tx, LOCK_NAMESPACE, `snapshot:${session.id}:${session.businessDate}`, () =>
        this.#captureSnapshot(tx, session, processedAt),
      ),
    );
  }

  public async expireOffersAndFinalizeAllocation(
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult> {
    return withSerializableTransaction(this.#database, (tx) =>
      withAdvisoryLock(tx, LOCK_NAMESPACE, 'finalize-0900', () =>
        this.#finalizeAllocation(tx, session, processedAt),
      ),
    );
  }

  public async ping(): Promise<void> {
    await this.#database.execute(sql`select 1`);
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }

  async #captureSnapshot(
    tx: Transaction,
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult> {
    const lockedSession = await lockSession(tx, session.id);

    const [completed] = await tx
      .select({ id: inventorySnapshots.id })
      .from(inventorySnapshots)
      .where(
        and(
          eq(inventorySnapshots.orderSessionId, session.id),
          eq(inventorySnapshots.businessDate, session.businessDate),
          eq(inventorySnapshots.snapshotType, 'opening_0800'),
          eq(inventorySnapshots.status, 'completed'),
          isNull(inventorySnapshots.deletedAt),
        ),
      )
      .limit(1);
    if (completed) {
      return { replayed: true, resourceId: completed.id, affectedRows: 0 };
    }
    assertSessionMatches(lockedSession, session);

    const historicalBalances = await loadBalancesAt(tx, session.snapshotDueAt);
    const snapshotId = deterministicUuid(
      `snapshot:${session.id}:${session.businessDate}:opening_0800`,
    );
    const [incomplete] = await tx
      .select({ id: inventorySnapshots.id })
      .from(inventorySnapshots)
      .where(
        and(
          eq(inventorySnapshots.orderSessionId, session.id),
          eq(inventorySnapshots.businessDate, session.businessDate),
          eq(inventorySnapshots.snapshotType, 'opening_0800'),
          isNull(inventorySnapshots.deletedAt),
        ),
      )
      .limit(1);
    const persistedSnapshotId = incomplete?.id ?? snapshotId;

    if (incomplete) {
      await tx
        .delete(inventorySnapshotItems)
        .where(eq(inventorySnapshotItems.snapshotId, incomplete.id));
      await tx
        .update(inventorySnapshots)
        .set({
          status: 'capturing',
          capturedAt: session.snapshotDueAt,
          balanceVersion: Math.max(0, ...historicalBalances.map((item) => item.version)),
          failureReason: null,
          completedAt: null,
        })
        .where(eq(inventorySnapshots.id, incomplete.id));
    } else {
      await tx.insert(inventorySnapshots).values({
        id: snapshotId,
        orderSessionId: session.id,
        businessDate: session.businessDate,
        snapshotType: 'opening_0800',
        status: 'capturing',
        capturedAt: session.snapshotDueAt,
        balanceVersion: Math.max(0, ...historicalBalances.map((item) => item.version)),
      });
    }

    if (historicalBalances.length > 0) {
      await tx.insert(inventorySnapshotItems).values(
        historicalBalances.map((item) => ({
          id: deterministicUuid(`snapshot-item:${persistedSnapshotId}:${item.productId}`),
          snapshotId: persistedSnapshotId,
          productId: item.productId,
          onHandQuantity: item.onHand,
          reservedQuantity: item.reserved,
          availableQuantity: item.onHand - item.reserved,
          warehouseBalanceVersion: item.version,
        })),
      );
    }

    const ticketRows = await loadActiveWaitTickets(tx);
    const allocatedOfferIds = await loadAllocatedOfferIds(tx);
    const offerRows = await tx
      .select()
      .from(dailyPriorityOffers)
      .where(
        and(
          lte(dailyPriorityOffers.businessDate, session.businessDate),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      );
    const domainTickets = await toDomainWaitTickets(tx, ticketRows);
    const domainOffers = offerRows.map((row) => toDomainOffer(row, allocatedOfferIds.has(row.id)));
    const offers =
      session.finalDueAt.getTime() > session.snapshotDueAt.getTime()
        ? planPriorityOffers({
            businessDate: session.businessDate,
            createdAt: session.snapshotDueAt.toISOString(),
            expiresAt: session.finalDueAt.toISOString(),
            snapshots: historicalBalances.map((item) => ({
              id: `${persistedSnapshotId}:${item.productId}`,
              version: String(item.version),
              productId: item.productId,
              availableQuantity: item.onHand - item.reserved,
              capturedAt: session.snapshotDueAt.toISOString(),
            })),
            waitTickets: domainTickets,
            existingOffers: domainOffers,
            offerId: (ticketId) =>
              deterministicUuid(`priority-offer:${session.businessDate}:${ticketId}:1`),
          })
        : [];

    if (offers.length > 0) {
      await tx.insert(dailyPriorityOffers).values(
        offers.map((offer) => ({
          id: offer.id,
          businessDate: offer.businessDate,
          storeId: offer.storeId,
          productId: offer.productId,
          waitTicketId: offer.waitTicketId,
          priorityLevel: 'P0A' as const,
          roundNumber: 1,
          offeredQuantity: offer.offeredQuantity,
          acceptedQuantity: 0,
          status: 'offered' as const,
          responseDeadlineAt: new Date(offer.expiresAt),
          createdAt: new Date(offer.createdAt),
          updatedAt: processedAt,
        })),
      );
    }

    await tx
      .update(inventorySnapshots)
      .set({ status: 'completed', completedAt: processedAt })
      .where(eq(inventorySnapshots.id, persistedSnapshotId));
    await tx.insert(auditLogs).values({
      id: deterministicUuid(`audit:snapshot:${persistedSnapshotId}`),
      action: 'allocation.snapshot_0800.completed',
      entityType: 'inventory_snapshot',
      entityId: persistedSnapshotId,
      metadata: {
        businessDate: session.businessDate,
        productCount: historicalBalances.length,
        priorityOfferCount: offers.length,
        scheduledAt: session.snapshotDueAt.toISOString(),
        processedAt: processedAt.toISOString(),
      },
      createdAt: processedAt,
    });

    return {
      replayed: false,
      resourceId: persistedSnapshotId,
      affectedRows: historicalBalances.length + offers.length + 1,
    };
  }

  async #finalizeAllocation(
    tx: Transaction,
    session: ScheduledAllocationSession,
    processedAt: Date,
  ): Promise<JobExecutionResult> {
    const lockedSession = await lockSession(tx, session.id);
    const idempotencyKey = `allocation:${session.id}:${session.businessDate}:0900`;
    const [completedRun] = await tx
      .select({ id: allocationRuns.id })
      .from(allocationRuns)
      .where(
        and(
          eq(allocationRuns.idempotencyKey, idempotencyKey),
          eq(allocationRuns.status, 'completed'),
          isNull(allocationRuns.deletedAt),
        ),
      )
      .limit(1);
    if (completedRun) {
      return { replayed: true, resourceId: completedRun.id, affectedRows: 0 };
    }
    assertSessionMatches(lockedSession, session);

    const [snapshot] = await tx
      .select()
      .from(inventorySnapshots)
      .where(
        and(
          eq(inventorySnapshots.orderSessionId, session.id),
          eq(inventorySnapshots.businessDate, session.businessDate),
          eq(inventorySnapshots.snapshotType, 'opening_0800'),
          eq(inventorySnapshots.status, 'completed'),
          isNull(inventorySnapshots.deletedAt),
        ),
      )
      .limit(1);
    if (!snapshot) {
      throw new Error(`Opening snapshot is missing for allocation session ${session.id}.`);
    }

    await tx
      .update(dailyPriorityOffers)
      .set({ status: 'expired', acceptedQuantity: 0, updatedAt: processedAt })
      .where(
        and(
          eq(dailyPriorityOffers.status, 'offered'),
          lte(dailyPriorityOffers.responseDeadlineAt, session.finalDueAt),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      );

    const snapshotItems = await tx
      .select()
      .from(inventorySnapshotItems)
      .where(eq(inventorySnapshotItems.snapshotId, snapshot.id))
      .orderBy(asc(inventorySnapshotItems.productId));
    const requests = await loadRequestsForAllocation(tx, session);
    const mergedDemands = mergeOrderRequests(requests);

    const maximumRows = await tx
      .select({ maximumRunNumber: max(allocationRuns.runNumber) })
      .from(allocationRuns)
      .where(eq(allocationRuns.orderSessionId, session.id));
    const maximumRunNumber = maximumRows[0]?.maximumRunNumber;
    const runNumber = (maximumRunNumber ?? 0) + 1;
    const runId = deterministicUuid(`allocation-run:${idempotencyKey}`);
    const existingRun = await tx
      .select({ id: allocationRuns.id, runNumber: allocationRuns.runNumber })
      .from(allocationRuns)
      .where(eq(allocationRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    const persistedRunId = existingRun[0]?.id ?? runId;
    const persistedRunNumber = existingRun[0]?.runNumber ?? runNumber;

    if (existingRun.length === 0) {
      await tx.insert(allocationRuns).values({
        id: runId,
        orderSessionId: session.id,
        inventorySnapshotId: snapshot.id,
        runNumber,
        status: 'running',
        policyVersion: session.policyVersion,
        policyInput: { businessDate: session.businessDate, phase: 'finalize-0900' },
        idempotencyKey,
        startedAt: processedAt,
      });
    } else {
      await tx
        .update(allocationRuns)
        .set({
          inventorySnapshotId: snapshot.id,
          status: 'running',
          failureReason: null,
          startedAt: processedAt,
          finishedAt: null,
        })
        .where(eq(allocationRuns.id, persistedRunId));
    }

    const activeTicketRows = await loadActiveWaitTickets(tx);
    const domainTickets = await toDomainWaitTickets(tx, activeTicketRows);
    const acceptedRows = await tx
      .select()
      .from(dailyPriorityOffers)
      .where(
        and(
          eq(dailyPriorityOffers.businessDate, session.businessDate),
          eq(dailyPriorityOffers.status, 'accepted'),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      );
    const offers = acceptedRows.map((row) => toDomainOffer(row, false));
    const storeOrder = await loadStoreOrder(tx, mergedDemands, domainTickets);
    const cursorByProduct = await loadPreviousCursors(tx);

    const plannedAllocations = snapshotItems.map((item) => ({
      item,
      result: planProductAllocation({
        allocationId: persistedRunId,
        idempotencyKey: `${idempotencyKey}:${item.productId}`,
        sessionId: session.id,
        policyVersion: session.policyVersion,
        allocatedAt: session.finalDueAt.toISOString(),
        snapshot: snapshotItemPlan(snapshot, item),
        mergedRequests: mergedDemands,
        waitTickets: domainTickets,
        priorityOffers: offers,
        storeOrder,
        startCursor: cursorByProduct[item.productId] ?? null,
      }),
    }));
    const mergedResolutionByDemandId = new Map<string, MergedDemandResolution>();
    for (const { result } of plannedAllocations) {
      for (const remainder of result.remainders) {
        if (remainder.source === 'CONFIRMED_WAIT') continue;
        mergedResolutionByDemandId.set(remainder.demandId, {
          allocatedQuantity: remainder.allocatedQuantity,
          waitlistedQuantity: remainder.remainingQuantity,
        });
      }
    }
    const persistedMerged = await persistMergedDemands(
      tx,
      session,
      mergedDemands,
      mergedResolutionByDemandId,
      persistedRunNumber,
      processedAt,
    );

    const demandById = new Map(mergedDemands.map((demand) => [demand.demandId, demand]));
    const offerByTicketId = new Map(acceptedRows.map((offer) => [offer.waitTicketId, offer]));
    const mergedByDemandId = new Map(persistedMerged.map((item) => [item.demand.demandId, item]));
    const ticketRowById = new Map(activeTicketRows.map((ticket) => [ticket.id, ticket]));
    const nextCursorByProduct: Record<string, string | null> = {};
    let requestedQuantity = 0;
    let allocatedQuantity = 0;
    let waitlistedQuantity = 0;
    let lineSequence = 0;
    let affectedRows = persistedMerged.length;
    const allocatedByRequestItem = new Map<string, number>();
    const waitlistedByRequestItem = new Map<string, number>();
    const waitRemainders: AllocationRemainder[] = [];

    for (const { item, result } of plannedAllocations) {
      nextCursorByProduct[item.productId] = result.nextCursor;
      requestedQuantity += result.remainders.reduce(
        (total, remainder) => total + remainder.requestedQuantity,
        0,
      );
      allocatedQuantity += result.allocatedQuantity;
      waitlistedQuantity += result.remainders.reduce(
        (total, remainder) => total + remainder.remainingQuantity,
        0,
      );

      for (const remainder of result.remainders) {
        if (remainder.source === 'CONFIRMED_WAIT') {
          const ticketId = remainder.sourceWaitTicketId;
          if (!ticketId) throw new Error('Confirmed wait allocation lost its ticket id.');
          const offer = offerByTicketId.get(ticketId);
          const ticket = ticketRowById.get(ticketId);
          if (!offer || !ticket) {
            throw new Error(`Confirmed wait allocation ${ticketId} has no persisted source.`);
          }
          lineSequence += 1;
          const lineId = deterministicUuid(
            `allocation-line:${persistedRunId}:wait:${ticketId}:${offer.id}`,
          );
          await tx.insert(allocationLines).values({
            id: lineId,
            allocationRunId: persistedRunId,
            mergedOrderId: null,
            storeId: remainder.storeId,
            productId: remainder.productId,
            orderRequestItemId: null,
            waitTicketId: ticketId,
            priorityOfferId: offer.id,
            priorityLevel: 'P0A',
            roundNumber: 1,
            sequenceInRound: lineSequence,
            requestedQuantity: remainder.requestedQuantity,
            allocatedQuantity: remainder.allocatedQuantity,
            waitlistedQuantity: remainder.remainingQuantity,
            status: allocationStatus(remainder),
            reasonCode: allocationReason(remainder),
            decisionMetadata: allocationMetadata(result, remainder),
          });
          if (remainder.allocatedQuantity > 0) {
            await tx.insert(reservations).values({
              id: deterministicUuid(`reservation:${lineId}`),
              productId: remainder.productId,
              storeId: remainder.storeId,
              allocationLineId: lineId,
              quantity: remainder.allocatedQuantity,
              status: 'active',
              createdAt: processedAt,
              updatedAt: processedAt,
            });
            const remaining = ticket.remainingQuantity - remainder.allocatedQuantity;
            const fulfilled = ticket.fulfilledQuantity + remainder.allocatedQuantity;
            await tx
              .update(waitTickets)
              .set({
                remainingQuantity: remaining,
                fulfilledQuantity: fulfilled,
                status: remaining === 0 ? 'fulfilled' : 'active',
                resolvedAt: remaining === 0 ? processedAt : null,
                resolutionReason: remaining === 0 ? `Allocated by run ${persistedRunId}` : null,
                updatedAt: processedAt,
              })
              .where(eq(waitTickets.id, ticket.id));
            ticket.remainingQuantity = remaining;
            ticket.fulfilledQuantity = fulfilled;
            ticket.status = remaining === 0 ? 'fulfilled' : 'active';
          }
          affectedRows += 1;
          continue;
        }

        const demand = demandById.get(remainder.demandId);
        const persisted = mergedByDemandId.get(remainder.demandId);
        if (!demand || !persisted) {
          throw new Error(`Order allocation ${remainder.demandId} has no merged provenance.`);
        }
        let allocationLeft = remainder.allocatedQuantity;
        for (const source of demand.sourceLines) {
          const sourceAllocated = Math.min(source.quantity, allocationLeft);
          const sourceWaitlisted = source.quantity - sourceAllocated;
          allocationLeft -= sourceAllocated;
          lineSequence += 1;
          const lineId = deterministicUuid(
            `allocation-line:${persistedRunId}:request:${source.lineId}`,
          );
          await tx.insert(allocationLines).values({
            id: lineId,
            allocationRunId: persistedRunId,
            mergedOrderId: persisted.mergedOrderId,
            storeId: remainder.storeId,
            productId: remainder.productId,
            orderRequestItemId: source.lineId,
            waitTicketId: null,
            priorityOfferId: null,
            priorityLevel: source.priority,
            roundNumber: 1,
            sequenceInRound: lineSequence,
            requestedQuantity: source.quantity,
            allocatedQuantity: sourceAllocated,
            waitlistedQuantity: sourceWaitlisted,
            status: allocationStatusFromQuantities(sourceAllocated, sourceWaitlisted),
            reasonCode: allocationReasonFromQuantities(sourceAllocated, sourceWaitlisted),
            decisionMetadata: allocationMetadata(result, remainder),
          });
          if (sourceAllocated > 0) {
            await tx.insert(reservations).values({
              id: deterministicUuid(`reservation:${lineId}`),
              productId: remainder.productId,
              storeId: remainder.storeId,
              allocationLineId: lineId,
              quantity: sourceAllocated,
              status: 'active',
              createdAt: processedAt,
              updatedAt: processedAt,
            });
          }
          allocatedByRequestItem.set(source.lineId, sourceAllocated);
          waitlistedByRequestItem.set(source.lineId, sourceWaitlisted);
          affectedRows += 1;
        }
        if (allocationLeft !== 0) {
          throw new Error(`Allocation ${remainder.demandId} did not reconcile to its sources.`);
        }
        if (remainder.remainingQuantity > 0) waitRemainders.push(remainder);
      }

      if (result.allocatedQuantity > 0) {
        await applyWarehouseMovement(tx, {
          productId: item.productId,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: result.allocatedQuantity,
          sourceType: 'allocation_run',
          sourceId: persistedRunId,
          eventSequence: 1,
          reason: `09:00 allocation for ${session.businessDate}`,
          metadata: { businessDate: session.businessDate, snapshotId: snapshot.id },
          occurredAt: processedAt,
        });
      }
    }

    await persistRequestResolution(
      tx,
      requests,
      allocatedByRequestItem,
      waitlistedByRequestItem,
      processedAt,
    );
    await persistWaitRemainders(tx, waitRemainders, demandById, processedAt, persistedRunId);
    affectedRows += await materializeOutboundRequests(tx, persistedRunId, session, processedAt);
    const mergedOrderIds = [...new Set(persistedMerged.map((item) => item.mergedOrderId))];
    if (mergedOrderIds.length > 0) {
      await tx
        .update(mergedOrders)
        .set({ status: 'allocated', updatedAt: processedAt })
        .where(inArray(mergedOrders.id, mergedOrderIds));
    }

    await tx
      .update(allocationRuns)
      .set({
        status: 'completed',
        policyInput: {
          businessDate: session.businessDate,
          phase: 'finalize-0900',
          storeOrder,
          nextCursorByProduct,
          snapshotCapturedAt: snapshot.capturedAt.toISOString(),
        },
        requestedQuantity,
        allocatedQuantity,
        waitlistedQuantity,
        finishedAt: processedAt,
      })
      .where(eq(allocationRuns.id, persistedRunId));
    await tx
      .update(orderSessions)
      .set({
        status: 'completed',
        closedAt: lockedSession.closedAt ?? session.finalDueAt,
        completedAt: processedAt,
        version: lockedSession.version + 1,
        updatedAt: processedAt,
      })
      .where(eq(orderSessions.id, session.id));
    await tx.insert(auditLogs).values({
      id: deterministicUuid(`audit:allocation:${persistedRunId}`),
      action: 'allocation.finalize_0900.completed',
      entityType: 'allocation_run',
      entityId: persistedRunId,
      metadata: {
        allocatedQuantity,
        businessDate: session.businessDate,
        processedAt: processedAt.toISOString(),
        requestedQuantity,
        scheduledAt: session.finalDueAt.toISOString(),
        waitlistedQuantity,
      },
      createdAt: processedAt,
    });

    return { replayed: false, resourceId: persistedRunId, affectedRows: affectedRows + 1 };
  }
}

async function materializeOutboundRequests(
  tx: Transaction,
  allocationRunId: string,
  session: ScheduledAllocationSession,
  processedAt: Date,
): Promise<number> {
  const lines = await tx
    .select({
      id: allocationLines.id,
      storeId: allocationLines.storeId,
      productId: allocationLines.productId,
      orderRequestItemId: allocationLines.orderRequestItemId,
      waitTicketId: allocationLines.waitTicketId,
      requestedQuantity: allocationLines.requestedQuantity,
      allocatedQuantity: allocationLines.allocatedQuantity,
      sequenceInRound: allocationLines.sequenceInRound,
    })
    .from(allocationLines)
    .where(
      and(
        eq(allocationLines.allocationRunId, allocationRunId),
        sql`${allocationLines.allocatedQuantity} > 0`,
      ),
    )
    .orderBy(asc(allocationLines.sequenceInRound), asc(allocationLines.id));

  let affectedRows = 0;
  for (const line of lines) {
    const [existing] = await tx
      .select({ id: outboundRequestLines.id })
      .from(outboundRequestLines)
      .where(eq(outboundRequestLines.allocationLineId, line.id))
      .limit(1);
    if (existing) continue;

    let sourceOrderRequestItemId = line.orderRequestItemId;
    if (sourceOrderRequestItemId === null && line.waitTicketId !== null) {
      const [ticket] = await tx
        .select({ sourceOrderRequestItemId: waitTickets.sourceOrderRequestItemId })
        .from(waitTickets)
        .where(eq(waitTickets.id, line.waitTicketId))
        .limit(1);
      sourceOrderRequestItemId = ticket?.sourceOrderRequestItemId ?? null;
    }
    if (sourceOrderRequestItemId === null) {
      throw new Error(`Allocation line ${line.id} has no request provenance for outbound.`);
    }

    const [requestSource] = await tx
      .select({
        requestedByUserId: orderRequests.requestedByUserId,
        storeId: orderRequests.storeId,
      })
      .from(orderRequestItems)
      .innerJoin(orderRequests, eq(orderRequests.id, orderRequestItems.orderRequestId))
      .where(eq(orderRequestItems.id, sourceOrderRequestItemId))
      .limit(1);
    if (!requestSource || requestSource.storeId !== line.storeId) {
      throw new Error(`Allocation line ${line.id} has invalid outbound requester provenance.`);
    }

    const [reservation] = await tx
      .select({
        id: reservations.id,
        productId: reservations.productId,
        storeId: reservations.storeId,
        quantity: reservations.quantity,
        outboundRequestLineId: reservations.outboundRequestLineId,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.allocationLineId, line.id),
          eq(reservations.status, 'active'),
          isNull(reservations.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (
      !reservation ||
      reservation.storeId !== line.storeId ||
      reservation.productId !== line.productId ||
      reservation.quantity !== line.allocatedQuantity ||
      reservation.outboundRequestLineId !== null
    ) {
      throw new Error(`Allocation line ${line.id} has no matching active reservation.`);
    }

    const outboundRequestId = deterministicUuid(`outbound-request:${line.id}`);
    const outboundLineId = deterministicUuid(`outbound-request-line:${line.id}`);
    const requestNumber = [
      'OUT',
      session.businessDate.replaceAll('-', ''),
      String(line.sequenceInRound).padStart(3, '0'),
      line.id.replaceAll('-', '').toUpperCase(),
    ].join('-');
    await tx.insert(outboundRequests).values({
      id: outboundRequestId,
      requestNumber,
      storeId: line.storeId,
      orderSessionId: session.id,
      allocationRunId,
      status: 'reserved',
      requestedByUserId: requestSource.requestedByUserId,
      submittedAt: processedAt,
      approvedAt: processedAt,
      notes: `Automatically materialized from allocation line ${line.id}`,
      createdAt: processedAt,
      updatedAt: processedAt,
    });
    await tx.insert(outboundRequestLines).values({
      id: outboundLineId,
      outboundRequestId,
      productId: line.productId,
      allocationLineId: line.id,
      requestedQuantity: line.requestedQuantity,
      approvedQuantity: line.allocatedQuantity,
      reservedQuantity: line.allocatedQuantity,
      dispatchedQuantity: 0,
      receivedQuantity: 0,
      createdAt: processedAt,
      updatedAt: processedAt,
    });
    const linkedReservations = await tx
      .update(reservations)
      .set({ outboundRequestLineId: outboundLineId, updatedAt: processedAt })
      .where(
        and(
          eq(reservations.id, reservation.id),
          eq(reservations.status, 'active'),
          isNull(reservations.outboundRequestLineId),
        ),
      )
      .returning({ id: reservations.id });
    if (linkedReservations.length !== 1) {
      throw new Error(`Reservation ${reservation.id} changed during outbound materialization.`);
    }
    await tx.insert(auditLogs).values({
      id: deterministicUuid(`audit:outbound-materialized:${outboundRequestId}`),
      action: 'OUTBOUND_REQUEST_MATERIALIZED',
      entityType: 'outbound_request',
      entityId: outboundRequestId,
      after: {
        allocationLineId: line.id,
        allocationRunId,
        approvedQuantity: line.allocatedQuantity,
        productId: line.productId,
        requestNumber,
        status: 'reserved',
        storeId: line.storeId,
      },
      createdAt: processedAt,
    });
    affectedRows += 3;
  }
  return affectedRows;
}

async function lockSession(tx: Transaction, sessionId: string) {
  const [row] = await tx
    .select()
    .from(orderSessions)
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.deletedAt)))
    .for('update')
    .limit(1);
  if (!row) throw new Error(`Allocation session ${sessionId} does not exist.`);
  return row;
}

function assertSessionMatches(
  row: typeof orderSessions.$inferSelect,
  expected: ScheduledAllocationSession,
): void {
  if (
    row.businessDate !== expected.businessDate ||
    row.inventorySnapshotDueAt.getTime() !== expected.snapshotDueAt.getTime() ||
    row.requestDeadlineAt.getTime() !== expected.finalDueAt.getTime() ||
    row.policyVersion !== expected.policyVersion
  ) {
    throw new Error(`Allocation session ${expected.id} changed after it was scheduled.`);
  }
  if (!isRunnableSessionStatus(row.status)) {
    throw new Error(`Allocation session ${expected.id} is not active (status ${row.status}).`);
  }
}

async function loadBalancesAt(tx: Transaction, cutoff: Date) {
  const productRows = await tx
    .select({ id: products.id })
    .from(products)
    .orderBy(asc(products.displayOrder), asc(products.id));
  if (productRows.length === 0) return [];
  const productIds = productRows.map((row) => row.id);
  const ledgerRows = await tx
    .select({
      productId: warehouseLedgerEntries.productId,
      onHand: warehouseLedgerEntries.onHandAfter,
      reserved: warehouseLedgerEntries.reservedAfter,
      occurredAt: warehouseLedgerEntries.occurredAt,
      createdAt: warehouseLedgerEntries.createdAt,
    })
    .from(warehouseLedgerEntries)
    .where(
      and(
        inArray(warehouseLedgerEntries.productId, productIds),
        lte(warehouseLedgerEntries.occurredAt, cutoff),
      ),
    )
    .orderBy(
      asc(warehouseLedgerEntries.productId),
      desc(warehouseLedgerEntries.occurredAt),
      desc(warehouseLedgerEntries.createdAt),
    );
  const balanceRows = await tx
    .select()
    .from(warehouseBalances)
    .where(inArray(warehouseBalances.productId, productIds));
  const currentByProduct = new Map(balanceRows.map((row) => [row.productId, row]));
  const latestByProduct = new Map<string, (typeof ledgerRows)[number]>();
  const ledgerCountByProduct = new Map<string, number>();
  for (const row of ledgerRows) {
    ledgerCountByProduct.set(row.productId, (ledgerCountByProduct.get(row.productId) ?? 0) + 1);
    if (!latestByProduct.has(row.productId)) latestByProduct.set(row.productId, row);
  }

  return productRows.map(({ id: productId }) => {
    const historical = latestByProduct.get(productId);
    const current = currentByProduct.get(productId);
    if (historical) {
      return {
        productId,
        onHand: historical.onHand,
        reserved: historical.reserved,
        version: ledgerCountByProduct.get(productId) ?? 0,
      };
    }
    if (current && current.updatedAt.getTime() <= cutoff.getTime()) {
      return {
        productId,
        onHand: current.onHandQuantity,
        reserved: current.reservedQuantity,
        version: current.version,
      };
    }
    return { productId, onHand: 0, reserved: 0, version: 0 };
  });
}

async function loadActiveWaitTickets(tx: Transaction): Promise<WaitTicketRow[]> {
  return tx
    .select()
    .from(waitTickets)
    .where(
      and(
        eq(waitTickets.status, 'active'),
        isNull(waitTickets.deletedAt),
        sql`${waitTickets.remainingQuantity} > 0`,
      ),
    )
    .orderBy(asc(waitTickets.queuedAt), asc(waitTickets.storeId), asc(waitTickets.id));
}

async function toDomainWaitTickets(
  tx: Transaction,
  rows: readonly WaitTicketRow[],
): Promise<WaitTicket[]> {
  if (rows.length === 0) return [];
  const activeReservationRows = await tx
    .select({
      id: reservations.id,
      quantity: reservations.quantity,
      allocationRunId: allocationLines.allocationRunId,
      waitTicketId: allocationLines.waitTicketId,
      createdAt: reservations.createdAt,
    })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .where(
      and(
        inArray(
          allocationLines.waitTicketId,
          rows.map((row) => row.id),
        ),
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
      ),
    );
  const reservationsByTicket = new Map<string, (typeof activeReservationRows)[number][]>();
  for (const reservation of activeReservationRows) {
    if (!reservation.waitTicketId) continue;
    const group = reservationsByTicket.get(reservation.waitTicketId) ?? [];
    group.push(reservation);
    reservationsByTicket.set(reservation.waitTicketId, group);
  }

  return rows.map((row) => {
    const held = reservationsByTicket.get(row.id) ?? [];
    return {
      id: row.id,
      storeId: row.storeId,
      productId: row.productId,
      openQuantity:
        row.remainingQuantity +
        held.reduce((total, reservation) => total + reservation.quantity, 0),
      reservedQuantity: held.reduce((total, reservation) => total + reservation.quantity, 0),
      originalRequestedAt: isoTimestamp(row.queuedAt.toISOString()),
      createdAt: isoTimestamp(row.createdAt.toISOString()),
      updatedAt: isoTimestamp(row.updatedAt.toISOString()),
      status: 'ACTIVE' as const,
      sources: [],
      reservations: held.map((reservation) => ({
        idempotencyKey: `db-reservation:${reservation.id}`,
        allocationId: reservation.allocationRunId,
        quantity: reservation.quantity,
        reservedAt: isoTimestamp(reservation.createdAt.toISOString()),
        settledByReceiptId: null,
      })),
    };
  });
}

async function loadAllocatedOfferIds(tx: Transaction): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ id: allocationLines.priorityOfferId })
    .from(allocationLines)
    .where(sql`${allocationLines.priorityOfferId} is not null`);
  return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
}

function toDomainOffer(row: OfferRow, consumed: boolean): DailyPriorityOffer {
  const mappedStatus = mapDatabaseOfferStatus(row.status, consumed);
  return {
    id: row.id,
    waitTicketId: row.waitTicketId,
    storeId: row.storeId,
    productId: row.productId,
    businessDate: businessDate(row.businessDate),
    offeredQuantity: row.offeredQuantity,
    confirmedQuantity: row.acceptedQuantity,
    allocatedQuantity: consumed ? row.acceptedQuantity : 0,
    createdAt: isoTimestamp(row.createdAt.toISOString()),
    expiresAt: isoTimestamp(row.responseDeadlineAt.toISOString()),
    status: mappedStatus,
    confirmedAt: row.respondedAt ? isoTimestamp(row.respondedAt.toISOString()) : null,
    confirmationIdempotencyKey: row.status === 'accepted' ? `db-offer:${row.id}` : null,
    allocationId: consumed ? `db-allocation:${row.id}` : null,
  };
}

async function loadRequestsForAllocation(
  tx: Transaction,
  session: ScheduledAllocationSession,
): Promise<StoreOrderRequest[]> {
  const rows = await tx
    .select({
      requestId: orderRequests.id,
      storeId: orderRequests.storeId,
      requestNumber: orderRequests.requestNumber,
      submittedAt: orderRequests.submittedAt,
      status: orderRequests.status,
      lineId: orderRequestItems.id,
      productId: orderRequestItems.productId,
      quantity: orderRequestItems.requestedQuantity,
      priority: orderRequestItems.priorityLevel,
    })
    .from(orderRequests)
    .innerJoin(orderRequestItems, eq(orderRequestItems.orderRequestId, orderRequests.id))
    .where(
      and(
        eq(orderRequests.orderSessionId, session.id),
        inArray(orderRequests.status, ['submitted', 'merged']),
        isNull(orderRequests.deletedAt),
        sql`${orderRequests.submittedAt} is not null`,
        lt(orderRequests.submittedAt, session.finalDueAt),
      ),
    )
    .orderBy(
      asc(orderRequests.storeId),
      asc(orderRequests.requestNumber),
      asc(orderRequestItems.id),
    );
  const grouped = new Map<
    string,
    {
      readonly id: string;
      readonly storeId: string;
      readonly requestNumber: number;
      readonly submittedAt: Date;
      readonly status: typeof orderRequests.$inferSelect.status;
      readonly lines: Array<{
        id: string;
        productId: string;
        quantity: number;
        priority: typeof orderRequestItems.$inferSelect.priorityLevel;
      }>;
    }
  >();
  for (const row of rows) {
    if (!row.submittedAt) continue;
    const existing = grouped.get(row.requestId);
    const line = {
      id: row.lineId,
      productId: row.productId,
      quantity: row.quantity,
      priority: row.priority,
    };
    if (existing) {
      existing.lines.push(line);
    } else {
      grouped.set(row.requestId, {
        id: row.requestId,
        storeId: row.storeId,
        requestNumber: row.requestNumber,
        submittedAt: row.submittedAt,
        status: row.status,
        lines: [line],
      });
    }
  }
  return [...grouped.values()].map((request) => {
    if (request.requestNumber !== 1 && request.requestNumber !== 2) {
      throw new Error(`Invalid request sequence ${request.requestNumber} for ${request.id}.`);
    }
    return createStoreOrderRequest({
      id: request.id,
      sessionId: session.id,
      storeId: request.storeId,
      requestSequence: request.requestNumber,
      idempotencyKey: `db-request:${request.id}`,
      submittedAt: request.submittedAt.toISOString(),
      status: mapDatabaseOrderRequestStatus(request.status),
      lines: request.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        quantity: line.quantity,
        priority: mapDatabaseNewOrderPriority(line.priority),
      })),
    });
  });
}

async function persistMergedDemands(
  tx: Transaction,
  session: ScheduledAllocationSession,
  demands: readonly MergedDemand[],
  resolutionByDemandId: ReadonlyMap<string, MergedDemandResolution>,
  version: number,
  now: Date,
): Promise<PersistedMergedDemand[]> {
  const byStore = new Map<string, MergedDemand[]>();
  for (const demand of demands) {
    const group = byStore.get(demand.storeId) ?? [];
    group.push(demand);
    byStore.set(demand.storeId, group);
  }
  const persisted: PersistedMergedDemand[] = [];
  for (const [storeId, storeDemands] of byStore) {
    const mergedOrderId = deterministicUuid(
      `merged-order:${session.id}:${session.businessDate}:${storeId}:${version}`,
    );
    await tx.insert(mergedOrders).values({
      id: mergedOrderId,
      orderSessionId: session.id,
      storeId,
      version,
      status: 'ready',
      requestCount: new Set(storeDemands.flatMap((demand) => demand.sourceIds)).size,
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    for (const demand of storeDemands) {
      const resolution = resolutionByDemandId.get(demand.demandId);
      if (!resolution) {
        throw new Error(`Merged demand ${demand.demandId} has no allocation resolution.`);
      }
      const mergedOrderItemId = deterministicUuid(
        `merged-order-item:${mergedOrderId}:${demand.productId}`,
      );
      await tx.insert(mergedOrderItems).values({
        id: mergedOrderItemId,
        mergedOrderId,
        productId: demand.productId,
        requestedQuantity: demand.requestedQuantity,
        priorityLevel: demand.priority,
        allocatedQuantity: resolution.allocatedQuantity,
        waitlistedQuantity: resolution.waitlistedQuantity,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(mergedOrderSources).values(
        demand.sourceLines.map((source) => ({
          id: deterministicUuid(`merged-order-source:${mergedOrderItemId}:${source.lineId}`),
          mergedOrderItemId,
          orderRequestItemId: source.lineId,
          requestedQuantity: source.quantity,
          createdAt: now,
        })),
      );
      persisted.push({ demand, mergedOrderId, mergedOrderItemId });
    }
  }
  return persisted;
}

function snapshotItemPlan(snapshot: SnapshotRow, item: SnapshotItemRow) {
  return {
    id: `${snapshot.id}:${item.productId}`,
    version: String(item.warehouseBalanceVersion),
    productId: item.productId,
    availableQuantity: item.availableQuantity,
    capturedAt: snapshot.capturedAt.toISOString(),
  };
}

async function loadStoreOrder(
  tx: Transaction,
  demands: readonly MergedDemand[],
  tickets: readonly WaitTicket[],
): Promise<string[]> {
  const activeStores = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.isActive, true), isNull(stores.deletedAt)))
    .orderBy(asc(stores.displayOrder), asc(stores.code), asc(stores.id));
  const order = activeStores.map((store) => store.id);
  const seen = new Set(order);
  const demandStores = new Set([
    ...demands.map((demand) => demand.storeId),
    ...tickets.map((ticket) => ticket.storeId),
  ]);
  for (const storeId of [...demandStores].sort()) {
    if (!seen.has(storeId)) order.push(storeId);
  }
  return order;
}

async function loadPreviousCursors(tx: Transaction): Promise<Record<string, string | null>> {
  const rows = await tx
    .select({ policyInput: allocationRuns.policyInput })
    .from(allocationRuns)
    .where(and(eq(allocationRuns.status, 'completed'), isNull(allocationRuns.deletedAt)))
    .orderBy(desc(allocationRuns.finishedAt), desc(allocationRuns.createdAt))
    .limit(1);
  const value = rows[0]?.policyInput.nextCursorByProduct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cursors: Record<string, string | null> = {};
  for (const [productId, cursor] of Object.entries(value)) {
    if (typeof cursor === 'string' || cursor === null) cursors[productId] = cursor;
  }
  return cursors;
}

function allocationStatus(remainder: AllocationRemainder) {
  return allocationStatusFromQuantities(remainder.allocatedQuantity, remainder.remainingQuantity);
}

function allocationStatusFromQuantities(allocated: number, waitlisted: number) {
  if (allocated === 0) return 'waitlisted' as const;
  if (waitlisted > 0) return 'partial' as const;
  return 'allocated' as const;
}

function allocationReason(remainder: AllocationRemainder): string {
  return allocationReasonFromQuantities(remainder.allocatedQuantity, remainder.remainingQuantity);
}

function allocationReasonFromQuantities(allocated: number, waitlisted: number): string {
  if (allocated === 0) return 'INSUFFICIENT_SNAPSHOT_STOCK';
  if (waitlisted > 0) return 'PARTIAL_SNAPSHOT_STOCK';
  return 'ALLOCATED_BY_PRIORITY_ROUND_ROBIN';
}

function allocationMetadata(
  result: ReturnType<typeof planProductAllocation>,
  remainder: AllocationRemainder,
): JsonObject {
  const rounds = result.steps
    .filter((step) => step.demandId === remainder.demandId)
    .map((step) => step.round);
  return {
    cursorBefore: result.cursorBefore,
    nextCursor: result.nextCursor,
    policyRounds: rounds,
    snapshotAvailable: result.availableBefore,
    snapshotId: result.snapshotId,
  };
}

async function persistRequestResolution(
  tx: Transaction,
  requests: readonly StoreOrderRequest[],
  allocatedByItem: ReadonlyMap<string, number>,
  waitlistedByItem: ReadonlyMap<string, number>,
  now: Date,
): Promise<void> {
  for (const request of requests) {
    let allocated = 0;
    let waitlisted = 0;
    for (const line of request.lines) {
      const lineAllocated = allocatedByItem.get(line.id) ?? 0;
      const lineWaitlisted = waitlistedByItem.get(line.id) ?? line.quantity;
      allocated += lineAllocated;
      waitlisted += lineWaitlisted;
      await tx
        .update(orderRequestItems)
        .set({
          allocatedQuantity: lineAllocated,
          waitlistedQuantity: lineWaitlisted,
          updatedAt: now,
        })
        .where(eq(orderRequestItems.id, line.id));
    }
    const status =
      allocated === 0 ? 'waitlisted' : waitlisted > 0 ? 'partially_allocated' : 'allocated';
    await tx
      .update(orderRequests)
      .set({ status, updatedAt: now })
      .where(eq(orderRequests.id, request.id));
  }
}

async function persistWaitRemainders(
  tx: Transaction,
  remainders: readonly AllocationRemainder[],
  demandById: ReadonlyMap<string, MergedDemand>,
  now: Date,
  runId: string,
): Promise<void> {
  for (const remainder of remainders) {
    const demand = demandById.get(remainder.demandId);
    const source =
      demand?.sourceLines.find(
        (line) => line.quantity - (remainder.allocatedQuantity > 0 ? line.quantity : 0) > 0,
      ) ?? demand?.sourceLines.at(-1);
    if (!source) throw new Error(`Wait remainder ${remainder.demandId} has no source line.`);
    const [active] = await tx
      .select()
      .from(waitTickets)
      .where(
        and(
          eq(waitTickets.storeId, remainder.storeId),
          eq(waitTickets.productId, remainder.productId),
          eq(waitTickets.status, 'active'),
          isNull(waitTickets.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (active) {
      await tx
        .update(waitTickets)
        .set({
          originalQuantity: active.originalQuantity + remainder.remainingQuantity,
          remainingQuantity: active.remainingQuantity + remainder.remainingQuantity,
          priorityLevel: 'P0B',
          updatedAt: now,
        })
        .where(eq(waitTickets.id, active.id));
    } else {
      await tx.insert(waitTickets).values({
        id: deterministicUuid(`wait-ticket:${runId}:${remainder.storeId}:${remainder.productId}`),
        storeId: remainder.storeId,
        productId: remainder.productId,
        sourceOrderRequestItemId: source.lineId,
        status: 'active',
        priorityLevel: 'P0B',
        originalQuantity: remainder.remainingQuantity,
        remainingQuantity: remainder.remainingQuantity,
        fulfilledQuantity: 0,
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

export function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

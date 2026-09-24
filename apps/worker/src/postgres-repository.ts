import { createHash } from 'node:crypto';

import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  auditLogs,
  dailyPriorityOffers,
  dispatchWarehouseOutboundInTransaction,
  ensureDailyOrderingSession,
  inventorySnapshotItems,
  inventorySnapshots,
  loadWarehouseBalancesAt,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  recordWorkerHeartbeat,
  reservations,
  stores,
  warehouseBalances,
  waitTickets,
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
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm';

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
  WorkerHeartbeat,
} from './types.js';

const LOCK_NAMESPACE = 'idosi-allocation-worker';
/** Row key in worker_heartbeats; replicas share it because they run the same idempotent jobs. */
export const ALLOCATION_WORKER_HEARTBEAT = 'allocation';
const ACTIVE_SESSION_STATUSES = ['open', 'closed', 'allocating'] as const;

type SnapshotRow = typeof inventorySnapshots.$inferSelect;
type SnapshotItemRow = typeof inventorySnapshotItems.$inferSelect;
type WaitTicketRow = typeof waitTickets.$inferSelect;
type OfferRow = typeof dailyPriorityOffers.$inferSelect;

async function releasePriorityOfferHold(
  tx: Transaction,
  offer: OfferRow,
  quantity: number,
  occurredAt: Date,
): Promise<void> {
  await applyWarehouseMovement(tx, {
    productId: offer.productId,
    eventType: 'reservation_release',
    onHandDelta: 0,
    reservedDelta: -quantity,
    sourceType: 'priority_offer',
    sourceId: offer.id,
    eventSequence: 2,
    reason: `Priority offer ${offer.id} released`,
    occurredAt,
  });
}
type AllocationPlan = ReturnType<typeof planProductAllocation>;
type AllocationPolicyStep = AllocationPlan['steps'][number];

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
    await ensureDailyOrderingSession(this.#database, query.now);
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

  public async recordHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    const instant = (value: string | null) => (value === null ? null : new Date(value));
    await recordWorkerHeartbeat(this.#database, {
      worker: ALLOCATION_WORKER_HEARTBEAT,
      lastTickStartedAt: instant(heartbeat.lastTickStartedAt),
      lastTickCompletedAt: instant(heartbeat.lastTickCompletedAt),
      lastSuccessfulTickAt: instant(heartbeat.lastSuccessfulTickAt),
      lastError: heartbeat.lastError,
      failingJobs: heartbeat.failingJobs.map((job) => ({
        kind: job.kind,
        sessionId: job.sessionId,
        scheduledFor: job.scheduledFor,
        status: job.status === 'blocked' ? 'blocked' : 'failed',
        error: job.error ?? null,
      })),
      updatedAt: new Date(heartbeat.recordedAt),
    });
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

    const historicalBalances = await loadWarehouseBalancesAt(tx, session.snapshotDueAt);
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
    const currentBalances = await tx.select().from(warehouseBalances);
    const currentAvailable = new Map(
      currentBalances.map((balance) => [
        balance.productId,
        balance.onHandQuantity - balance.reservedQuantity,
      ]),
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
              availableQuantity: Math.min(
                item.onHand - item.reserved,
                currentAvailable.get(item.productId) ?? 0,
              ),
              capturedAt: session.snapshotDueAt.toISOString(),
            })),
            waitTickets: domainTickets,
            existingOffers: domainOffers,
            alreadyReservedOfferIds: new Set([
              ...allocatedOfferIds,
              ...offerRows.filter((offer) => offer.stockHeldQuantity > 0).map((offer) => offer.id),
            ]),
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
          stockHeldQuantity: offer.offeredQuantity,
          acceptedQuantity: 0,
          status: 'offered' as const,
          responseDeadlineAt: new Date(offer.expiresAt),
          createdAt: new Date(offer.createdAt),
          updatedAt: processedAt,
        })),
      );
      for (const offer of offers) {
        await applyWarehouseMovement(tx, {
          productId: offer.productId,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: offer.offeredQuantity,
          sourceType: 'priority_offer',
          sourceId: offer.id,
          eventSequence: 1,
          reason: `08:00 priority offer for ${session.businessDate}`,
          occurredAt: processedAt,
        });
      }
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

    const expiringOffers = await tx
      .select()
      .from(dailyPriorityOffers)
      .where(
        and(
          eq(dailyPriorityOffers.status, 'offered'),
          lte(dailyPriorityOffers.responseDeadlineAt, session.finalDueAt),
          isNull(dailyPriorityOffers.deletedAt),
        ),
      )
      .for('update');
    for (const offer of expiringOffers) {
      if (offer.stockHeldQuantity > 0) {
        await releasePriorityOfferHold(tx, offer, offer.stockHeldQuantity, processedAt);
      }
    }
    await tx
      .update(dailyPriorityOffers)
      .set({ status: 'expired', acceptedQuantity: 0, stockHeldQuantity: 0, updatedAt: processedAt })
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
    const capacityByProduct = await loadAllocationCapacity(tx, acceptedRows);
    const capacityAdjustments: JsonObject[] = [];
    const allocatableItems = snapshotItems.map((item) => {
      const allocatable = allocatableSnapshotQuantity(
        item.availableQuantity,
        capacityByProduct.get(item.productId) ?? 0,
      );
      if (allocatable !== item.availableQuantity) {
        capacityAdjustments.push({
          productId: item.productId,
          snapshotAvailable: item.availableQuantity,
          allocatable,
        });
      }
      return { ...item, availableQuantity: allocatable };
    });

    const plannedAllocations = allocatableItems.map((item) => ({
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
    const allocatedByOfferId = new Map<string, number>();
    const acceptedOfferByTicketId = new Map(
      acceptedRows.map((offer) => [offer.waitTicketId, offer]),
    );
    for (const { result } of plannedAllocations) {
      for (const remainder of result.remainders) {
        if (remainder.source !== 'CONFIRMED_WAIT' || !remainder.sourceWaitTicketId) continue;
        const offer = acceptedOfferByTicketId.get(remainder.sourceWaitTicketId);
        if (offer) allocatedByOfferId.set(offer.id, remainder.allocatedQuantity);
      }
    }
    const retainedHoldByProduct = new Map<string, number>();
    for (const offer of acceptedRows) {
      const retained = Math.min(offer.stockHeldQuantity, allocatedByOfferId.get(offer.id) ?? 0);
      const unused = offer.stockHeldQuantity - retained;
      if (unused > 0) await releasePriorityOfferHold(tx, offer, unused, processedAt);
      retainedHoldByProduct.set(
        offer.productId,
        (retainedHoldByProduct.get(offer.productId) ?? 0) + retained,
      );
      if (offer.stockHeldQuantity > 0) {
        await tx
          .update(dailyPriorityOffers)
          .set({ stockHeldQuantity: 0, updatedAt: processedAt })
          .where(eq(dailyPriorityOffers.id, offer.id));
      }
    }
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
        const remainderSteps = allocationStepsForRemainder(result, remainder);
        if (remainder.source === 'CONFIRMED_WAIT') {
          const ticketId = remainder.sourceWaitTicketId;
          if (!ticketId) throw new Error('Confirmed wait allocation lost its ticket id.');
          const offer = offerByTicketId.get(ticketId);
          const ticket = ticketRowById.get(ticketId);
          if (!offer || !ticket) {
            throw new Error(`Confirmed wait allocation ${ticketId} has no persisted source.`);
          }
          lineSequence += 1;
          const coordinates = allocationPersistenceCoordinates(
            result,
            remainderSteps,
            lineSequence,
          );
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
            roundNumber: coordinates.roundNumber,
            sequenceInRound: coordinates.sequenceInRound,
            requestedQuantity: remainder.requestedQuantity,
            allocatedQuantity: remainder.allocatedQuantity,
            waitlistedQuantity: remainder.remainingQuantity,
            status: allocationStatus(remainder),
            reasonCode: allocationReason(remainder),
            decisionMetadata: allocationMetadata(result, remainderSteps, remainder.priority),
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
        let allocatedStepOffset = 0;
        for (const source of demand.sourceLines) {
          const sourceAllocated = Math.min(source.quantity, allocationLeft);
          const sourceWaitlisted = source.quantity - sourceAllocated;
          allocationLeft -= sourceAllocated;
          const sourceSteps = remainderSteps.slice(
            allocatedStepOffset,
            allocatedStepOffset + sourceAllocated,
          );
          allocatedStepOffset += sourceAllocated;
          lineSequence += 1;
          const coordinates = allocationPersistenceCoordinates(result, sourceSteps, lineSequence);
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
            roundNumber: coordinates.roundNumber,
            sequenceInRound: coordinates.sequenceInRound,
            requestedQuantity: source.quantity,
            allocatedQuantity: sourceAllocated,
            waitlistedQuantity: sourceWaitlisted,
            status: allocationStatusFromQuantities(sourceAllocated, sourceWaitlisted),
            reasonCode: allocationReasonFromQuantities(sourceAllocated, sourceWaitlisted),
            decisionMetadata: allocationMetadata(result, sourceSteps, remainder.priority),
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
        if (allocationLeft !== 0 || allocatedStepOffset !== remainderSteps.length) {
          throw new Error(`Allocation ${remainder.demandId} did not reconcile to its sources.`);
        }
        if (remainder.remainingQuantity > 0) waitRemainders.push(remainder);
      }

      const additionalReservation =
        result.allocatedQuantity - (retainedHoldByProduct.get(item.productId) ?? 0);
      if (additionalReservation > 0) {
        await applyWarehouseMovement(tx, {
          productId: item.productId,
          eventType: 'reservation',
          onHandDelta: 0,
          reservedDelta: additionalReservation,
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
          capacityAdjustments,
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

export async function materializeOutboundRequests(
  tx: Transaction,
  allocationRunId: string,
  session: ScheduledAllocationSession,
  processedAt: Date,
): Promise<number> {
  // An ordinary request is the shipping trigger, not the priority allocation itself.
  // Reservations from earlier completed cycles remain held and are attached here once.
  const ordinaryOrders = await tx
    .select({ storeId: orderRequests.storeId, requestedByUserId: orderRequests.requestedByUserId })
    .from(orderRequests)
    .where(
      and(
        eq(orderRequests.orderSessionId, session.id),
        inArray(orderRequests.status, [
          'submitted',
          'merged',
          'allocated',
          'partially_allocated',
          'waitlisted',
        ]),
        isNull(orderRequests.deletedAt),
      ),
    )
    .orderBy(asc(orderRequests.storeId), asc(orderRequests.submittedAt), asc(orderRequests.id));
  const requesterByStore = new Map<string, string>();
  for (const order of ordinaryOrders) {
    if (!requesterByStore.has(order.storeId))
      requesterByStore.set(order.storeId, order.requestedByUserId);
  }
  if (requesterByStore.size === 0) return 0;
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
      sourceRunId: allocationLines.allocationRunId,
      reservationId: reservations.id,
      reservationQuantity: reservations.quantity,
    })
    .from(allocationLines)
    .innerJoin(allocationRuns, eq(allocationRuns.id, allocationLines.allocationRunId))
    .innerJoin(reservations, eq(reservations.allocationLineId, allocationLines.id))
    .where(
      and(
        inArray(allocationLines.storeId, [...requesterByStore.keys()]),
        or(
          eq(allocationLines.allocationRunId, allocationRunId),
          eq(allocationRuns.status, 'completed'),
        ),
        sql`${allocationLines.allocatedQuantity} > 0`,
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
        isNull(reservations.outboundRequestLineId),
        eq(reservations.storeId, allocationLines.storeId),
        eq(reservations.productId, allocationLines.productId),
      ),
    )
    .orderBy(
      asc(allocationLines.storeId),
      asc(allocationLines.createdAt),
      asc(allocationLines.sequenceInRound),
      asc(allocationLines.id),
    )
    .for('update', { of: reservations });

  const byStore = new Map<string, typeof lines>();
  for (const line of lines) {
    if (line.reservationQuantity !== line.allocatedQuantity) {
      throw new Error(`Allocation line ${line.id} does not conserve its reserved quantity.`);
    }
    const group = byStore.get(line.storeId) ?? [];
    group.push(line);
    byStore.set(line.storeId, group);
  }
  let affectedRows = 0;
  for (const [storeId, storeLines] of byStore) {
    const outboundRequestId = deterministicUuid(`outbound-shipment:${allocationRunId}:${storeId}`);
    const requestNumber = ''; // Assigned by the database trigger.
    await tx.insert(outboundRequests).values({
      id: outboundRequestId,
      requestNumber,
      storeId,
      orderSessionId: session.id,
      allocationRunId,
      status: 'reserved',
      requestedByUserId: requesterByStore.get(storeId)!,
      submittedAt: processedAt,
      approvedAt: processedAt,
      notes: 'Giao chung đơn thường và hàng ưu tiên đã giữ của cửa hàng',
      createdAt: processedAt,
      updatedAt: processedAt,
    });
    const byProduct = new Map<string, typeof lines>();
    for (const line of storeLines) {
      const group = byProduct.get(line.productId) ?? [];
      group.push(line);
      byProduct.set(line.productId, group);
    }
    for (const [productId, sources] of byProduct) {
      const outboundLineId = deterministicUuid(
        `outbound-shipment-line:${outboundRequestId}:${productId}`,
      );
      const quantity = sources.reduce((total, line) => total + line.allocatedQuantity, 0);
      await tx.insert(outboundRequestLines).values({
        id: outboundLineId,
        outboundRequestId,
        productId,
        // Legacy representative pointer. Every source and quantity remains linked through reservations.
        allocationLineId: sources[0]!.id,
        requestedQuantity: sources.reduce((total, line) => total + line.requestedQuantity, 0),
        approvedQuantity: quantity,
        reservedQuantity: quantity,
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
            inArray(
              reservations.id,
              sources.map((line) => line.reservationId),
            ),
            eq(reservations.status, 'active'),
            isNull(reservations.outboundRequestLineId),
          ),
        )
        .returning({ id: reservations.id });
      if (linkedReservations.length !== sources.length) {
        throw new Error(`Reservations changed during shipment materialization for ${storeId}.`);
      }
      affectedRows += 1 + linkedReservations.length;
    }
    await tx.insert(auditLogs).values({
      id: deterministicUuid(`audit:outbound-materialized:${outboundRequestId}`),
      action: 'OUTBOUND_REQUEST_MATERIALIZED',
      entityType: 'outbound_request',
      entityId: outboundRequestId,
      after: {
        sources: storeLines.map((line) => ({
          allocationLineId: line.id,
          allocationRunId: line.sourceRunId,
          reservationId: line.reservationId,
          productId: line.productId,
          quantity: line.allocatedQuantity,
        })),
        allocationRunId,
        requestNumber,
        status: 'reserved',
        storeId,
      },
      createdAt: processedAt,
    });
    // Nothing else in the product releases an allocation shipment, so the run releases it
    // itself: the store sees it on /receive as soon as the allocation is published. Warehouse
    // stock is unaffected here; it leaves on-hand once, when HTKD finalizes the receipt.
    await dispatchWarehouseOutboundInTransaction(tx, {
      outboundRequestId,
      expectedVersion: 0,
      dispatcher: { kind: 'system', trigger: 'allocation-finalize' },
      dispatchedAt: processedAt,
      auditId: deterministicUuid(`audit:outbound-dispatched:${outboundRequestId}`),
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

/**
 * Stock can leave the warehouse between the 08:00 snapshot and the 09:00 run (a
 * supplier receipt cancelled in between). The run may only reserve what is still
 * physically unreserved now, plus the units it already holds for accepted priority
 * offers, which it re-uses instead of reserving twice.
 */
async function loadAllocationCapacity(
  tx: Transaction,
  acceptedOffers: readonly OfferRow[],
): Promise<Map<string, number>> {
  const balances = await tx.select().from(warehouseBalances);
  const capacity = new Map<string, number>();
  for (const balance of balances) {
    capacity.set(balance.productId, Math.max(0, balance.onHandQuantity - balance.reservedQuantity));
  }
  for (const offer of acceptedOffers) {
    if (offer.stockHeldQuantity <= 0) continue;
    capacity.set(offer.productId, (capacity.get(offer.productId) ?? 0) + offer.stockHeldQuantity);
  }
  return capacity;
}

export function allocatableSnapshotQuantity(snapshotAvailable: number, capacity: number): number {
  return Math.max(0, Math.min(snapshotAvailable, capacity));
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

export function allocationMetadata(
  result: Pick<AllocationPlan, 'cursorBefore' | 'nextCursor' | 'availableBefore' | 'snapshotId'>,
  steps: readonly AllocationPolicyStep[],
  appliedPriority: AllocationRemainder['priority'],
): JsonObject {
  if (steps.some((step) => !Number.isSafeInteger(step.round) || step.round < 1)) {
    throw new Error('Allocation audit rounds must be positive safe integers.');
  }
  if (new Set(steps.map((step) => step.round)).size !== steps.length) {
    throw new Error('Allocation audit rounds must be unique within a source line.');
  }
  return {
    cursorBefore: result.cursorBefore,
    nextCursor: result.nextCursor,
    policyRounds: steps.map((step) => step.round),
    policyRoundsVersion: 1,
    appliedPriority,
    snapshotAvailable: result.availableBefore,
    snapshotId: result.snapshotId,
  };
}

function allocationStepsForRemainder(
  result: AllocationPlan,
  remainder: AllocationRemainder,
): readonly AllocationPolicyStep[] {
  const steps = result.steps.filter((step) => step.demandId === remainder.demandId);
  if (steps.length !== remainder.allocatedQuantity) {
    throw new Error(`Allocation ${remainder.demandId} has inconsistent planner step metadata.`);
  }
  return steps;
}

function allocationPersistenceCoordinates(
  result: AllocationPlan,
  steps: readonly AllocationPolicyStep[],
  fallbackSequence: number,
): { readonly roundNumber: number; readonly sequenceInRound: number } {
  const firstStep = steps[0];
  if (firstStep === undefined) {
    return { roundNumber: 1, sequenceInRound: fallbackSequence };
  }
  const sequenceInRound = result.steps.filter(
    (step) =>
      step.priority === firstStep.priority &&
      step.round === firstStep.round &&
      step.sequence <= firstStep.sequence,
  ).length;
  return { roundNumber: firstStep.round, sequenceInRound };
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
    const source = demand
      ? firstUnderallocatedSourceLine(demand.sourceLines, remainder.allocatedQuantity)
      : undefined;
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

/**
 * Allocation fills a merged demand's source lines in order (see #finalizeAllocation), so the
 * waitlisted remainder starts at the first line that did not receive its full quantity.
 */
export function firstUnderallocatedSourceLine<T extends { readonly quantity: number }>(
  sourceLines: readonly T[],
  allocatedQuantity: number,
): T | undefined {
  let allocationLeft = allocatedQuantity;
  for (const line of sourceLines) {
    const allocated = Math.min(line.quantity, allocationLeft);
    allocationLeft -= allocated;
    if (allocated < line.quantity) return line;
  }
  return sourceLines.at(-1);
}

export function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

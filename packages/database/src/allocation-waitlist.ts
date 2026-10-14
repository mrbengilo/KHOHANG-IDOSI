import { randomUUID } from 'node:crypto';

import {
  partitionRejectedShipmentSources,
  planWaitlistRequeue,
  revokeFromPendingDecision,
  waitTicketGroupKey,
  type WaitlistLine,
} from '@idosi/domain';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import {
  allocationLineDispositions,
  allocationLines,
  allocationResultDecisions,
  auditLogs,
  outboundRequestLines,
  outboundRequests,
  reservations,
  waitTicketSources,
  waitTickets,
  type JsonObject,
} from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

/**
 * Taking granted goods back out of a PENDING allocation result (migration 0044,
 * docs/allocation-waitlist-workflow.md). Two commands use it:
 *
 * - cancelling a wait ticket revokes the lines of that ticket still waiting for an answer;
 * - "Chuyển phiếu chờ" revokes every actionable line of the result and requeues the demand.
 *
 * Goods with an RE order were already issued (reservation 'issued'); they are never selected here
 * because only 'active' holds of a pending result are revocable, and the database refuses an RE
 * source for a revoked line. Releasing a hold is the standard reservation release: on-hand is
 * unchanged (the goods never left), reserved drops by the bags (ΔH = 0, ΔR = −q).
 *
 * Callers hold STOCK_JOBS_LOCK, then the shipment advisory lock, then the decision row FOR UPDATE
 * and the shipment row FOR UPDATE, in that order (the order of every answer and dispatch).
 */

export const WAIT_TICKET_CANCELLED_RELEASE_REASON = 'wait_ticket_cancelled';
export const ALLOCATION_RESULT_WAITLISTED_RELEASE_REASON = 'allocation_result_waitlisted';
export const ALLOCATION_RESULT_DETACHED_REASON = 'detached_from_rejected_shipment';
export const DISPOSITION_LEDGER_SOURCE = 'allocation_line_disposition';

export type DispositionKind = 'wait_ticket_cancelled' | 'waitlisted';
export type RevocationActorRole = 'store' | 'wholesale' | 'htkd' | 'admin';

type DecisionRow = typeof allocationResultDecisions.$inferSelect;
type ShipmentRow = typeof outboundRequests.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;
type LineRow = typeof allocationLines.$inferSelect;

export interface ResultHold {
  readonly reservation: ReservationRow;
  readonly line: LineRow;
}

/** Thrown when locked rows disagree with what a revocation needs; the transaction rolls back. */
export class AllocationRevocationIntegrityError extends Error {
  public readonly code = 'ALLOCATION_REVOCATION_INTEGRITY';

  public constructor(message: string) {
    super(message);
    this.name = 'AllocationRevocationIntegrityError';
  }
}

/** The result's own goods still on hold for the store: exactly what can be answered or revoked. */
export async function lockActionableHolds(
  tx: Transaction,
  decision: Pick<DecisionRow, 'allocationRunId' | 'storeId'>,
  options: { readonly waitTicketId?: string } = {},
): Promise<ResultHold[]> {
  const conditions: SQL[] = [
    eq(allocationLines.allocationRunId, decision.allocationRunId),
    eq(allocationLines.storeId, decision.storeId),
    eq(reservations.storeId, decision.storeId),
    eq(reservations.status, 'active'),
    isNull(reservations.deletedAt),
  ];
  if (options.waitTicketId) conditions.push(eq(allocationLines.waitTicketId, options.waitTicketId));
  return tx
    .select({ reservation: reservations, line: allocationLines })
    .from(reservations)
    .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
    .where(and(...conditions))
    .orderBy(asc(reservations.id))
    .for('update', { of: reservations });
}

/** The live shipment of a result (reserved while the result is pending), or null. */
export async function findResultShipmentId(
  tx: Transaction,
  decision: Pick<DecisionRow, 'allocationRunId' | 'storeId'>,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: outboundRequests.id })
    .from(outboundRequests)
    .where(
      and(
        eq(outboundRequests.allocationRunId, decision.allocationRunId),
        eq(outboundRequests.storeId, decision.storeId),
        isNull(outboundRequests.deletedAt),
        sql`${outboundRequests.status} <> 'cancelled'`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export interface RevokeResultHoldsInput {
  /** Locked FOR UPDATE by the caller, still pending. */
  readonly decision: DecisionRow;
  /** Locked FOR UPDATE by the caller (reserved), or null when the result has no shipment. */
  readonly shipment: ShipmentRow | null;
  /** Subset of lockActionableHolds(decision); every one is revoked. */
  readonly holds: readonly ResultHold[];
  readonly kind: DispositionKind;
  readonly actor: { readonly id: string; readonly role: RevocationActorRole };
  readonly requestId: string | null;
  readonly occurredAt: Date;
}

export interface RevokedDisposition {
  readonly id: string;
  readonly allocationLineId: string;
  readonly reservationId: string;
  readonly productId: string;
  readonly waitTicketId: string | null;
  readonly orderRequestItemId: string | null;
  readonly quantity: number;
}

export interface RevokeResultHoldsResult {
  readonly decision: DecisionRow;
  readonly dispositions: readonly RevokedDisposition[];
  readonly releasedQuantity: number;
  readonly keptHeldQuantity: number;
  readonly cancelledOutboundRequestId: string | null;
}

/**
 * Revokes holds of one pending result. WAITLIST revokes all of them and closes the result as
 * waitlisted; a wait-ticket cancellation revokes that ticket's lines and closes the result as
 * cancelled only when nothing actionable is left. The granted snapshot never changes; the
 * revoked bags are recorded per line and summed on the decision (checked again at commit).
 */
export async function revokeResultHoldsInTransaction(
  tx: Transaction,
  input: RevokeResultHoldsInput,
): Promise<RevokeResultHoldsResult> {
  const { decision, shipment, holds } = input;
  if (decision.status !== 'pending') {
    throw new AllocationRevocationIntegrityError(`Result ${decision.id} is not pending.`);
  }
  if (holds.length === 0) {
    throw new AllocationRevocationIntegrityError('Nothing to revoke.');
  }
  if (shipment && shipment.status !== 'reserved') {
    throw new AllocationRevocationIntegrityError(
      `Shipment ${shipment.id} of a pending result is already ${shipment.status}.`,
    );
  }
  const shipmentLines = shipment
    ? await tx
        .select()
        .from(outboundRequestLines)
        .where(eq(outboundRequestLines.outboundRequestId, shipment.id))
        .orderBy(asc(outboundRequestLines.productId), asc(outboundRequestLines.id))
        .for('update')
    : [];
  const shipmentLineIds = new Set(shipmentLines.map((line) => line.id));
  for (const hold of holds) {
    const { reservation, line } = hold;
    if (
      reservation.status !== 'active' ||
      reservation.deletedAt !== null ||
      line.allocationRunId !== decision.allocationRunId ||
      line.storeId !== decision.storeId ||
      reservation.quantity !== line.allocatedQuantity
    ) {
      throw new AllocationRevocationIntegrityError(
        `Hold ${reservation.id} is not an active hold of result ${decision.id}.`,
      );
    }
    if (
      reservation.outboundRequestLineId !== null &&
      !shipmentLineIds.has(reservation.outboundRequestLineId)
    ) {
      throw new AllocationRevocationIntegrityError(
        `Hold ${reservation.id} of a pending result rides another shipment.`,
      );
    }
  }
  const revoke = holds.reduce((total, hold) => total + hold.reservation.quantity, 0);
  let transition: { next: 'PENDING' | 'CANCELLED' | 'WAITLISTED'; revokedQuantity: number };
  try {
    const revoked = revokeFromPendingDecision({
      status: 'PENDING',
      grantedQuantity: decision.grantedQuantity,
      revokedQuantity: decision.revokedQuantity,
      revoke,
    });
    transition =
      input.kind === 'waitlisted'
        ? { next: 'WAITLISTED', revokedQuantity: revoked.revokedQuantity }
        : revoked;
  } catch (error: unknown) {
    throw new AllocationRevocationIntegrityError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (transition.next === 'WAITLISTED' && transition.revokedQuantity !== decision.grantedQuantity) {
    throw new AllocationRevocationIntegrityError(
      `Result ${decision.id} holds ${revoke} of its ${decision.grantedQuantity - decision.revokedQuantity} actionable bags.`,
    );
  }
  const terminal = transition.next !== 'PENDING';
  const releaseReason =
    input.kind === 'waitlisted'
      ? ALLOCATION_RESULT_WAITLISTED_RELEASE_REASON
      : WAIT_TICKET_CANCELLED_RELEASE_REASON;
  const occurredAt = input.occurredAt;

  // A partial revocation unlinks the released hold from the still-live shipment so the shipment
  // carries only what can be dispatched; a terminal one keeps the link as history of the
  // shipment that is cancelled below.
  const released = await tx
    .update(reservations)
    .set({
      status: 'released',
      releasedAt: occurredAt,
      releaseReason,
      updatedAt: occurredAt,
      ...(terminal ? {} : { outboundRequestLineId: null }),
    })
    .where(
      and(
        inArray(
          reservations.id,
          holds.map((hold) => hold.reservation.id),
        ),
        eq(reservations.status, 'active'),
      ),
    )
    .returning({ id: reservations.id });
  if (released.length !== holds.length) {
    throw new AllocationRevocationIntegrityError('Holds changed during the revocation.');
  }

  const dispositions: RevokedDisposition[] = holds.map((hold) => ({
    id: randomUUID(),
    allocationLineId: hold.line.id,
    reservationId: hold.reservation.id,
    productId: hold.reservation.productId,
    waitTicketId: hold.line.waitTicketId,
    orderRequestItemId: hold.line.orderRequestItemId,
    quantity: hold.reservation.quantity,
  }));
  await tx.insert(allocationLineDispositions).values(
    dispositions.map((row) => ({
      id: row.id,
      allocationDecisionId: decision.id,
      allocationLineId: row.allocationLineId,
      reservationId: row.reservationId,
      storeId: decision.storeId,
      productId: row.productId,
      waitTicketId: row.waitTicketId,
      kind: input.kind,
      quantity: row.quantity,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      requestId: input.requestId,
      createdAt: occurredAt,
    })),
  );
  // One standard release per disposition, in product order (warehouse-balance locks).
  for (const row of [...dispositions].sort(
    (a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id),
  )) {
    await applyWarehouseMovement(tx, {
      productId: row.productId,
      eventType: 'reservation_release',
      onHandDelta: 0,
      reservedDelta: -row.quantity,
      sourceType: DISPOSITION_LEDGER_SOURCE,
      sourceId: row.id,
      eventSequence: 1,
      reason:
        input.kind === 'waitlisted'
          ? 'Chuyển kết quả phân bổ về phiếu chờ'
          : 'Hủy phiếu chờ: thu hồi hàng phân bổ chưa xác nhận',
      metadata: {
        allocationDecisionId: decision.id,
        allocationLineId: row.allocationLineId,
        waitTicketId: row.waitTicketId,
        storeId: decision.storeId,
      },
      actorUserId: input.actor.id,
      occurredAt,
    });
  }

  const status =
    transition.next === 'WAITLISTED'
      ? 'waitlisted'
      : transition.next === 'CANCELLED'
        ? 'cancelled'
        : 'pending';
  const [updated] = await tx
    .update(allocationResultDecisions)
    .set({
      status,
      version: decision.version + 1,
      revokedQuantity: transition.revokedQuantity,
      updatedAt: occurredAt,
      ...(status === 'waitlisted'
        ? { respondedAt: occurredAt, respondedByUserId: input.actor.id }
        : {}),
    })
    .where(
      and(
        eq(allocationResultDecisions.id, decision.id),
        eq(allocationResultDecisions.status, 'pending'),
        eq(allocationResultDecisions.version, decision.version),
      ),
    )
    .returning();
  if (!updated) throw new AllocationRevocationIntegrityError('The result changed meanwhile.');

  let keptHeldQuantity = 0;
  let cancelledOutboundRequestId: string | null = null;
  const auditActor = {
    requestId: input.requestId,
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    actorStoreId: decision.storeId,
    createdAt: occurredAt,
  } as const;
  if (shipment && terminal) {
    const closed = await closeResultShipment(tx, {
      decision,
      shipment,
      shipmentLines,
      auditActor,
      trigger:
        input.kind === 'waitlisted' ? 'allocation-result-waitlisted' : 'allocation-result-cancelled',
    });
    keptHeldQuantity = closed.keptHeldQuantity;
    cancelledOutboundRequestId = shipment.id;
  } else if (shipment) {
    await shrinkResultShipment(tx, { shipment, shipmentLines, holds, auditActor, decision });
  }

  await tx.insert(auditLogs).values({
    ...auditActor,
    action:
      status === 'waitlisted'
        ? 'ALLOCATION_RESULT_WAITLISTED'
        : status === 'cancelled'
          ? 'ALLOCATION_RESULT_CANCELLED'
          : 'ALLOCATION_RESULT_GOODS_REVOKED',
    entityType: 'allocation_result_decision',
    entityId: decision.id,
    before: decisionSnapshot(decision),
    after: decisionSnapshot(updated),
    metadata: {
      kind: input.kind,
      allocationRunId: decision.allocationRunId,
      orderSessionId: decision.orderSessionId,
      grantedQuantity: decision.grantedQuantity,
      revokedNow: revoke,
      revokedQuantity: updated.revokedQuantity,
      actionableQuantity: updated.grantedQuantity - updated.revokedQuantity,
      dispositions: dispositions.map((row) => ({
        dispositionId: row.id,
        allocationLineId: row.allocationLineId,
        reservationId: row.reservationId,
        productId: row.productId,
        waitTicketId: row.waitTicketId,
        quantity: row.quantity,
      })),
      keptHeldQuantity,
      cancelledOutboundRequestId,
    },
  });
  return {
    decision: updated,
    dispositions,
    releasedQuantity: revoke,
    keptHeldQuantity,
    cancelledOutboundRequestId,
  };
}

type AuditActor = {
  readonly requestId: string | null;
  readonly actorUserId: string;
  readonly actorRole: RevocationActorRole;
  readonly actorStoreId: string;
  readonly createdAt: Date;
};

/**
 * The shipment of a pending result stays live after a partial revocation: each product line
 * loses exactly the revoked bags. A line left with nothing is removed (it never left the
 * warehouse and no receipt can reference it); its content stays in this audit.
 */
async function shrinkResultShipment(
  tx: Transaction,
  input: {
    readonly decision: DecisionRow;
    readonly shipment: ShipmentRow;
    readonly shipmentLines: readonly (typeof outboundRequestLines.$inferSelect)[];
    readonly holds: readonly ResultHold[];
    readonly auditActor: AuditActor;
  },
): Promise<void> {
  const revokedByLine = new Map<string, number>();
  for (const hold of input.holds) {
    const link = hold.reservation.outboundRequestLineId;
    if (link === null) continue;
    revokedByLine.set(link, (revokedByLine.get(link) ?? 0) + hold.reservation.quantity);
  }
  if (revokedByLine.size === 0) return;
  const changes: JsonObject[] = [];
  for (const line of input.shipmentLines) {
    const revoked = revokedByLine.get(line.id);
    if (revoked === undefined) continue;
    if (
      line.dispatchedQuantity !== 0 ||
      line.reservedQuantity < revoked ||
      line.approvedQuantity < revoked
    ) {
      throw new AllocationRevocationIntegrityError(
        `Shipment line ${line.id} cannot give back ${revoked} bags.`,
      );
    }
    const approved = line.approvedQuantity - revoked;
    if (approved === 0) {
      const [linked] = await tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(eq(reservations.outboundRequestLineId, line.id))
        .limit(1);
      if (linked) {
        throw new AllocationRevocationIntegrityError(
          `Shipment line ${line.id} still carries hold ${linked.id}.`,
        );
      }
      await tx.delete(outboundRequestLines).where(eq(outboundRequestLines.id, line.id));
    } else {
      await tx
        .update(outboundRequestLines)
        .set({
          approvedQuantity: approved,
          reservedQuantity: line.reservedQuantity - revoked,
          updatedAt: input.auditActor.createdAt,
        })
        .where(eq(outboundRequestLines.id, line.id));
    }
    changes.push({
      outboundRequestLineId: line.id,
      productId: line.productId,
      allocationLineId: line.allocationLineId,
      requestedQuantity: line.requestedQuantity,
      approvedBefore: line.approvedQuantity,
      approvedAfter: approved,
      removed: approved === 0,
    });
  }
  const [remaining] = await tx
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(outboundRequestLines)
    .where(eq(outboundRequestLines.outboundRequestId, input.shipment.id));
  if ((remaining?.value ?? 0) === 0) {
    // Only possible when the result is closed, which goes through closeResultShipment instead.
    throw new AllocationRevocationIntegrityError('A live shipment would be left without lines.');
  }
  const [bumped] = await tx
    .update(outboundRequests)
    .set({ version: input.shipment.version + 1, updatedAt: input.auditActor.createdAt })
    .where(
      and(
        eq(outboundRequests.id, input.shipment.id),
        eq(outboundRequests.status, 'reserved'),
        eq(outboundRequests.version, input.shipment.version),
      ),
    )
    .returning({ id: outboundRequests.id });
  if (!bumped) throw new AllocationRevocationIntegrityError('The shipment changed meanwhile.');
  await tx.insert(auditLogs).values({
    ...input.auditActor,
    action: 'OUTBOUND_REQUEST_LINES_REVOKED',
    entityType: 'outbound_request',
    entityId: input.shipment.id,
    before: { status: input.shipment.status, version: input.shipment.version },
    after: { status: input.shipment.status, version: input.shipment.version + 1 },
    metadata: { allocationDecisionId: input.decision.id, lines: changes },
  });
}

/**
 * A closed result (moved to waiting, or every source cancelled) never ships: its own holds were
 * released by the caller and its reserved shipment is cancelled. Goods of earlier results that
 * rode the shipment stay held for the store and ride the next ordinary shipment: an issued (RE)
 * hold keeps its row and only loses the link; an on-hand hold is replaced by a new active row with
 * the same source and quantity, so the total reserved does not change (no ledger movement).
 */
async function closeResultShipment(
  tx: Transaction,
  input: {
    readonly decision: DecisionRow;
    readonly shipment: ShipmentRow;
    readonly shipmentLines: readonly (typeof outboundRequestLines.$inferSelect)[];
    readonly auditActor: AuditActor;
    readonly trigger: string;
  },
): Promise<{ readonly keptHeldQuantity: number }> {
  const { decision, shipment, shipmentLines } = input;
  const occurredAt = input.auditActor.createdAt;
  const lineIds = shipmentLines.map((line) => line.id);
  const sources =
    lineIds.length === 0
      ? []
      : await tx
          .select({
            reservation: reservations,
            sourceAllocationRunId: allocationLines.allocationRunId,
          })
          .from(reservations)
          .innerJoin(allocationLines, eq(allocationLines.id, reservations.allocationLineId))
          .where(
            and(
              inArray(reservations.outboundRequestLineId, lineIds),
              inArray(reservations.status, ['active', 'issued']),
              isNull(reservations.deletedAt),
            ),
          )
          .orderBy(asc(reservations.id))
          .for('update', { of: reservations });
  const { release, keepHeld } = partitionRejectedShipmentSources(
    sources.map((row) => ({ ...row, storeId: row.reservation.storeId })),
    { allocationRunId: decision.allocationRunId, storeId: decision.storeId },
  );
  if (release.length > 0) {
    // The caller released every own hold first; one still active here was not revoked.
    throw new AllocationRevocationIntegrityError(
      `Result ${decision.id} still has goods on its shipment after closing.`,
    );
  }
  const detached: JsonObject[] = [];
  for (const row of keepHeld) {
    const old = row.reservation;
    if (old.status === 'issued') {
      const [unlinked] = await tx
        .update(reservations)
        .set({ outboundRequestLineId: null, updatedAt: occurredAt })
        .where(and(eq(reservations.id, old.id), eq(reservations.status, 'issued')))
        .returning({ id: reservations.id });
      if (!unlinked) throw new AllocationRevocationIntegrityError('A carried issued hold changed.');
      detached.push({
        previousReservationId: old.id,
        reservationId: old.id,
        allocationLineId: old.allocationLineId,
        allocationRunId: row.sourceAllocationRunId,
        productId: old.productId,
        quantity: old.quantity,
        fromOutboundRequestLineId: old.outboundRequestLineId,
        issued: true,
      });
      continue;
    }
    const [cancelled] = await tx
      .update(reservations)
      .set({
        status: 'cancelled',
        releasedAt: occurredAt,
        releaseReason: ALLOCATION_RESULT_DETACHED_REASON,
        updatedAt: occurredAt,
      })
      .where(and(eq(reservations.id, old.id), eq(reservations.status, 'active')))
      .returning({ id: reservations.id });
    if (!cancelled) throw new AllocationRevocationIntegrityError('A carried hold changed.');
    const [replacement] = await tx
      .insert(reservations)
      .values({
        productId: old.productId,
        storeId: old.storeId,
        allocationLineId: old.allocationLineId,
        outboundRequestLineId: null,
        quantity: old.quantity,
        status: 'active',
        createdByUserId: old.createdByUserId,
        createdAt: old.createdAt,
        updatedAt: occurredAt,
      })
      .returning({ id: reservations.id });
    detached.push({
      previousReservationId: old.id,
      reservationId: replacement!.id,
      allocationLineId: old.allocationLineId,
      allocationRunId: row.sourceAllocationRunId,
      productId: old.productId,
      quantity: old.quantity,
      fromOutboundRequestLineId: old.outboundRequestLineId,
    });
  }
  const keptHeldQuantity = keepHeld.reduce((total, row) => total + row.reservation.quantity, 0);
  // The representative pointer is cleared so a later shipment can name the carried source; the
  // full provenance stays on the reservation rows and in this audit.
  await tx
    .update(outboundRequestLines)
    .set({ allocationLineId: null, updatedAt: occurredAt })
    .where(eq(outboundRequestLines.outboundRequestId, shipment.id));
  const [cancelledShipment] = await tx
    .update(outboundRequests)
    .set({ status: 'cancelled', version: shipment.version + 1, updatedAt: occurredAt })
    .where(
      and(
        eq(outboundRequests.id, shipment.id),
        eq(outboundRequests.status, 'reserved'),
        eq(outboundRequests.version, shipment.version),
      ),
    )
    .returning({ id: outboundRequests.id });
  if (!cancelledShipment) {
    throw new AllocationRevocationIntegrityError('The shipment changed meanwhile.');
  }
  await tx.insert(auditLogs).values({
    ...input.auditActor,
    actorStoreId: shipment.storeId,
    action: 'OUTBOUND_REQUEST_CANCELLED',
    entityType: 'outbound_request',
    entityId: shipment.id,
    before: {
      requestNumber: shipment.requestNumber,
      status: shipment.status,
      version: shipment.version,
      lines: shipmentLines.map((line) => ({
        id: line.id,
        productId: line.productId,
        allocationLineId: line.allocationLineId,
        approvedQuantity: line.approvedQuantity,
        reservedQuantity: line.reservedQuantity,
      })),
    },
    after: { status: 'cancelled', version: shipment.version + 1 },
    metadata: {
      trigger: input.trigger,
      allocationDecisionId: decision.id,
      keptHeldQuantity,
      keptHeld: detached,
    },
  });
  return { keptHeldQuantity };
}

export interface RequeuedTicket {
  readonly waitTicketId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly mode: 'RESTORE_SOURCE' | 'ADD_DEMAND';
  readonly createdTicket: boolean;
}

/**
 * Moves the bags of a waitlisted result back to waiting, one store x product at a time under the
 * same 'store-product-wait' lock as cancellations and receipt shortages: merged into the active
 * ticket (a bag that came from that ticket is restored, never added twice) or into one new
 * ticket. Every contribution is recorded in wait_ticket_sources, unique per allocation line, so
 * neither a replay nor a second key can requeue the same line again.
 */
export async function requeueWaitlistedDispositionsInTransaction(
  tx: Transaction,
  input: {
    readonly decision: DecisionRow;
    readonly dispositions: readonly RevokedDisposition[];
    readonly actorUserId: string;
    readonly requestId: string | null;
    readonly occurredAt: Date;
  },
): Promise<readonly RequeuedTicket[]> {
  const { decision, occurredAt } = input;
  const sourceTicketIds = [
    ...new Set(input.dispositions.flatMap((row) => (row.waitTicketId ? [row.waitTicketId] : []))),
  ];
  const sourceTickets =
    sourceTicketIds.length === 0
      ? []
      : await tx
          .select({
            id: waitTickets.id,
            status: waitTickets.status,
            sourceOrderRequestItemId: waitTickets.sourceOrderRequestItemId,
          })
          .from(waitTickets)
          .where(inArray(waitTickets.id, sourceTicketIds));
  const sourceTicketById = new Map(sourceTickets.map((row) => [row.id, row]));
  const productIds = [...new Set(input.dispositions.map((row) => row.productId))].sort();
  const requeued: RequeuedTicket[] = [];
  for (const productId of productIds) {
    const group = input.dispositions.filter((row) => row.productId === productId);
    await withAdvisoryLock(tx, 'store-product-wait', `${decision.storeId}:${productId}`, async () => {
      const [active] = await tx
        .select()
        .from(waitTickets)
        .where(
          and(
            eq(waitTickets.storeId, decision.storeId),
            eq(waitTickets.productId, productId),
            eq(waitTickets.status, 'active'),
            isNull(waitTickets.deletedAt),
          ),
        )
        .for('update')
        .limit(1);
      const lines: WaitlistLine[] = group.map((row) => {
        const source = row.waitTicketId ? sourceTicketById.get(row.waitTicketId) : undefined;
        if (row.waitTicketId && !source) {
          throw new AllocationRevocationIntegrityError(`Wait ticket ${row.waitTicketId} is missing.`);
        }
        return {
          allocationLineId: row.allocationLineId,
          storeId: decision.storeId,
          productId,
          quantity: row.quantity,
          sourceWaitTicket: source ? { id: source.id, status: source.status } : null,
        };
      });
      const activeTicket = active ?? null;
      const [plan] = planWaitlistRequeue(
        lines,
        new Map(activeTicket ? [[waitTicketGroupKey(decision.storeId, productId), activeTicket.id]] : []),
      );
      if (!plan) return;
      let ticketId = activeTicket?.id ?? null;
      let createdTicket = false;
      const waitingQuantity = plan.restoreQuantity + plan.addQuantity;
      if (waitingQuantity === 0) {
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorStoreId: decision.storeId,
          action: 'WAIT_TICKET_REQUEUE_SKIPPED_CANCELLED_SOURCE',
          entityType: 'allocation_result_decision',
          entityId: decision.id,
          metadata: {
            productId,
            skippedQuantity: plan.skippedQuantity,
            allocationLineIds: plan.lines.map((line) => line.allocationLineId),
          },
          createdAt: occurredAt,
        });
        return;
      }
      if (activeTicket) {
        if (activeTicket.fulfilledQuantity < plan.restoreQuantity) {
          throw new AllocationRevocationIntegrityError(
            `Wait ticket ${activeTicket.id} cannot restore ${plan.restoreQuantity} granted bags.`,
          );
        }
        const [updated] = await tx
          .update(waitTickets)
          .set({
            originalQuantity: activeTicket.originalQuantity + plan.addQuantity,
            remainingQuantity: activeTicket.remainingQuantity + waitingQuantity,
            fulfilledQuantity: activeTicket.fulfilledQuantity - plan.restoreQuantity,
            updatedAt: occurredAt,
          })
          .where(and(eq(waitTickets.id, activeTicket.id), eq(waitTickets.status, 'active')))
          .returning();
        if (!updated) throw new AllocationRevocationIntegrityError('The wait ticket changed.');
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorStoreId: decision.storeId,
          action: 'WAIT_TICKET_REQUEUED_FROM_RESULT',
          entityType: 'wait_ticket',
          entityId: activeTicket.id,
          before: ticketSnapshot(activeTicket),
          after: ticketSnapshot(updated),
          metadata: {
            allocationDecisionId: decision.id,
            restoredQuantity: plan.restoreQuantity,
            addedQuantity: plan.addQuantity,
            skippedQuantity: plan.skippedQuantity,
          },
          createdAt: occurredAt,
        });
      } else {
        const first = plan.lines.find((line) => line.mode === 'ADD_DEMAND')!;
        const firstDisposition = group.find(
          (row) => row.allocationLineId === first.allocationLineId,
        )!;
        const sourceItemId =
          firstDisposition.orderRequestItemId ??
          (firstDisposition.waitTicketId
            ? sourceTicketById.get(firstDisposition.waitTicketId)?.sourceOrderRequestItemId
            : undefined);
        if (!sourceItemId) {
          throw new AllocationRevocationIntegrityError('A requeued line has no order provenance.');
        }
        ticketId = randomUUID();
        createdTicket = true;
        const [created] = await tx
          .insert(waitTickets)
          .values({
            id: ticketId,
            storeId: decision.storeId,
            productId,
            sourceOrderRequestItemId: sourceItemId,
            status: 'active',
            priorityLevel: 'P0B',
            originalQuantity: plan.addQuantity,
            remainingQuantity: plan.addQuantity,
            fulfilledQuantity: 0,
            queuedAt: occurredAt,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning();
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          actorStoreId: decision.storeId,
          action: 'WAIT_TICKET_CREATED_FROM_RESULT',
          entityType: 'wait_ticket',
          entityId: ticketId,
          after: created ? ticketSnapshot(created) : null,
          metadata: { allocationDecisionId: decision.id, addedQuantity: plan.addQuantity },
          createdAt: occurredAt,
        });
      }
      const targetId = ticketId!;
      const sourceRows = plan.lines
        .filter((line) => line.mode !== 'SKIP_CANCELLED_SOURCE')
        .map((line) => ({
          waitTicketId: targetId,
          kind: line.mode === 'RESTORE_SOURCE' ? ('result_restored' as const) : ('result_waitlisted' as const),
          quantity: line.quantity,
          orderSessionId: decision.orderSessionId,
          allocationRunId: decision.allocationRunId,
          allocationDecisionId: decision.id,
          allocationLineId: line.allocationLineId,
          sourceWaitTicketId: line.sourceWaitTicket?.id ?? null,
          orderRequestItemId:
            group.find((row) => row.allocationLineId === line.allocationLineId)
              ?.orderRequestItemId ?? null,
          actorUserId: input.actorUserId,
          createdAt: occurredAt,
        }));
      await tx.insert(waitTicketSources).values(sourceRows);
      if (plan.restoreQuantity > 0) {
        requeued.push({
          waitTicketId: targetId,
          productId,
          quantity: plan.restoreQuantity,
          mode: 'RESTORE_SOURCE',
          createdTicket: false,
        });
      }
      if (plan.addQuantity > 0) {
        requeued.push({
          waitTicketId: targetId,
          productId,
          quantity: plan.addQuantity,
          mode: 'ADD_DEMAND',
          createdTicket,
        });
      }
    });
  }
  return requeued;
}

function decisionSnapshot(row: DecisionRow): JsonObject {
  return {
    status: row.status,
    version: row.version,
    grantedQuantity: row.grantedQuantity,
    revokedQuantity: row.revokedQuantity,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    respondedByUserId: row.respondedByUserId,
  };
}

function ticketSnapshot(row: typeof waitTickets.$inferSelect): JsonObject {
  return {
    status: row.status,
    originalQuantity: row.originalQuantity,
    remainingQuantity: row.remainingQuantity,
    fulfilledQuantity: row.fulfilledQuantity,
    queuedAt: row.queuedAt.toISOString(),
  };
}

/** SQL: the wait ticket column has granted bags in a result still waiting for an answer. */
export function pendingDecisionHoldsCondition(waitTicketColumn: SQL | unknown): SQL {
  return sql`exists (select 1 from ${allocationLines}
    join ${reservations} on ${reservations.allocationLineId} = ${allocationLines.id}
      and ${reservations.status} = 'active' and ${reservations.deletedAt} is null
    join ${allocationResultDecisions} on ${allocationResultDecisions.allocationRunId} = ${allocationLines.allocationRunId}
      and ${allocationResultDecisions.storeId} = ${allocationLines.storeId}
      and ${allocationResultDecisions.status} = 'pending'
    where ${allocationLines.waitTicketId} = ${waitTicketColumn})`;
}

/** Holds of a ticket in pending results, grouped by result (ids sorted), for a cancellation. */
export async function findRevocableTicketHolds(
  reader: Pick<Transaction, 'select'>,
  waitTicketId: string,
): Promise<readonly { readonly decisionId: string; readonly quantity: number }[]> {
  const rows = await reader
    .select({
      decisionId: allocationResultDecisions.id,
      quantity: sql<number>`sum(${reservations.quantity})`.mapWith(Number),
    })
    .from(allocationLines)
    .innerJoin(reservations, eq(reservations.allocationLineId, allocationLines.id))
    .innerJoin(
      allocationResultDecisions,
      and(
        eq(allocationResultDecisions.allocationRunId, allocationLines.allocationRunId),
        eq(allocationResultDecisions.storeId, allocationLines.storeId),
      ),
    )
    .where(
      and(
        eq(allocationLines.waitTicketId, waitTicketId),
        eq(reservations.status, 'active'),
        isNull(reservations.deletedAt),
        eq(allocationResultDecisions.status, 'pending'),
      ),
    )
    .groupBy(allocationResultDecisions.id)
    .orderBy(asc(allocationResultDecisions.id));
  return rows;
}


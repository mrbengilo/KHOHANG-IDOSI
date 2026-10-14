import { randomUUID } from 'node:crypto';

import {
  planStoreWaitReconciliation,
  type StoreWaitDeclaredReduction,
  type StoreWaitReconciliationPlan,
  type StoreWaitReductionCategory,
} from '@idosi/domain';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  storeReceipts,
  stores,
  storeWaitDocumentEvents,
  storeWaitDocumentLines,
  storeWaitDocumentMembers,
  storeWaitDocuments,
  users,
  type JsonObject,
  type StoreWaitDocumentEventKind,
} from './schema.js';
import { withTransaction, type Transaction } from './transaction.js';

/**
 * Keeps the store-level wait document ("phiếu chờ", docs/store-active-wait-document.md) in step
 * with the per-product wait tickets, in the transaction of the command that changed them.
 *
 * Every command that changes a store's waiting demand calls reconcileStoreWaitDocumentsInTransaction
 * as its LAST step, once, with every store it touched. Lock order: the command's own locks
 * (stock jobs, wait ticket, store-product-wait, shipment, decision and balance rows) come first;
 * then the 'store-wait-document' advisory locks of all its stores, in store id order, before any
 * document row is written; and only then the PCT code counter (taken by the insert trigger). No
 * transaction holding a document lock ever waits for anything but another document lock or that
 * counter, so the extra locks cannot close a cycle with the existing ones.
 */
export const STORE_WAIT_DOCUMENT_LOCK = 'store-wait-document';

export interface StoreWaitDocumentEventInput {
  readonly kind: StoreWaitDocumentEventKind;
  /** The command that caused the change; unique per store. Null for catch-up synchronisation. */
  readonly sourceKey: string | null;
  readonly actorUserId: string | null;
  readonly requestId?: string | null;
  readonly occurredAt: Date;
  readonly orderSessionId?: string | null;
  readonly allocationRunId?: string | null;
  readonly allocationDecisionId?: string | null;
  readonly waitTicketId?: string | null;
  readonly priorityOfferId?: string | null;
  readonly storeReceiptId?: string | null;
  readonly reason?: string | null;
  readonly metadata?: JsonObject;
}

export interface StoreWaitReconcileRequest {
  readonly storeId: string;
  /** What the command resolved (confirmed, cancelled, adjusted), per product. */
  readonly declared?: readonly StoreWaitDeclaredReduction[];
  readonly event: StoreWaitDocumentEventInput;
}

export interface StoreWaitReconcileResult {
  readonly storeId: string;
  readonly plan: StoreWaitReconciliationPlan['kind'];
  readonly closedDocumentId: string | null;
  readonly currentDocumentId: string | null;
  readonly eventId: string | null;
}

/** An undeclared drop of open demand is attributed by the kind of event that caused it. */
const UNDECLARED_CATEGORY: Record<StoreWaitDocumentEventKind, StoreWaitReductionCategory> = {
  allocation_run: 'adjusted',
  result_accepted: 'confirmed',
  // Bags of a cancelled source ticket are only returned to stock when a result moves back.
  result_waitlisted: 'cancelled',
  wait_ticket_cancelled: 'cancelled',
  wait_document_cancelled: 'cancelled',
  priority_offer_response: 'cancelled',
  receipt_shortage: 'adjusted',
  receipt_adjustment: 'adjusted',
  system_sync: 'adjusted',
  migration_backfill: 'adjusted',
};

export interface StoreWaitLiveTicket {
  readonly storeId: string;
  readonly productId: string;
  readonly waitTicketId: string;
  readonly remainingQuantity: number;
  readonly pendingQuantity: number;
  readonly queuedAt: Date;
}

/**
 * The open demand of stores, per ticket, in ONE statement (one snapshot even in read committed):
 * the remaining quantity of active tickets, plus bags granted from the store's tickets that are
 * still held for a PENDING result. Holds of accepted (issued), moved or revoked results, and goods
 * of legacy results, are not open demand.
 */
export async function loadStoreWaitLiveTickets(
  reader: Pick<Transaction, 'execute'>,
  storeIds: string | readonly string[],
): Promise<StoreWaitLiveTicket[]> {
  const ids = typeof storeIds === 'string' ? [storeIds] : [...storeIds];
  if (ids.length === 0) return [];
  const scope = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const result = await reader.execute<{
    store_id: string;
    product_id: string;
    wait_ticket_id: string;
    remaining: number | string;
    pending: number | string;
    queued_at: Date | string;
  }>(sql`
    SELECT store_id, product_id, wait_ticket_id, sum(remaining) AS remaining,
      sum(pending) AS pending, min(queued_at) AS queued_at
    FROM (
      SELECT w.store_id, w.product_id, w.id AS wait_ticket_id, w.remaining_quantity AS remaining,
        0 AS pending, w.queued_at
      FROM wait_tickets w
      WHERE w.store_id = ANY(${scope}) AND w.status = 'active' AND w.deleted_at IS NULL
        AND w.remaining_quantity > 0
      UNION ALL
      SELECT al.store_id, al.product_id, al.wait_ticket_id, 0, r.quantity, w.queued_at
      FROM allocation_result_decisions d
      JOIN allocation_lines al ON al.allocation_run_id = d.allocation_run_id
        AND al.store_id = d.store_id AND al.wait_ticket_id IS NOT NULL
      JOIN reservations r ON r.allocation_line_id = al.id AND r.status = 'active'
        AND r.deleted_at IS NULL
      JOIN wait_tickets w ON w.id = al.wait_ticket_id
      WHERE d.store_id = ANY(${scope}) AND d.status = 'pending'
    ) live
    GROUP BY store_id, product_id, wait_ticket_id
    ORDER BY store_id, product_id, wait_ticket_id
  `);
  return result.rows.map((row) => ({
    storeId: row.store_id,
    productId: row.product_id,
    waitTicketId: row.wait_ticket_id,
    remainingQuantity: Number(row.remaining),
    pendingQuantity: Number(row.pending),
    queuedAt: row.queued_at instanceof Date ? row.queued_at : new Date(row.queued_at),
  }));
}

/** Per-product totals of the live tickets. */
export function summarizeStoreWaitLive(tickets: readonly StoreWaitLiveTicket[]) {
  const byProduct = new Map<
    string,
    { productId: string; remainingQuantity: number; pendingQuantity: number }
  >();
  for (const ticket of tickets) {
    const line = byProduct.get(ticket.productId) ?? {
      productId: ticket.productId,
      remainingQuantity: 0,
      pendingQuantity: 0,
    };
    line.remainingQuantity += ticket.remainingQuantity;
    line.pendingQuantity += ticket.pendingQuantity;
    byProduct.set(ticket.productId, line);
  }
  return [...byProduct.values()];
}

/**
 * Brings the documents of the given stores in line with their live demand. A store whose open
 * demand did not change (and whose event resolved nothing) is left as it is, so replays, retries
 * and catch-up runs never create a document. Must be the caller's last write (see the lock order
 * above) and called once per transaction with every touched store.
 */
export async function reconcileStoreWaitDocumentsInTransaction(
  tx: Transaction,
  requests: readonly StoreWaitReconcileRequest[],
): Promise<readonly StoreWaitReconcileResult[]> {
  const byStore = new Map<string, StoreWaitReconcileRequest>();
  for (const request of requests) {
    if (byStore.has(request.storeId)) {
      throw new Error(`Store ${request.storeId} is reconciled twice in one command.`);
    }
    byStore.set(request.storeId, request);
  }
  const storeIds = [...byStore.keys()].sort();
  for (const storeId of storeIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${STORE_WAIT_DOCUMENT_LOCK}:${storeId}`}, 0))`,
    );
  }
  const results: StoreWaitReconcileResult[] = [];
  for (const storeId of storeIds) {
    results.push(await reconcileLockedStore(tx, byStore.get(storeId)!));
  }
  return results;
}

async function reconcileLockedStore(
  tx: Transaction,
  request: StoreWaitReconcileRequest,
): Promise<StoreWaitReconcileResult> {
  const { storeId, event } = request;
  const [current] = await tx
    .select()
    .from(storeWaitDocuments)
    .where(and(eq(storeWaitDocuments.storeId, storeId), eq(storeWaitDocuments.status, 'current')))
    .for('update')
    .limit(1);
  const currentLines = current
    ? await tx
        .select()
        .from(storeWaitDocumentLines)
        .where(eq(storeWaitDocumentLines.documentId, current.id))
        .orderBy(asc(storeWaitDocumentLines.productId))
    : [];
  const liveTickets = await loadStoreWaitLiveTickets(tx, storeId);
  const plan = planStoreWaitReconciliation({
    current: current
      ? currentLines.map((line) => ({
          productId: line.productId,
          openQuantity: line.carriedInQuantity + line.addedQuantity,
        }))
      : null,
    live: summarizeStoreWaitLive(liveTickets),
    declared: request.declared ?? [],
    undeclaredCategory: UNDECLARED_CATEGORY[event.kind],
  });

  if (plan.kind === 'NOOP') {
    // The same open demand can move to another ticket of the same product (a result moved back
    // to waiting onto a new ticket); the document keeps every ticket it ever covered.
    if (current) await addMembers(tx, current.id, storeId, liveTickets);
    return {
      storeId,
      plan: plan.kind,
      closedDocumentId: null,
      currentDocumentId: current?.id ?? null,
      eventId: null,
    };
  }

  const eventId = await insertEvent(tx, storeId, event, plan);
  let closedDocumentId: string | null = null;
  if ((plan.kind === 'CLOSE' || plan.kind === 'ROLLOVER') && current) {
    const [closed] = await tx
      .update(storeWaitDocuments)
      .set({
        status: plan.closure,
        version: current.version + 1,
        closedAt: event.occurredAt,
        closedEventId: eventId,
      })
      .where(
        and(
          eq(storeWaitDocuments.id, current.id),
          eq(storeWaitDocuments.status, 'current'),
          eq(storeWaitDocuments.version, current.version),
        ),
      )
      .returning({ id: storeWaitDocuments.id });
    if (!closed) throw new Error(`Store wait document ${current.id} changed while closing.`);
    for (const line of plan.closing) {
      await tx
        .update(storeWaitDocumentLines)
        .set({
          confirmedQuantity: line.confirmedQuantity,
          cancelledQuantity: line.cancelledQuantity,
          adjustedQuantity: line.adjustedQuantity,
          carriedOutQuantity: line.carriedOutQuantity,
        })
        .where(
          and(
            eq(storeWaitDocumentLines.documentId, current.id),
            eq(storeWaitDocumentLines.productId, line.productId),
          ),
        );
    }
    closedDocumentId = current.id;
  }

  let currentDocumentId: string | null = null;
  if (plan.kind === 'OPEN' || plan.kind === 'ROLLOVER') {
    const id = randomUUID();
    const continues = plan.kind === 'ROLLOVER' && current ? current : null;
    const waitingSince = liveTickets.reduce<Date>(
      (earliest, ticket) => (ticket.queuedAt < earliest ? ticket.queuedAt : earliest),
      event.occurredAt,
    );
    await tx.insert(storeWaitDocuments).values({
      id,
      storeId,
      status: 'current',
      version: 1,
      chainId: continues ? continues.chainId : id,
      chainSequence: continues ? continues.chainSequence + 1 : 1,
      predecessorId: continues ? continues.id : null,
      openedEventId: eventId,
      openedAt: event.occurredAt,
      waitingSince,
    });
    await tx.insert(storeWaitDocumentLines).values(
      plan.opening.map((line) => ({
        documentId: id,
        storeId,
        productId: line.productId,
        carriedInQuantity: line.carriedInQuantity,
        addedQuantity: line.addedQuantity,
        openingRemainingQuantity: line.remainingQuantity,
        openingPendingQuantity: line.pendingQuantity,
      })),
    );
    await addMembers(tx, id, storeId, liveTickets);
    currentDocumentId = id;
  }
  return { storeId, plan: plan.kind, closedDocumentId, currentDocumentId, eventId };
}

async function addMembers(
  tx: Transaction,
  documentId: string,
  storeId: string,
  tickets: readonly StoreWaitLiveTicket[],
): Promise<void> {
  if (tickets.length === 0) return;
  await tx
    .insert(storeWaitDocumentMembers)
    .values(
      tickets.map((ticket) => ({
        documentId,
        waitTicketId: ticket.waitTicketId,
        storeId,
        productId: ticket.productId,
      })),
    )
    .onConflictDoNothing();
}

async function insertEvent(
  tx: Transaction,
  storeId: string,
  event: StoreWaitDocumentEventInput,
  plan: Exclude<StoreWaitReconciliationPlan, { kind: 'NOOP' }>,
): Promise<string> {
  const [actor] = event.actorUserId
    ? await tx
        .select({ role: users.role, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, event.actorUserId))
        .limit(1)
    : [];
  const metadata: JsonObject = {
    ...(event.metadata ?? {}),
    ...(plan.kind !== 'OPEN' && plan.overDeclared.length > 0
      ? { overDeclared: plan.overDeclared.map((row) => ({ ...row })) }
      : {}),
    ...(plan.kind !== 'OPEN' && plan.undeclared.length > 0
      ? { undeclared: plan.undeclared.map((row) => ({ ...row })) }
      : {}),
  };
  const id = randomUUID();
  await tx.insert(storeWaitDocumentEvents).values({
    id,
    storeId,
    kind: event.kind,
    sourceKey: event.sourceKey,
    actorUserId: event.actorUserId,
    actorRole: actor?.role ?? null,
    actorDisplayName: actor?.displayName ?? null,
    requestId: event.requestId ?? null,
    orderSessionId: event.orderSessionId ?? null,
    allocationRunId: event.allocationRunId ?? null,
    allocationDecisionId: event.allocationDecisionId ?? null,
    waitTicketId: event.waitTicketId ?? null,
    priorityOfferId: event.priorityOfferId ?? null,
    storeReceiptId: event.storeReceiptId ?? null,
    reason: event.reason ?? null,
    metadata,
    occurredAt: event.occurredAt,
  });
  return id;
}

/**
 * Catch-up for every store (worker start-up, after a deployment during which the previous
 * release could still change wait tickets without documents). Each store is reconciled in its
 * own short transaction as a system event; an in-step store is left unchanged.
 */
export async function syncAllStoreWaitDocuments(
  database: Database,
  occurredAt: Date = new Date(),
): Promise<readonly StoreWaitReconcileResult[]> {
  const storeRows = await database.select({ id: stores.id }).from(stores).orderBy(asc(stores.id));
  const results: StoreWaitReconcileResult[] = [];
  for (const store of storeRows) {
    const [result] = await withTransaction(database, (tx) =>
      reconcileStoreWaitDocumentsInTransaction(tx, [
        {
          storeId: store.id,
          event: { kind: 'system_sync', sourceKey: null, actorUserId: null, occurredAt },
        },
      ]),
    );
    if (result) results.push(result);
  }
  return results;
}

/** The current document of a store, if any. */
export async function findCurrentStoreWaitDocumentId(
  reader: Pick<Transaction, 'select'>,
  storeId: string,
): Promise<string | null> {
  const [row] = await reader
    .select({ id: storeWaitDocuments.id })
    .from(storeWaitDocuments)
    .where(and(eq(storeWaitDocuments.storeId, storeId), eq(storeWaitDocuments.status, 'current')))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A receipt shortage queues (or a corrected receipt un-queues) waiting demand of the receipt's
 * store; its wait document follows as the command's last write. Receipts change several times,
 * so the event has no source key; a receipt that changed nothing leaves the document as it is.
 */
export async function reconcileReceiptStoreWaitDocument(
  tx: Transaction,
  receiptId: string,
  actorUserId: string | null,
  requestId: string | null,
): Promise<void> {
  const [receipt] = await tx
    .select({ storeId: storeReceipts.storeId })
    .from(storeReceipts)
    .where(eq(storeReceipts.id, receiptId))
    .limit(1);
  if (!receipt) return;
  await reconcileStoreWaitDocumentsInTransaction(tx, [
    {
      storeId: receipt.storeId,
      event: {
        kind: 'receipt_shortage',
        sourceKey: null,
        actorUserId,
        requestId,
        occurredAt: new Date(),
        storeReceiptId: receiptId,
      },
    },
  ]);
}

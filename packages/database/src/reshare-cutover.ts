import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { STOCK_JOBS_LOCK } from './allocation-decisions.js';
import { issueReshareOrderInTransaction } from './reshare-orders.js';
import {
  allocationLines,
  allocationResultDecisions,
  auditLogs,
  reservations,
  reshareOrders,
  supplierOrderSourceLinks,
  users,
} from './schema.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';

/**
 * Cutover of results answered before RE orders existed (docs/reshare-auto-orders.md §Cutover).
 * The plan is read-only. Applying it only touches decisions an operator listed from a reviewed
 * plan, re-checks every one inside the transaction and is idempotent: a decision that already
 * has its RE order is skipped, goods already received are never issued again.
 */

export const RESHARE_CUTOVER_CATEGORIES = [
  /** Pending: the new flow handles it when someone accepts. */
  'PENDING_NEW_FLOW',
  /** Accepted before RE orders; every own hold still on-hand: may be backfilled once. */
  'ACCEPTED_ELIGIBLE',
  /** Accepted before RE orders; goods already received/settled: history only, never issued. */
  'ACCEPTED_SETTLED',
  /** Accepted with a manual Reshare order record: keep the manual data, do not convert. */
  'ACCEPTED_MANUAL_ORDER',
  /** Accepted, holds partly settled or not conserving the grant: needs a person's decision. */
  'ACCEPTED_EXCEPTION',
  /** Already has its RE order. */
  'HAS_RESHARE_ORDER',
] as const;
export type ReshareCutoverCategory = (typeof RESHARE_CUTOVER_CATEGORIES)[number];

export interface ReshareCutoverItem {
  readonly decisionId: string;
  readonly storeId: string;
  readonly orderSessionId: string;
  readonly status: (typeof allocationResultDecisions.$inferSelect)['status'];
  readonly grantedQuantity: number;
  readonly activeQuantity: number;
  readonly settledQuantity: number;
  readonly manualOrderLinks: number;
  readonly category: ReshareCutoverCategory;
}

export interface ReshareCutoverPlan {
  readonly generatedAt: string;
  readonly counts: Record<ReshareCutoverCategory, number>;
  /** Legacy results are never treated as accepted by a person; listed for information. */
  readonly legacyResultCount: number;
  readonly items: readonly ReshareCutoverItem[];
  /** Hash of the eligible set; apply refuses a manifest built from a different state. */
  readonly eligibleHash: string;
}

type Reader = Database | Transaction;

async function classify(reader: Reader, decisionIds?: readonly string[]) {
  const decisions = await reader
    .select({
      id: allocationResultDecisions.id,
      allocationRunId: allocationResultDecisions.allocationRunId,
      storeId: allocationResultDecisions.storeId,
      orderSessionId: allocationResultDecisions.orderSessionId,
      status: allocationResultDecisions.status,
      grantedQuantity: allocationResultDecisions.grantedQuantity,
      orderId: reshareOrders.id,
    })
    .from(allocationResultDecisions)
    .leftJoin(reshareOrders, eq(reshareOrders.allocationDecisionId, allocationResultDecisions.id))
    .where(
      and(
        inArray(allocationResultDecisions.status, ['pending', 'accepted']),
        decisionIds ? inArray(allocationResultDecisions.id, [...decisionIds]) : undefined,
      ),
    )
    .orderBy(asc(allocationResultDecisions.createdAt), asc(allocationResultDecisions.id));
  const accepted = decisions.filter((row) => row.status === 'accepted' && !row.orderId);
  const holdRows =
    accepted.length === 0
      ? []
      : await reader
          .select({
            allocationRunId: allocationLines.allocationRunId,
            storeId: allocationLines.storeId,
            allocationLineId: allocationLines.id,
            status: reservations.status,
            quantity: reservations.quantity,
            consumed: reservations.consumedQuantity,
          })
          .from(allocationLines)
          .leftJoin(
            reservations,
            and(
              eq(reservations.allocationLineId, allocationLines.id),
              isNull(reservations.deletedAt),
            ),
          )
          .where(
            and(
              inArray(allocationLines.allocationRunId, [
                ...new Set(accepted.map((row) => row.allocationRunId)),
              ]),
              sql`${allocationLines.allocatedQuantity} > 0`,
            ),
          );
  const lineIds = [...new Set(holdRows.map((row) => row.allocationLineId))];
  const links =
    lineIds.length === 0
      ? []
      : await reader
          .select({
            allocationLineId: supplierOrderSourceLinks.allocationLineId,
            count: sql<number>`count(*)`.mapWith(Number),
          })
          .from(supplierOrderSourceLinks)
          .where(inArray(supplierOrderSourceLinks.allocationLineId, lineIds))
          .groupBy(supplierOrderSourceLinks.allocationLineId);
  const linkCount = new Map(links.map((row) => [row.allocationLineId, row.count]));
  return decisions.map((decision): ReshareCutoverItem => {
    const own = holdRows.filter(
      (row) => row.allocationRunId === decision.allocationRunId && row.storeId === decision.storeId,
    );
    const activeQuantity = own
      .filter((row) => row.status === 'active')
      .reduce((total, row) => total + (row.quantity ?? 0), 0);
    const settledQuantity = own
      .filter((row) => row.status === 'consumed' || row.status === 'released')
      .reduce((total, row) => total + (row.quantity ?? 0), 0);
    const manualOrderLinks = [...new Set(own.map((row) => row.allocationLineId))].reduce(
      (total, id) => total + (linkCount.get(id) ?? 0),
      0,
    );
    let category: ReshareCutoverCategory;
    if (decision.orderId) category = 'HAS_RESHARE_ORDER';
    else if (decision.status === 'pending') category = 'PENDING_NEW_FLOW';
    else if (manualOrderLinks > 0) category = 'ACCEPTED_MANUAL_ORDER';
    else if (activeQuantity === decision.grantedQuantity && settledQuantity === 0) {
      category = 'ACCEPTED_ELIGIBLE';
    } else if (activeQuantity === 0 && settledQuantity > 0) category = 'ACCEPTED_SETTLED';
    else category = 'ACCEPTED_EXCEPTION';
    return {
      decisionId: decision.id,
      storeId: decision.storeId,
      orderSessionId: decision.orderSessionId,
      status: decision.status,
      grantedQuantity: decision.grantedQuantity,
      activeQuantity,
      settledQuantity,
      manualOrderLinks,
      category,
    };
  });
}

function eligibleHash(items: readonly ReshareCutoverItem[]): string {
  const eligible = items
    .filter((item) => item.category === 'ACCEPTED_ELIGIBLE')
    .map((item) => `${item.decisionId}:${item.grantedQuantity}:${item.activeQuantity}`)
    .sort();
  return createHash('sha256').update(JSON.stringify(eligible)).digest('hex');
}

/** Read-only dry-run report. */
export async function planReshareCutover(database: Database): Promise<ReshareCutoverPlan> {
  return withSerializableTransaction(
    database,
    async (tx) => {
      const items = await classify(tx);
      const counts = Object.fromEntries(
        RESHARE_CUTOVER_CATEGORIES.map((category) => [
          category,
          items.filter((item) => item.category === category).length,
        ]),
      ) as Record<ReshareCutoverCategory, number>;
      const [legacy] = await tx
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(allocationResultDecisions)
        .where(eq(allocationResultDecisions.status, 'legacy'));
      return {
        generatedAt: new Date().toISOString(),
        counts,
        legacyResultCount: legacy?.value ?? 0,
        items,
        eligibleHash: eligibleHash(items),
      };
    },
    { accessMode: 'read only' },
  );
}

export class ReshareCutoverError extends Error {
  public readonly code = 'RESHARE_CUTOVER_REFUSED';

  public constructor(message: string) {
    super(message);
    this.name = 'ReshareCutoverError';
  }
}

export interface ApplyReshareCutoverInput {
  /** Decisions picked from a reviewed plan; every one must still be eligible. */
  readonly decisionIds: readonly string[];
  /** The plan's eligibleHash the operator reviewed. */
  readonly expectedEligibleHash: string;
  readonly actorUserId: string;
  readonly occurredAt?: Date;
}

export interface ApplyReshareCutoverResult {
  readonly created: readonly { readonly decisionId: string; readonly code: string }[];
  readonly skipped: readonly { readonly decisionId: string; readonly category: string }[];
}

/**
 * Backfills RE orders (and their issue) for explicitly listed eligible results, one atomic
 * transaction. Rerunning skips decisions that already have their order.
 */
export async function applyReshareCutover(
  database: Database,
  input: ApplyReshareCutoverInput,
): Promise<ApplyReshareCutoverResult> {
  if (input.decisionIds.length === 0 || input.decisionIds.length > 200) {
    throw new ReshareCutoverError('List between 1 and 200 decisions from the reviewed plan.');
  }
  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(tx, STOCK_JOBS_LOCK.namespace, STOCK_JOBS_LOCK.key, async () => {
      const [actor] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.actorUserId),
            eq(users.role, 'admin'),
            eq(users.status, 'active'),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (!actor)
        throw new ReshareCutoverError('Only an active administrator may apply a cutover.');
      const all = await classify(tx);
      if (eligibleHash(all) !== input.expectedEligibleHash) {
        throw new ReshareCutoverError(
          'The eligible set changed since the reviewed plan; build and review a new plan.',
        );
      }
      const wanted = new Set(input.decisionIds);
      const items = all.filter((item) => wanted.has(item.decisionId));
      const unknown = [...wanted].filter((id) => !items.some((item) => item.decisionId === id));
      if (unknown.length > 0) {
        throw new ReshareCutoverError(`Unknown or not answerable decisions: ${unknown.join(', ')}`);
      }
      const created: { decisionId: string; code: string }[] = [];
      const skipped: { decisionId: string; category: string }[] = [];
      const occurredAt = input.occurredAt ?? new Date();
      for (const item of items) {
        if (item.category !== 'ACCEPTED_ELIGIBLE') {
          skipped.push({ decisionId: item.decisionId, category: item.category });
          continue;
        }
        const [decision] = await tx
          .select()
          .from(allocationResultDecisions)
          .where(eq(allocationResultDecisions.id, item.decisionId))
          .for('update')
          .limit(1);
        if (!decision) throw new ReshareCutoverError(`Decision ${item.decisionId} vanished.`);
        const order = await issueReshareOrderInTransaction(tx, {
          decision,
          actorUserId: actor.id,
          actorRole: 'admin',
          requestId: null,
          occurredAt,
          origin: 'backfill',
        });
        created.push({ decisionId: item.decisionId, code: order.code });
      }
      await tx.insert(auditLogs).values({
        actorUserId: actor.id,
        actorRole: 'admin',
        action: 'RESHARE_ORDER_CUTOVER_APPLIED',
        entityType: 'reshare_order_cutover',
        entityId: randomUUID(),
        after: { created, skipped, eligibleHash: input.expectedEligibleHash },
        createdAt: occurredAt,
      });
      return { created, skipped };
    }),
  );
}

import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  withIdempotency,
  type IdempotencyResult,
  type IdempotentOperationResult,
} from './idempotency.js';
import {
  auditLogs,
  outboundRequestLines,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  storeTransfers,
  storePartnerInboundBags,
  storePartnerInboundLines,
  storePartnerInbounds,
  storeOutbounds,
  stores,
  users,
  type JsonObject,
} from './schema.js';
import { settleStoreNormalSaleProgress } from './store-normal-sale-sync.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationConflictError,
  StoreOperationValidationError,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type InventoryBagRow = typeof storeInventoryBags.$inferSelect;
type InventoryBagStatus = InventoryBagRow['status'];
type StoreOutboundRow = typeof storeOutbounds.$inferSelect;
type StoreOutboundReason = StoreOutboundRow['reason'];
type StoreOutboundStatus = StoreOutboundRow['status'];

export interface StoreInventoryPageInput {
  readonly page?: number;
  readonly pageSize?: number;
  /** Authorization must already have reduced this to a server-approved store scope. */
  readonly storeId?: string;
  readonly productId?: string;
  readonly status?: InventoryBagStatus;
  readonly bagCode?: string;
  readonly storeIds?: readonly string[];
  readonly unopenedOnly?: boolean;
}

export interface StoreInventoryBagRecord {
  readonly id: string;
  readonly bagCode: string;
  readonly displayCode: string;
  readonly storeId: string;
  readonly productId: string;
  readonly sourceStoreReceiptBagId: string | null;
  readonly sourceDocumentCode?: string | null;
  readonly sourceTransferId: string | null;
  readonly sourceInventoryBagId: string | null;
  readonly sourcePartnerInboundBagId: string | null;
  readonly outboundRequestId: string | null;
  readonly status: InventoryBagStatus;
  readonly initialWeightKg: string;
  readonly currentWeightKg: string;
  readonly costVnd: bigint;
  readonly version: number;
  readonly receivedAt: Date;
  readonly openedAt: Date | null;
  readonly depletedAt: Date | null;
  readonly updatedAt: Date;
}

export interface StoreInventoryLedgerPageInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly bagId?: string;
  readonly storeId?: string;
  readonly productId?: string;
}

export interface StoreInventoryLedgerRecord {
  readonly id: string;
  readonly bagId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly eventType: typeof storeInventoryLedgerEntries.$inferSelect.eventType;
  readonly weightBeforeKg: string;
  readonly weightAfterKg: string;
  readonly reason: string;
  /** Null for regular-sale movements recorded by the IDOSI sync. */
  readonly actorUserId: string | null;
  readonly occurredAt: Date;
}

export interface StoreOutboundPageInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly storeId?: string;
  readonly inventoryBagId?: string;
  readonly status?: StoreOutboundStatus;
  readonly reason?: StoreOutboundReason;
}

export interface PageResult<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

export interface OpenStoreInventoryBagInput {
  readonly bagId: string;
  readonly storeId: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface OpenedStoreInventoryBag {
  readonly bagId: string;
  /** Depleted when regular-price sales already waiting in IDOSI use up the whole bag. */
  readonly status: 'opened' | 'depleted';
  readonly version: number;
  /** Weight of outstanding IDOSI regular-price sales taken out of this bag on opening. */
  readonly normalSaleAppliedKg: string;
}

export interface CreateStoreOutboundInput {
  readonly storeId: string;
  readonly inventoryBagId: string;
  readonly expectedInventoryVersion: number;
  readonly weightKg: string;
  readonly reason: StoreOutboundReason;
  readonly revenueVnd: bigint | null;
  readonly pieceCount?: number | null;
  readonly createdByUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export interface CreatedStoreOutbound {
  readonly outboundId: string;
  readonly status: 'pending';
  readonly version: number;
}

export class StoreInventoryAuthorizationError extends Error {
  public readonly code = 'STORE_INVENTORY_FORBIDDEN';

  public constructor(message = 'The account cannot mutate inventory for this store.') {
    super(message);
    this.name = 'StoreInventoryAuthorizationError';
  }
}

export async function listStoreInventoryBags(
  database: Database,
  input: StoreInventoryPageInput,
): Promise<PageResult<StoreInventoryBagRecord>> {
  const { pagination, total, rows: rowQuery } = buildStoreInventoryBagPageQueries(database, input);
  const [totals, rows] = await Promise.all([total, rowQuery]);
  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows.map(({ bag, outboundRequestId, sourceDocumentCode }) => ({
      id: bag.id,
      bagCode: bag.bagCode,
      displayCode: bag.displayCode,
      storeId: bag.storeId,
      productId: bag.productId,
      sourceStoreReceiptBagId: bag.sourceStoreReceiptBagId,
      sourceDocumentCode,
      sourceTransferId: bag.sourceTransferId,
      sourceInventoryBagId: bag.sourceInventoryBagId,
      sourcePartnerInboundBagId: bag.sourcePartnerInboundBagId,
      outboundRequestId,
      status: bag.status,
      initialWeightKg: bag.initialWeightKg,
      currentWeightKg: bag.currentWeightKg,
      costVnd: bag.costVnd,
      version: bag.version,
      receivedAt: bag.receivedAt,
      openedAt: bag.openedAt,
      depletedAt: bag.depletedAt,
      updatedAt: bag.updatedAt,
    })),
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

/** Exposed for SQL-level verification without requiring a live PostgreSQL instance. */
export function buildStoreInventoryBagPageQueries(
  database: Database,
  input: StoreInventoryPageInput,
) {
  const pagination = normalizePagination(input);
  const predicates: SQL[] = [];
  if (input.storeId !== undefined) predicates.push(eq(storeInventoryBags.storeId, input.storeId));
  if (input.productId !== undefined) {
    predicates.push(eq(storeInventoryBags.productId, input.productId));
  }
  if (input.status !== undefined) predicates.push(eq(storeInventoryBags.status, input.status));
  if (input.bagCode !== undefined) {
    const search = `%${escapeLike(input.bagCode)}%`;
    predicates.push(
      or(ilike(storeInventoryBags.displayCode, search), ilike(storeInventoryBags.bagCode, search))!,
    );
  }
  if (input.storeIds !== undefined)
    predicates.push(
      input.storeIds.length ? inArray(storeInventoryBags.storeId, [...input.storeIds]) : sql`false`,
    );
  if (input.unopenedOnly)
    predicates.push(
      eq(storeInventoryBags.status, 'available'),
      isNull(storeInventoryBags.openedAt),
      sql`not exists (select 1 from audit_logs a where a.entity_type = 'store_inventory_bag' and a.entity_id = ${storeInventoryBags.id} and a.action = 'STORE_INVENTORY_BAG_OPENED')`,
      sql`not exists (select 1 from store_sorting_events s where s.store_inventory_bag_id = ${storeInventoryBags.id})`,
      sql`not exists (select 1 from store_inventory_ledger_entries l where l.store_inventory_bag_id = ${storeInventoryBags.id} and l.source_type in ('store_transfer_dispatch', 'store_outbound', 'idosi_normal_sale'))`,
    );
  const where = predicates.length > 0 ? and(...predicates) : undefined;
  return {
    pagination,
    total: database
      .select({ value: count() })
      .from(storeInventoryBags)
      .leftJoin(
        outboundRequestLines,
        eq(outboundRequestLines.id, storeInventoryBags.outboundRequestLineId),
      )
      .where(where),
    rows: database
      .select({
        bag: storeInventoryBags,
        outboundRequestId: outboundRequestLines.outboundRequestId,
        sourceDocumentCode: sql<
          string | null
        >`coalesce(${storeReceipts.receiptNumber}, ${storeTransfers.transferNumber}, ${storePartnerInbounds.referenceCode})`,
      })
      .from(storeInventoryBags)
      .leftJoin(
        storeReceiptBags,
        eq(storeReceiptBags.id, storeInventoryBags.sourceStoreReceiptBagId),
      )
      .leftJoin(storeReceiptLines, eq(storeReceiptLines.id, storeReceiptBags.storeReceiptLineId))
      .leftJoin(storeReceipts, eq(storeReceipts.id, storeReceiptLines.storeReceiptId))
      .leftJoin(storeTransfers, eq(storeTransfers.id, storeInventoryBags.sourceTransferId))
      .leftJoin(
        storePartnerInboundBags,
        eq(storePartnerInboundBags.id, storeInventoryBags.sourcePartnerInboundBagId),
      )
      .leftJoin(
        storePartnerInboundLines,
        eq(storePartnerInboundLines.id, storePartnerInboundBags.storePartnerInboundLineId),
      )
      .leftJoin(
        storePartnerInbounds,
        eq(storePartnerInbounds.id, storePartnerInboundLines.storePartnerInboundId),
      )
      .leftJoin(
        outboundRequestLines,
        eq(outboundRequestLines.id, storeInventoryBags.outboundRequestLineId),
      )
      .where(where)
      .orderBy(desc(storeInventoryBags.receivedAt), asc(storeInventoryBags.bagCode))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  };
}

export async function listStoreInventoryLedger(
  database: Database,
  input: StoreInventoryLedgerPageInput,
): Promise<PageResult<StoreInventoryLedgerRecord>> {
  const pagination = normalizePagination(input);
  const predicates: SQL[] = [];
  if (input.bagId !== undefined) {
    predicates.push(eq(storeInventoryLedgerEntries.storeInventoryBagId, input.bagId));
  }
  if (input.storeId !== undefined) {
    predicates.push(eq(storeInventoryLedgerEntries.storeId, input.storeId));
  }
  if (input.productId !== undefined) {
    predicates.push(eq(storeInventoryLedgerEntries.productId, input.productId));
  }
  const where = predicates.length > 0 ? and(...predicates) : undefined;
  const [totals, rows] = await Promise.all([
    database.select({ value: count() }).from(storeInventoryLedgerEntries).where(where),
    database
      .select()
      .from(storeInventoryLedgerEntries)
      .where(where)
      .orderBy(desc(storeInventoryLedgerEntries.occurredAt), desc(storeInventoryLedgerEntries.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);
  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows.map((row) => ({
      id: row.id,
      bagId: row.storeInventoryBagId,
      storeId: row.storeId,
      productId: row.productId,
      eventType: row.eventType,
      weightBeforeKg: row.weightBeforeKg,
      weightAfterKg: row.weightAfterKg,
      reason: row.reason,
      actorUserId: row.actorUserId,
      occurredAt: row.occurredAt,
    })),
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

export async function listStoreOutbounds(
  database: Database,
  input: StoreOutboundPageInput,
): Promise<PageResult<StoreOutboundRow>> {
  const pagination = normalizePagination(input);
  const predicates: SQL[] = [isNull(storeOutbounds.deletedAt)];
  if (input.storeId !== undefined) predicates.push(eq(storeOutbounds.storeId, input.storeId));
  if (input.inventoryBagId !== undefined) {
    predicates.push(eq(storeOutbounds.storeInventoryBagId, input.inventoryBagId));
  }
  if (input.status !== undefined) predicates.push(eq(storeOutbounds.status, input.status));
  if (input.reason !== undefined) predicates.push(eq(storeOutbounds.reason, input.reason));
  const where = and(...predicates);
  const [totals, rows] = await Promise.all([
    database.select({ value: count() }).from(storeOutbounds).where(where),
    database
      .select()
      .from(storeOutbounds)
      .where(where)
      .orderBy(desc(storeOutbounds.createdAt), desc(storeOutbounds.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize),
  ]);
  const totalItems = totals[0]?.value ?? 0;
  return {
    data: rows,
    pagination: pageMetadata(pagination.page, pagination.pageSize, totalItems),
  };
}

export async function openStoreInventoryBag(
  database: Database,
  input: OpenStoreInventoryBagInput,
): Promise<IdempotencyResult<OpenedStoreInventoryBag>> {
  validateMutationIdentity(input.storeId, input.actorUserId, input.expectedVersion);
  return withIdempotency(
    database,
    {
      scope: `store-inventory.open:${input.bagId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      // The store-sorting lock comes first, as in the IDOSI sync and sorting, because opening
      // settles the regular-price sales that were waiting for an opened bag of this product.
      withAdvisoryLock(tx, 'store-sorting', input.storeId, () =>
        withAdvisoryLock(tx, 'store-inventory-bag', input.bagId, async () => {
          await assertActiveStoreActor(tx, input.actorUserId, input.storeId);
          const [bag] = await tx
            .select()
            .from(storeInventoryBags)
            .where(eq(storeInventoryBags.id, input.bagId))
            .for('update')
            .limit(1);
          if (!bag || bag.storeId !== input.storeId) {
            throw new StoreInventoryAuthorizationError();
          }
          if (
            bag.version !== input.expectedVersion ||
            bag.status !== 'available' ||
            bag.openedAt !== null
          ) {
            throw new StoreOperationConflictError('Inventory bag is stale or cannot be opened.');
          }
          const priorOpening = await tx
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.entityType, 'store_inventory_bag'),
                eq(auditLogs.entityId, bag.id),
                eq(auditLogs.action, 'STORE_INVENTORY_BAG_OPENED'),
              ),
            )
            .limit(1);
          if (priorOpening.length) throw new StoreOperationConflictError('Bao đã khui kiện bán.');
          const history = await tx
            .select({ id: storeInventoryLedgerEntries.id })
            .from(storeInventoryLedgerEntries)
            .where(
              and(
                eq(storeInventoryLedgerEntries.storeInventoryBagId, bag.id),
                inArray(storeInventoryLedgerEntries.sourceType, [
                  'store_sorting_event',
                  'store_transfer_dispatch',
                  'store_outbound',
                  'idosi_normal_sale',
                ]),
              ),
            )
            .limit(1);
          if (history.length)
            throw new StoreOperationConflictError('Bao đã có lịch sử khui hoặc xuất hàng.');
          const now = new Date();
          const [updated] = await tx
            .update(storeInventoryBags)
            .set({ status: 'opened', openedAt: now, version: bag.version + 1, updatedAt: now })
            .where(
              and(
                eq(storeInventoryBags.id, bag.id),
                eq(storeInventoryBags.version, input.expectedVersion),
                eq(storeInventoryBags.status, 'available'),
              ),
            )
            .returning({ version: storeInventoryBags.version });
          if (!updated)
            throw new StoreOperationConflictError('Inventory bag changed while opening.');
          await settleStoreNormalSaleProgress(tx, bag.storeId, bag.productId, now);
          const [settled] = await tx
            .select()
            .from(storeInventoryBags)
            .where(eq(storeInventoryBags.id, bag.id))
            .limit(1);
          if (!settled) throw new Error('Opened inventory bag disappeared.');
          const result: OpenedStoreInventoryBag = {
            bagId: bag.id,
            status: settled.status === 'depleted' ? 'depleted' : 'opened',
            version: settled.version,
            normalSaleAppliedKg: gramsToKilogramsExact(
              kilogramsToGramsExact(bag.currentWeightKg) -
                kilogramsToGramsExact(settled.currentWeightKg),
            ),
          };
          await tx.insert(auditLogs).values({
            requestId: input.requestId,
            actorUserId: input.actorUserId,
            actorRole: 'store',
            actorStoreId: input.storeId,
            action: 'STORE_INVENTORY_BAG_OPENED',
            entityType: 'store_inventory_bag',
            entityId: bag.id,
            before: inventoryBagSnapshot(bag),
            after: {
              ...inventoryBagSnapshot(settled),
              normalSaleAppliedKg: result.normalSaleAppliedKg,
            },
          });
          return idempotentMutationResult(
            result,
            {
              bagId: result.bagId,
              status: result.status,
              version: result.version,
              normalSaleAppliedKg: result.normalSaleAppliedKg,
            },
            'store_inventory_bag',
            bag.id,
          );
        }),
      ),
  );
}

export async function createStoreOutbound(
  database: Database,
  input: CreateStoreOutboundInput,
): Promise<IdempotencyResult<CreatedStoreOutbound>> {
  validateMutationIdentity(input.storeId, input.createdByUserId, input.expectedInventoryVersion);
  const weightGrams = kilogramsToGramsExact(input.weightKg);
  if (weightGrams <= 0n)
    throw new StoreOperationValidationError('Outbound weight must be positive.');
  if (!['charity', 'sale_kg', 'sale_piece', 'cancel'].includes(input.reason)) {
    throw new StoreOperationValidationError('Outbound reason is no longer available.');
  }
  if (input.revenueVnd !== null && input.revenueVnd < 0n) {
    throw new StoreOperationValidationError('Outbound revenue cannot be negative.');
  }
  if (
    ((input.reason === 'sale_kg' || input.reason === 'sale_piece') && input.revenueVnd === null) ||
    ((input.reason === 'charity' || input.reason === 'cancel') && input.revenueVnd !== null)
  ) {
    throw new StoreOperationValidationError('Outbound revenue must match the reason.');
  }
  if ((input.reason === 'sale_piece') !== (input.pieceCount != null)) {
    throw new StoreOperationValidationError('Piece count must match the outbound reason.');
  }
  if (
    input.pieceCount != null &&
    (!Number.isSafeInteger(input.pieceCount) ||
      input.pieceCount <= 0 ||
      input.pieceCount > 2_147_483_647)
  ) {
    throw new StoreOperationValidationError('Piece count must be a positive integer.');
  }
  return withIdempotency(
    database,
    {
      scope: `store-outbound.create:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'store-inventory-bag', input.inventoryBagId, async () => {
        await assertActiveStoreActor(tx, input.createdByUserId, input.storeId);
        const [bag] = await tx
          .select()
          .from(storeInventoryBags)
          .where(eq(storeInventoryBags.id, input.inventoryBagId))
          .for('update')
          .limit(1);
        if (!bag || bag.storeId !== input.storeId) throw new StoreInventoryAuthorizationError();
        if (
          bag.version !== input.expectedInventoryVersion ||
          (bag.status !== 'available' && bag.status !== 'opened')
        ) {
          throw new StoreOperationConflictError('Inventory bag is stale or unavailable.');
        }
        if (weightGrams > kilogramsToGramsExact(bag.currentWeightKg)) {
          throw new StoreOperationValidationError(
            'Outbound weight exceeds the remaining bag weight.',
          );
        }
        const now = new Date();
        const [created] = await tx
          .insert(storeOutbounds)
          .values({
            outboundNumber: '',
            storeId: input.storeId,
            storeInventoryBagId: input.inventoryBagId,
            weightKg: input.weightKg,
            reason: input.reason,
            revenueVnd: input.revenueVnd,
            pieceCount: input.pieceCount ?? null,
            createdByUserId: input.createdByUserId,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storeOutbounds.id, version: storeOutbounds.version });
        if (!created) throw new Error('Store outbound insert did not return a row.');
        const result: CreatedStoreOutbound = {
          outboundId: created.id,
          status: 'pending',
          version: created.version,
        };
        await tx.insert(auditLogs).values({
          requestId: input.requestId,
          actorUserId: input.createdByUserId,
          actorRole: 'store',
          actorStoreId: input.storeId,
          action: 'STORE_OUTBOUND_CREATED',
          entityType: 'store_outbound',
          entityId: created.id,
          after: {
            status: 'pending',
            version: created.version,
            inventoryBagId: input.inventoryBagId,
            expectedInventoryVersion: input.expectedInventoryVersion,
            weightKg: input.weightKg,
            reason: input.reason,
            revenueVnd: input.revenueVnd?.toString() ?? null,
            pieceCount: input.pieceCount ?? null,
          },
        });
        return idempotentMutationResult(
          result,
          { outboundId: result.outboundId, status: result.status, version: result.version },
          'store_outbound',
          created.id,
          201,
        );
      }),
  );
}

async function assertActiveStoreActor(
  tx: Transaction,
  actorUserId: string,
  storeId: string,
): Promise<void> {
  const [[store], [user]] = await Promise.all([
    tx
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1),
    tx
      .select({ role: users.role, status: users.status, storeId: users.storeId })
      .from(users)
      .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
      .limit(1),
  ]);
  if (
    !store ||
    !user ||
    user.role !== 'store' ||
    user.status !== 'active' ||
    user.storeId !== storeId
  ) {
    throw new StoreInventoryAuthorizationError();
  }
}

function validateMutationIdentity(storeId: string, actorUserId: string, version: number): void {
  if (storeId.trim().length === 0 || actorUserId.trim().length === 0) {
    throw new StoreOperationValidationError('Store and actor identifiers are required.');
  }
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new StoreOperationValidationError('Expected inventory version must be non-negative.');
  }
}

function normalizePagination(input: { readonly page?: number; readonly pageSize?: number }): {
  readonly page: number;
  readonly pageSize: number;
} {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('page must be positive.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return { page, pageSize };
}

function pageMetadata(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function inventoryBagSnapshot(bag: InventoryBagRow): JsonObject {
  return {
    id: bag.id,
    bagCode: bag.bagCode,
    displayCode: bag.displayCode,
    openedAt: bag.openedAt?.toISOString() ?? null,
    storeId: bag.storeId,
    productId: bag.productId,
    status: bag.status,
    currentWeightKg: bag.currentWeightKg,
    version: bag.version,
  };
}

function idempotentMutationResult<T>(
  value: T,
  responseBody: JsonObject,
  resourceType: string,
  resourceId: string,
  responseStatus = 200,
): IdempotentOperationResult<T> {
  return { value, responseStatus, responseBody, resourceType, resourceId };
}

import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, gte, isNull, lt, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  auditLogs,
  products,
  users,
  warehouseBalances,
  warehouseStockAdjustments,
} from './schema.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

export type WarehouseAdjustmentDirection = typeof warehouseStockAdjustments.$inferSelect.direction;
export type WarehouseAdjustmentReasonCode =
  typeof warehouseStockAdjustments.$inferSelect.reasonCode;

/** Ledger source type of an Admin stock adjustment; the source id is the adjustment id. */
export const WAREHOUSE_ADJUSTMENT_SOURCE_TYPE = 'warehouse_stock_adjustment';
export const MAX_WAREHOUSE_ADJUSTMENT_QUANTITY = 100_000;

export interface CreateWarehouseStockAdjustmentInput {
  readonly productId: string;
  readonly direction: WarehouseAdjustmentDirection;
  readonly quantity: number;
  readonly reasonCode: WarehouseAdjustmentReasonCode;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly compensatesAdjustmentId?: string | null;
  readonly actorUserId: string;
  /** Kept on the document itself, so a replay is recognised for as long as it exists. */
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly now?: Date;
}

export interface WarehouseStockAdjustmentRecord {
  readonly id: string;
  readonly code: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly direction: WarehouseAdjustmentDirection;
  readonly quantity: number;
  readonly reasonCode: WarehouseAdjustmentReasonCode;
  readonly reason: string;
  readonly onHandBefore: number;
  readonly reservedBefore: number;
  readonly onHandAfter: number;
  readonly reservedAfter: number;
  readonly balanceVersionBefore: number;
  readonly balanceVersionAfter: number;
  readonly ledgerEntryId: string;
  readonly compensatesAdjustmentId: string | null;
  readonly createdByUserId: string;
  readonly createdByDisplayName: string;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

export interface CreatedWarehouseStockAdjustment {
  readonly adjustment: WarehouseStockAdjustmentRecord;
  readonly replayed: boolean;
}

export class WarehouseAdjustmentAuthorizationError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_FORBIDDEN';

  public constructor() {
    super('Only an active administrator can adjust central-warehouse stock.');
    this.name = 'WarehouseAdjustmentAuthorizationError';
  }
}

export class WarehouseAdjustmentValidationError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'WarehouseAdjustmentValidationError';
  }
}

export class WarehouseAdjustmentNotFoundError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_NOT_FOUND';

  public constructor(message: string) {
    super(message);
    this.name = 'WarehouseAdjustmentNotFoundError';
  }
}

/** The balance changed after the Admin looked at it; the current position is attached. */
export class WarehouseAdjustmentVersionConflictError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_STALE';

  public constructor(
    public readonly current: {
      readonly onHand: number;
      readonly reserved: number;
      readonly version: number;
    },
  ) {
    super('Warehouse balance changed since it was read.');
    this.name = 'WarehouseAdjustmentVersionConflictError';
  }
}

/** A decrease may only remove bags that are not held for offers, allocations or dispatch. */
export class WarehouseAdjustmentInsufficientStockError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_INSUFFICIENT_STOCK';

  public constructor(public readonly available: number) {
    super('Decrease exceeds the available (unreserved) warehouse stock.');
    this.name = 'WarehouseAdjustmentInsufficientStockError';
  }
}

export class WarehouseAdjustmentIdempotencyConflictError extends Error {
  public readonly code = 'WAREHOUSE_ADJUSTMENT_KEY_REUSED';

  public constructor() {
    super('Idempotency key was already used for a different adjustment.');
    this.name = 'WarehouseAdjustmentIdempotencyConflictError';
  }
}

/**
 * One atomic command: authorize → validate product → lock the balance with the same advisory
 * lock and row lock every warehouse movement uses → check version and reserved stock → ledger
 * entry → immutable document → audit. Any failure rolls back all of it.
 */
export async function createWarehouseStockAdjustment(
  database: Database,
  input: CreateWarehouseStockAdjustmentInput,
): Promise<CreatedWarehouseStockAdjustment> {
  validateInput(input);
  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(
      tx,
      'warehouse-adjustment-key',
      `${input.actorUserId}:${input.idempotencyKey}`,
      async () => {
        const [previous] = await tx
          .select({
            id: warehouseStockAdjustments.id,
            requestHash: warehouseStockAdjustments.requestHash,
          })
          .from(warehouseStockAdjustments)
          .where(
            and(
              eq(warehouseStockAdjustments.createdByUserId, input.actorUserId),
              eq(warehouseStockAdjustments.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (previous) {
          if (previous.requestHash !== input.requestHash) {
            throw new WarehouseAdjustmentIdempotencyConflictError();
          }
          return { adjustment: await loadAdjustment(tx, previous.id), replayed: true };
        }

        await assertActiveAdministrator(tx, input.actorUserId);
        const [product] = await tx
          .select({ id: products.id, isActive: products.isActive })
          .from(products)
          .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
          .limit(1);
        if (!product) throw new WarehouseAdjustmentNotFoundError('Product does not exist.');
        if (input.direction === 'increase' && !product.isActive) {
          // An inactive SKU can no longer be ordered or allocated; only write-offs remain.
          throw new WarehouseAdjustmentValidationError(
            'Mặt hàng đã ngừng kinh doanh; chỉ được giảm tồn, không được tăng tồn.',
          );
        }
        if (input.compensatesAdjustmentId) {
          const [target] = await tx
            .select({
              productId: warehouseStockAdjustments.productId,
              direction: warehouseStockAdjustments.direction,
            })
            .from(warehouseStockAdjustments)
            .where(eq(warehouseStockAdjustments.id, input.compensatesAdjustmentId))
            .limit(1);
          if (!target) {
            throw new WarehouseAdjustmentNotFoundError('Compensated adjustment does not exist.');
          }
          if (target.productId !== input.productId || target.direction === input.direction) {
            throw new WarehouseAdjustmentValidationError(
              'Phiếu bù phải cùng mặt hàng và ngược chiều với phiếu điều chỉnh được sửa.',
            );
          }
        }

        return withAdvisoryLock(tx, 'warehouse-balance', input.productId, async () => {
          const now = input.now ?? new Date();
          const [balance] = await tx
            .select()
            .from(warehouseBalances)
            .where(eq(warehouseBalances.productId, input.productId))
            .for('update')
            .limit(1);
          const before = {
            onHand: balance?.onHandQuantity ?? 0,
            reserved: balance?.reservedQuantity ?? 0,
            version: balance?.version ?? 0,
          };
          if (before.version !== input.expectedVersion) {
            throw new WarehouseAdjustmentVersionConflictError(before);
          }
          const delta = input.direction === 'increase' ? input.quantity : -input.quantity;
          const onHandAfter = before.onHand + delta;
          if (onHandAfter < before.reserved || onHandAfter < 0) {
            throw new WarehouseAdjustmentInsufficientStockError(before.onHand - before.reserved);
          }
          if (onHandAfter > 2_147_483_647) {
            throw new WarehouseAdjustmentValidationError(
              'Tồn sau điều chỉnh vượt giới hạn lưu trữ.',
            );
          }

          const id = randomUUID();
          const reason = input.reason.trim();
          const movement = await applyWarehouseMovement(tx, {
            productId: input.productId,
            eventType: 'adjustment',
            onHandDelta: delta,
            reservedDelta: 0,
            sourceType: WAREHOUSE_ADJUSTMENT_SOURCE_TYPE,
            sourceId: id,
            reason,
            metadata: {
              direction: input.direction,
              quantity: input.quantity,
              reasonCode: input.reasonCode,
              compensatesAdjustmentId: input.compensatesAdjustmentId ?? null,
              requestId: input.requestId ?? null,
            },
            actorUserId: input.actorUserId,
            occurredAt: now,
          });
          if (
            movement.replayed ||
            movement.onHandQuantity !== onHandAfter ||
            movement.reservedQuantity !== before.reserved
          ) {
            throw new Error('Warehouse adjustment ledger entry does not match its plan.');
          }
          const [created] = await tx
            .insert(warehouseStockAdjustments)
            .values({
              id,
              productId: input.productId,
              direction: input.direction,
              quantity: input.quantity,
              reasonCode: input.reasonCode,
              reason,
              onHandBefore: before.onHand,
              reservedBefore: before.reserved,
              onHandAfter,
              reservedAfter: before.reserved,
              balanceVersionBefore: before.version,
              balanceVersionAfter: before.version + 1,
              ledgerEntryId: movement.ledgerEntryId,
              compensatesAdjustmentId: input.compensatesAdjustmentId ?? null,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              requestId: input.requestId ?? null,
              createdByUserId: input.actorUserId,
              createdAt: now,
            })
            .returning({ id: warehouseStockAdjustments.id, code: warehouseStockAdjustments.code });
          if (!created) throw new Error('Warehouse adjustment insert returned no row.');

          await tx.insert(auditLogs).values({
            requestId: input.requestId ?? null,
            actorUserId: input.actorUserId,
            actorRole: 'admin',
            action: 'WAREHOUSE_STOCK_ADJUSTED',
            entityType: 'warehouse_stock_adjustment',
            entityId: created.id,
            before: {
              productId: input.productId,
              onHand: before.onHand,
              reserved: before.reserved,
              available: before.onHand - before.reserved,
              version: before.version,
            },
            after: {
              productId: input.productId,
              onHand: onHandAfter,
              reserved: before.reserved,
              available: onHandAfter - before.reserved,
              version: before.version + 1,
            },
            metadata: {
              code: created.code,
              direction: input.direction,
              quantity: input.quantity,
              delta,
              reasonCode: input.reasonCode,
              reason,
              ledgerEntryId: movement.ledgerEntryId,
              compensatesAdjustmentId: input.compensatesAdjustmentId ?? null,
            },
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
            createdAt: now,
          });
          return { adjustment: await loadAdjustment(tx, created.id), replayed: false };
        });
      },
    ),
  );
}

export interface ListWarehouseStockAdjustmentsInput {
  readonly page: number;
  readonly pageSize: number;
  readonly productId?: string;
  readonly createdByUserId?: string;
  readonly direction?: WarehouseAdjustmentDirection;
  /** Inclusive lower and exclusive upper instant. */
  readonly createdFrom?: Date;
  readonly createdBefore?: Date;
}

/** Newest first with a stable id tie-break; counted and paged in the same snapshot. */
export async function listWarehouseStockAdjustments(
  database: Database,
  input: ListWarehouseStockAdjustmentsInput,
) {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100
  ) {
    throw new RangeError('Invalid adjustment pagination');
  }
  return database.transaction(
    async (tx) => {
      const predicates: SQL[] = [];
      if (input.productId)
        predicates.push(eq(warehouseStockAdjustments.productId, input.productId));
      if (input.createdByUserId) {
        predicates.push(eq(warehouseStockAdjustments.createdByUserId, input.createdByUserId));
      }
      if (input.direction)
        predicates.push(eq(warehouseStockAdjustments.direction, input.direction));
      if (input.createdFrom) {
        predicates.push(gte(warehouseStockAdjustments.createdAt, input.createdFrom));
      }
      if (input.createdBefore) {
        predicates.push(lt(warehouseStockAdjustments.createdAt, input.createdBefore));
      }
      const where = predicates.length > 0 ? and(...predicates) : undefined;
      const [total] = await tx
        .select({ value: count() })
        .from(warehouseStockAdjustments)
        .where(where);
      const rows = await adjustmentProjection(tx)
        .where(where)
        .orderBy(desc(warehouseStockAdjustments.createdAt), desc(warehouseStockAdjustments.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const totalItems = total?.value ?? 0;
      return {
        data: rows as WarehouseStockAdjustmentRecord[],
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / input.pageSize),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function getWarehouseStockAdjustment(
  database: Database,
  adjustmentId: string,
): Promise<WarehouseStockAdjustmentRecord | null> {
  const [row] = await adjustmentProjection(database)
    .where(eq(warehouseStockAdjustments.id, adjustmentId))
    .limit(1);
  return (row as WarehouseStockAdjustmentRecord | undefined) ?? null;
}

function adjustmentProjection(executor: Database | Transaction) {
  return executor
    .select({
      id: warehouseStockAdjustments.id,
      code: warehouseStockAdjustments.code,
      productId: warehouseStockAdjustments.productId,
      sku: products.sku,
      productName: products.name,
      direction: warehouseStockAdjustments.direction,
      quantity: warehouseStockAdjustments.quantity,
      reasonCode: warehouseStockAdjustments.reasonCode,
      reason: warehouseStockAdjustments.reason,
      onHandBefore: warehouseStockAdjustments.onHandBefore,
      reservedBefore: warehouseStockAdjustments.reservedBefore,
      onHandAfter: warehouseStockAdjustments.onHandAfter,
      reservedAfter: warehouseStockAdjustments.reservedAfter,
      balanceVersionBefore: warehouseStockAdjustments.balanceVersionBefore,
      balanceVersionAfter: warehouseStockAdjustments.balanceVersionAfter,
      ledgerEntryId: warehouseStockAdjustments.ledgerEntryId,
      compensatesAdjustmentId: warehouseStockAdjustments.compensatesAdjustmentId,
      createdByUserId: warehouseStockAdjustments.createdByUserId,
      createdByDisplayName: users.displayName,
      requestId: warehouseStockAdjustments.requestId,
      createdAt: warehouseStockAdjustments.createdAt,
    })
    .from(warehouseStockAdjustments)
    .innerJoin(products, eq(products.id, warehouseStockAdjustments.productId))
    .innerJoin(users, eq(users.id, warehouseStockAdjustments.createdByUserId))
    .$dynamic();
}

async function loadAdjustment(
  tx: Transaction,
  adjustmentId: string,
): Promise<WarehouseStockAdjustmentRecord> {
  const [row] = await adjustmentProjection(tx)
    .where(eq(warehouseStockAdjustments.id, adjustmentId))
    .limit(1);
  if (!row) throw new Error('Warehouse adjustment disappeared inside its transaction.');
  return row as WarehouseStockAdjustmentRecord;
}

async function assertActiveAdministrator(tx: Transaction, userId: string): Promise<void> {
  const [administrator] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.role, 'admin'),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!administrator) throw new WarehouseAdjustmentAuthorizationError();
}

function validateInput(input: CreateWarehouseStockAdjustmentInput): void {
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_WAREHOUSE_ADJUSTMENT_QUANTITY
  ) {
    throw new WarehouseAdjustmentValidationError(
      `Số bao điều chỉnh phải là số nguyên từ 1 đến ${MAX_WAREHOUSE_ADJUSTMENT_QUANTITY}.`,
    );
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new WarehouseAdjustmentValidationError('expectedVersion phải là số nguyên không âm.');
  }
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new WarehouseAdjustmentValidationError('Lý do điều chỉnh phải có từ 3 đến 500 ký tự.');
  }
  if (input.idempotencyKey.trim().length === 0 || input.requestHash.trim().length === 0) {
    throw new WarehouseAdjustmentValidationError('Thiếu khóa idempotency của thao tác.');
  }
}

import { and, count, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  storeReceipts,
  users,
  warehouseShortageChecks,
  type JsonObject,
} from './schema.js';
import { StoreOperationConflictError, StoreOperationValidationError } from './store-operations.js';
import { withAdvisoryLock } from './transaction.js';
import { applyWarehouseMovement } from './warehouse.js';

export type WarehouseShortageCheckStatus = typeof warehouseShortageChecks.$inferSelect.status;
export type WarehouseShortageCheckDecision = Exclude<WarehouseShortageCheckStatus, 'pending'>;

export interface WarehouseShortageCheckRecord {
  readonly id: string;
  readonly storeReceiptId: string;
  readonly receiptNumber: string;
  readonly storeId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly status: WarehouseShortageCheckStatus;
  readonly shortageReason: string | null;
  readonly resolutionReason: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

export interface ListWarehouseShortageChecksInput {
  readonly status?: WarehouseShortageCheckStatus;
  readonly page: number;
  readonly pageSize: number;
}

export interface ResolveWarehouseShortageCheckInput {
  readonly checkId: string;
  readonly decision: WarehouseShortageCheckDecision;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string;
}

export class WarehouseShortageCheckAuthorizationError extends Error {
  public readonly code = 'WAREHOUSE_SHORTAGE_CHECK_FORBIDDEN';

  public constructor() {
    super('Only an active administrator may resolve a warehouse shortage check.');
    this.name = 'WarehouseShortageCheckAuthorizationError';
  }
}

export async function listWarehouseShortageChecks(
  database: Database,
  input: ListWarehouseShortageChecksInput,
): Promise<{ readonly data: WarehouseShortageCheckRecord[]; readonly totalItems: number }> {
  const where =
    input.status === undefined ? undefined : eq(warehouseShortageChecks.status, input.status);
  const [rows, totals] = await Promise.all([
    database
      .select({ check: warehouseShortageChecks, receiptNumber: storeReceipts.receiptNumber })
      .from(warehouseShortageChecks)
      .innerJoin(storeReceipts, eq(storeReceipts.id, warehouseShortageChecks.storeReceiptId))
      .where(where)
      .orderBy(desc(warehouseShortageChecks.createdAt), desc(warehouseShortageChecks.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    database.select({ value: count() }).from(warehouseShortageChecks).where(where),
  ]);
  return {
    data: rows.map(({ check, receiptNumber }) => toRecord(check, receiptNumber)),
    totalItems: totals[0]?.value ?? 0,
  };
}

export async function getWarehouseShortageCheck(
  database: Database,
  checkId: string,
): Promise<WarehouseShortageCheckRecord | null> {
  const [row] = await database
    .select({ check: warehouseShortageChecks, receiptNumber: storeReceipts.receiptNumber })
    .from(warehouseShortageChecks)
    .innerJoin(storeReceipts, eq(storeReceipts.id, warehouseShortageChecks.storeReceiptId))
    .where(eq(warehouseShortageChecks.id, checkId))
    .limit(1);
  return row ? toRecord(row.check, row.receiptNumber) : null;
}

/**
 * Found on the shelf: the held units go back to allocatable stock.
 * Lost: the units leave on-hand with the stated reason, so balance and ledger stay reconciled.
 */
export async function resolveWarehouseShortageCheck(
  database: Database,
  input: ResolveWarehouseShortageCheckInput,
): Promise<IdempotencyResult<{ checkId: string }>> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new StoreOperationValidationError('Cần ghi lý do xác nhận tối thiểu 3 ký tự.');
  }
  return withIdempotency(
    database,
    {
      scope: `warehouse-shortage-check.resolve:${input.checkId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'warehouse-shortage-check', input.checkId, async () => {
        const [actor] = await tx
          .select({ id: users.id, role: users.role })
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
        if (!actor) throw new WarehouseShortageCheckAuthorizationError();

        const [check] = await tx
          .select()
          .from(warehouseShortageChecks)
          .where(eq(warehouseShortageChecks.id, input.checkId))
          .for('update')
          .limit(1);
        if (!check)
          throw new StoreOperationValidationError('Không tìm thấy phiếu kiểm hàng thiếu.');
        if (check.status !== 'pending' || check.version !== input.expectedVersion) {
          throw new StoreOperationConflictError(
            'Phiếu kiểm hàng thiếu đã được xử lý hoặc thay đổi.',
          );
        }

        const now = new Date();
        await applyWarehouseMovement(tx, {
          productId: check.productId,
          eventType: input.decision === 'lost' ? 'adjustment' : 'reservation_release',
          onHandDelta: input.decision === 'lost' ? -check.quantity : 0,
          reservedDelta: -check.quantity,
          sourceType: 'warehouse_shortage_check',
          sourceId: check.id,
          eventSequence: 2,
          reason:
            input.decision === 'lost'
              ? `Hàng thiếu xác nhận thất lạc: ${reason}`
              : `Hàng thiếu xác nhận còn ở kho: ${reason}`,
          metadata: { storeId: check.storeId, storeReceiptId: check.storeReceiptId },
          actorUserId: actor.id,
          occurredAt: now,
        });

        const [updated] = await tx
          .update(warehouseShortageChecks)
          .set({
            status: input.decision,
            resolutionReason: reason,
            resolvedByUserId: actor.id,
            resolvedAt: now,
            version: check.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(warehouseShortageChecks.id, check.id),
              eq(warehouseShortageChecks.version, check.version),
              eq(warehouseShortageChecks.status, 'pending'),
            ),
          )
          .returning({ id: warehouseShortageChecks.id });
        if (!updated) {
          throw new StoreOperationConflictError('Phiếu kiểm hàng thiếu đã thay đổi khi xử lý.');
        }

        const before: JsonObject = { status: 'pending', quantity: check.quantity };
        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: actor.id,
          actorRole: actor.role,
          actorStoreId: check.storeId,
          action:
            input.decision === 'lost'
              ? 'WAREHOUSE_SHORTAGE_CONFIRMED_LOST'
              : 'WAREHOUSE_SHORTAGE_RETURNED_TO_STOCK',
          entityType: 'warehouse_shortage_check',
          entityId: check.id,
          before,
          after: { status: input.decision, quantity: check.quantity, reason },
        });

        return {
          value: { checkId: check.id },
          responseStatus: 200,
          responseBody: { checkId: check.id },
          resourceType: 'warehouse_shortage_check',
          resourceId: check.id,
        };
      }),
  );
}

function toRecord(
  check: typeof warehouseShortageChecks.$inferSelect,
  receiptNumber: string,
): WarehouseShortageCheckRecord {
  return {
    id: check.id,
    storeReceiptId: check.storeReceiptId,
    receiptNumber,
    storeId: check.storeId,
    productId: check.productId,
    quantity: check.quantity,
    status: check.status,
    shortageReason: check.shortageReason,
    resolutionReason: check.resolutionReason,
    resolvedByUserId: check.resolvedByUserId,
    resolvedAt: check.resolvedAt,
    version: check.version,
    createdAt: check.createdAt,
  };
}

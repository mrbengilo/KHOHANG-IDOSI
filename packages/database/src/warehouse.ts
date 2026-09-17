import { and, eq } from 'drizzle-orm';

import type { Database } from './client.js';
import { warehouseBalances, warehouseLedgerEntries, type JsonObject } from './schema.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';

export interface WarehouseMovementInput {
  readonly productId: string;
  readonly eventType: typeof warehouseLedgerEntries.$inferInsert.eventType;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly eventSequence?: number;
  readonly reason?: string | null;
  readonly metadata?: JsonObject;
  readonly actorUserId?: string | null;
  readonly occurredAt?: Date;
}

export interface WarehouseMovementResult {
  readonly ledgerEntryId: string;
  readonly onHandQuantity: number;
  readonly reservedQuantity: number;
  readonly replayed: boolean;
}

export class WarehouseBalanceViolationError extends Error {
  public readonly code = 'WAREHOUSE_BALANCE_VIOLATION';

  public constructor() {
    super('Warehouse movement would produce negative stock or reserve more than on-hand stock.');
    this.name = 'WarehouseBalanceViolationError';
  }
}

export class WarehouseMovementConflictError extends Error {
  public readonly code = 'WAREHOUSE_MOVEMENT_CONFLICT';

  public constructor() {
    super('Warehouse movement source was already recorded with different values.');
    this.name = 'WarehouseMovementConflictError';
  }
}

export async function applyWarehouseMovement(
  tx: Transaction,
  input: WarehouseMovementInput,
): Promise<WarehouseMovementResult> {
  validateMovement(input);
  const eventSequence = input.eventSequence ?? 1;

  return withAdvisoryLock(tx, 'warehouse-balance', input.productId, async () => {
    const [existingEntry] = await tx
      .select()
      .from(warehouseLedgerEntries)
      .where(
        and(
          eq(warehouseLedgerEntries.productId, input.productId),
          eq(warehouseLedgerEntries.sourceType, input.sourceType),
          eq(warehouseLedgerEntries.sourceId, input.sourceId),
          eq(warehouseLedgerEntries.eventSequence, eventSequence),
        ),
      )
      .limit(1);

    if (existingEntry) {
      if (
        existingEntry.eventType !== input.eventType ||
        existingEntry.onHandDelta !== input.onHandDelta ||
        existingEntry.reservedDelta !== input.reservedDelta
      ) {
        throw new WarehouseMovementConflictError();
      }

      return {
        ledgerEntryId: existingEntry.id,
        onHandQuantity: existingEntry.onHandAfter,
        reservedQuantity: existingEntry.reservedAfter,
        replayed: true,
      };
    }

    await tx
      .insert(warehouseBalances)
      .values({ productId: input.productId, onHandQuantity: 0, reservedQuantity: 0 })
      .onConflictDoNothing({ target: warehouseBalances.productId });

    const [balance] = await tx
      .select()
      .from(warehouseBalances)
      .where(eq(warehouseBalances.productId, input.productId))
      .for('update')
      .limit(1);

    if (!balance) {
      throw new Error('Warehouse balance row could not be loaded.');
    }

    const onHandAfter = balance.onHandQuantity + input.onHandDelta;
    const reservedAfter = balance.reservedQuantity + input.reservedDelta;

    if (onHandAfter < 0 || reservedAfter < 0 || reservedAfter > onHandAfter) {
      throw new WarehouseBalanceViolationError();
    }

    await tx
      .update(warehouseBalances)
      .set({
        onHandQuantity: onHandAfter,
        reservedQuantity: reservedAfter,
        version: balance.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(warehouseBalances.productId, input.productId));

    const [ledgerEntry] = await tx
      .insert(warehouseLedgerEntries)
      .values({
        productId: input.productId,
        eventType: input.eventType,
        onHandDelta: input.onHandDelta,
        reservedDelta: input.reservedDelta,
        onHandAfter,
        reservedAfter,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventSequence,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
        actorUserId: input.actorUserId ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning({ id: warehouseLedgerEntries.id });

    if (!ledgerEntry) {
      throw new Error('Warehouse ledger insert returned no row.');
    }

    return {
      ledgerEntryId: ledgerEntry.id,
      onHandQuantity: onHandAfter,
      reservedQuantity: reservedAfter,
      replayed: false,
    };
  });
}

export async function recordWarehouseMovement(
  database: Database,
  input: WarehouseMovementInput,
): Promise<WarehouseMovementResult> {
  return withSerializableTransaction(database, (tx) => applyWarehouseMovement(tx, input));
}

function validateMovement(input: WarehouseMovementInput): void {
  if (
    !Number.isSafeInteger(input.onHandDelta) ||
    !Number.isSafeInteger(input.reservedDelta) ||
    (input.onHandDelta === 0 && input.reservedDelta === 0)
  ) {
    throw new RangeError(
      'Warehouse deltas must be safe integers and at least one must be non-zero.',
    );
  }

  if (input.sourceType.trim().length === 0) {
    throw new Error('Warehouse movement sourceType must not be blank.');
  }

  const eventSequence = input.eventSequence ?? 1;
  if (!Number.isSafeInteger(eventSequence) || eventSequence <= 0 || eventSequence > 32_767) {
    throw new RangeError('Warehouse eventSequence must be between 1 and 32767.');
  }
}

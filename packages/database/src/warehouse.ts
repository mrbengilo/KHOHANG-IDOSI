import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  products,
  supplierSourceProducts,
  warehouseBalances,
  warehouseLedgerEntries,
  type JsonObject,
} from './schema.js';
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

export interface HistoricalWarehouseBalance {
  readonly productId: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly version: number;
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
    if (!SUPPLIER_CONSISTENT_SOURCE_TYPES.has(input.sourceType)) {
      await flagSupplierProductForReconciliation(
        tx,
        input.productId,
        `Biến động kho ngoài luồng đối chiếu (${input.sourceType}); cần đối chiếu lại tồn Reshare.`,
      );
    }

    return {
      ledgerEntryId: ledgerEntry.id,
      onHandQuantity: onHandAfter,
      reservedQuantity: reservedAfter,
      replayed: false,
    };
  });
}

/**
 * Movements that keep onHand - reserved equal to a reconciled SKU's supplier free stock F:
 * holds and releases of commitments B has not recorded, receipt finalization (B already
 * deducted those units), shortage-check holds of units B already deducted, and the supplier
 * projection itself. Any other movement on a reconciled SKU (an unforeseen path) blocks the
 * SKU's new allocations until C re-observes B; it never silently creates free stock.
 */
export const SUPPLIER_CONSISTENT_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'priority_offer',
  'allocation_run',
  'allocation_result_decision',
  // Issuing an RE order lowers on-hand and reserved together (H - R unchanged) while the issued
  // quantity stays in U until an observation reflects it: F is unchanged (supplier-commitments).
  'reshare_order',
  'store_receipt',
  'warehouse_shortage_check',
  'supplier_stock_observation',
  'supplier_event_batch',
]);

/**
 * Marks a reconciled SKU as needing a new observation before it may be allocated again. A SKU
 * without a baseline is already blocked and keeps its state; an unmapped SKU is untouched.
 * Returns whether the SKU is reconciled at all.
 */
export async function flagSupplierProductForReconciliation(
  tx: Transaction,
  productId: string,
  reason: string,
): Promise<boolean> {
  const updated = await tx
    .update(supplierSourceProducts)
    .set({
      status: sql`case when ${supplierSourceProducts.status} = 'active' then 'needs_reconciliation'::supplier_source_product_status else ${supplierSourceProducts.status} end`,
      blockReason: sql`case when ${supplierSourceProducts.status} = 'active' then ${reason.slice(0, 500)} else ${supplierSourceProducts.blockReason} end`,
      blockedAt: sql`case when ${supplierSourceProducts.status} = 'active' then now() else ${supplierSourceProducts.blockedAt} end`,
      revision: sql`${supplierSourceProducts.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(supplierSourceProducts.productId, productId))
    .returning({ id: supplierSourceProducts.id });
  return updated.length > 0;
}

export async function recordWarehouseMovement(
  database: Database,
  input: WarehouseMovementInput,
): Promise<WarehouseMovementResult> {
  return withSerializableTransaction(database, (tx) => applyWarehouseMovement(tx, input));
}

/** Canonical historical projection used by the 08:00 snapshot and reconciliation tests. */
export async function loadWarehouseBalancesAt(
  tx: Transaction,
  cutoff: Date,
): Promise<readonly HistoricalWarehouseBalance[]> {
  const productRows = await tx
    .select({ id: products.id })
    .from(products)
    .orderBy(asc(products.displayOrder), asc(products.id));
  if (productRows.length === 0) return [];

  const productIds = productRows.map((row) => row.id);
  const ledgerRows = await tx
    .select({
      id: warehouseLedgerEntries.id,
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
      desc(warehouseLedgerEntries.id),
    );
  const ledgerPresenceRows = await tx
    .select({ productId: warehouseLedgerEntries.productId })
    .from(warehouseLedgerEntries)
    .where(inArray(warehouseLedgerEntries.productId, productIds))
    .groupBy(warehouseLedgerEntries.productId);
  const balanceRows = await tx
    .select()
    .from(warehouseBalances)
    .where(inArray(warehouseBalances.productId, productIds));
  const currentByProduct = new Map(balanceRows.map((row) => [row.productId, row]));
  const productsWithLedger = new Set(ledgerPresenceRows.map((row) => row.productId));
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
    if (
      current &&
      !productsWithLedger.has(productId) &&
      current.updatedAt.getTime() <= cutoff.getTime()
    ) {
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

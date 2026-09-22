import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { formatInboundReceiptNumber } from '@idosi/contracts';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  outboundBagPicks,
  products,
  receiptBagWeights,
  receiptCosts,
  receiptItems,
  receipts,
  users,
  type JsonObject,
} from './schema.js';
import {
  calculateWeightedCostVnd,
  gramsToKilogramsExact,
  kilogramsToGramsExact,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';
import { applyWarehouseMovement, WarehouseBalanceViolationError } from './warehouse.js';

const MAX_CONTRACT_VND = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_NUMERIC_WEIGHT_GRAMS = 99_999_999_999_999n;
const MAX_BAGS_PER_RECEIPT = 2_000;
const MAX_PRODUCTS_PER_RECEIPT = 500;

export interface SupplierInboundRequestContext {
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface SupplierInboundBagInput {
  readonly productId: string;
  readonly bagCode: string;
  readonly weightKg: string | null;
}

export interface ReceiveSupplierInboundInput extends SupplierInboundRequestContext {
  readonly vat?: { readonly amountVnd: bigint; readonly ratePercent: 8 };
  readonly referenceCode: string | undefined;
  readonly supplierName: string;
  readonly receivedAt: Date;
  readonly bags: readonly SupplierInboundBagInput[];
  readonly receivedByUserId: string;
  readonly actorRole: 'admin' | 'htkd' | 'wholesale_account';
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ReceivedSupplierInbound {
  readonly receiptId: string;
  readonly version: number;
  readonly totalWeightKg: string | null;
  readonly productBalances: readonly {
    readonly productId: string;
    readonly receivedQuantity: number;
    readonly onHandQuantity: number;
    readonly reservedQuantity: number;
  }[];
}

export interface SupplierProductCostInput {
  readonly productId: string;
  readonly priceVndPerKg: bigint;
}

export interface ConfirmSupplierInboundCostsInput extends SupplierInboundRequestContext {
  readonly invoiceGoodsCostVnd?: bigint;
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly productCosts: readonly SupplierProductCostInput[];
  readonly transportationFeeVnd: bigint;
  readonly handlingFeeVnd: bigint;
  readonly confirmedByUserId: string;
  readonly actorRole: 'admin' | 'htkd' | 'wholesale_account';
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ConfirmedSupplierInboundCosts {
  readonly receiptId: string;
  readonly version: number;
  readonly goodsCostVnd: bigint;
  readonly transportationFeeVnd: bigint;
  readonly handlingFeeVnd: bigint;
  readonly totalCostVnd: bigint | null;
}

export interface CancelSupplierInboundInput extends SupplierInboundRequestContext {
  readonly receiptId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly cancelledByUserId: string;
  readonly actorRole: 'admin' | 'htkd' | 'wholesale_account';
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface CancelledSupplierInbound {
  readonly receiptId: string;
  readonly version: number;
  readonly productBalances: readonly {
    readonly productId: string;
    readonly cancelledQuantity: number;
    readonly onHandQuantity: number;
    readonly reservedQuantity: number;
  }[];
}

interface AggregatedInboundItem {
  readonly productId: string;
  readonly bags: readonly {
    readonly bagCode: string;
    readonly weightKg: string | null;
    readonly weightGrams: bigint | null;
  }[];
  readonly totalWeightGrams: bigint | null;
}

export class SupplierInboundNotFoundError extends Error {
  public readonly code = 'SUPPLIER_INBOUND_NOT_FOUND';

  public constructor(message: string) {
    super(message);
    this.name = 'SupplierInboundNotFoundError';
  }
}

export class SupplierInboundConflictError extends Error {
  public readonly code = 'SUPPLIER_INBOUND_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'SupplierInboundConflictError';
  }
}

export class SupplierInboundValidationError extends Error {
  public readonly code = 'SUPPLIER_INBOUND_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'SupplierInboundValidationError';
  }
}

export class SupplierInboundAuthorizationError extends Error {
  public readonly code = 'SUPPLIER_INBOUND_FORBIDDEN';

  public constructor() {
    super('Supplier inbound mutations require an active admin or HTKD account.');
    this.name = 'SupplierInboundAuthorizationError';
  }
}

/**
 * Persists the supplier document, exact bag evidence, warehouse movement and audit row in one
 * serializable transaction. Stock becomes available immediately; cost confirmation is independent.
 */
export async function receiveSupplierInbound(
  database: Database,
  input: ReceiveSupplierInboundInput,
): Promise<IdempotencyResult<ReceivedSupplierInbound>> {
  normalizeReceiveInput(input);
  return withIdempotency(
    database,
    {
      scope: 'supplier-inbound.receive',
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const received = await receiveSupplierInboundInTransaction(tx, input);
      return {
        value: received,
        responseStatus: 201,
        responseBody: supplierInboundMutationBody(received),
        resourceType: 'supplier_inbound_receipt',
        resourceId: received.receiptId,
      };
    },
  );
}

export async function receiveSupplierInboundInTransaction(
  tx: Transaction,
  input: Omit<ReceiveSupplierInboundInput, 'bags' | 'referenceCode' | 'supplierName'> & {
    readonly bags: readonly SupplierInboundBagInput[];
    readonly referenceCode: string | undefined;
    readonly supplierName: string;
  },
): Promise<ReceivedSupplierInbound> {
  const normalized = normalizeReceiveInput(input);
  await assertWarehouseActor(tx, input.receivedByUserId, input.actorRole);
  if (!normalized.referenceCode) {
    // Sequence allocation happens only after the idempotency replay gate. Gaps are allowed.
    // Legacy clients may have explicitly claimed a future PN reference.
    for (;;) {
      const result = await tx.execute<{ value: string }>(
        sql`SELECT nextval('supplier_receipt_number_seq')::text AS value`,
      );
      const candidate = formatInboundReceiptNumber(result.rows[0]!.value, new Date());
      const [existing] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.receiptNumber, candidate))
        .limit(1);
      if (!existing) {
        normalized.referenceCode = candidate;
        break;
      }
    }
  }
  return withAdvisoryLock(tx, 'supplier-inbound-reference', normalized.referenceCode, async () => {
    for (const bagCode of normalized.bags.map((bag) => bag.bagCode).sort()) {
      await withAdvisoryLock(tx, 'supplier-inbound-bag', bagCode, async () => undefined);
    }

    const [duplicateReference] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.receiptNumber, normalized.referenceCode))
      .limit(1);
    if (duplicateReference) {
      throw new SupplierInboundConflictError('Supplier receipt reference already exists.');
    }

    const bagCodes = normalized.bags.map((bag) => bag.bagCode);
    const [duplicateBag] = await tx
      .select({ id: receiptBagWeights.id })
      .from(receiptBagWeights)
      .where(inArray(receiptBagWeights.labelCode, bagCodes))
      .limit(1);
    if (duplicateBag) {
      throw new SupplierInboundConflictError('A supplier bag code already exists.');
    }

    const items = aggregateInboundBags(normalized.bags);
    const productIds = items.map((item) => item.productId);
    const productRows = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          inArray(products.id, productIds),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      );
    const activeProductIds = new Set(productRows.map((product) => product.id));
    const unavailableProductId = productIds.find((productId) => !activeProductIds.has(productId));
    if (unavailableProductId) {
      throw new SupplierInboundValidationError(
        `Supplier receipt references an unknown or inactive product: ${unavailableProductId}.`,
      );
    }

    const now = new Date();
    const [created] = await tx
      .insert(receipts)
      .values({
        receiptNumber: normalized.referenceCode,
        supplierName: normalized.supplierName,
        vatAmountVnd: input.vat?.amountVnd ?? null,
        vatRatePercent: input.vat?.ratePercent ?? null,
        status: 'submitted',
        receivedAt: input.receivedAt,
        submittedAt: now,
        createdByUserId: input.receivedByUserId,
      })
      .returning({ id: receipts.id, version: receipts.version });
    if (!created) throw new Error('Supplier receipt insert returned no row.');

    const persistedItems = await tx
      .insert(receiptItems)
      .values(
        items.map((item) => ({
          receiptId: created.id,
          productId: item.productId,
          quantity: item.bags.length,
          bagCount: item.bags.length,
          totalNetWeightKg:
            item.totalWeightGrams === null ? null : gramsToKilogramsExact(item.totalWeightGrams),
        })),
      )
      .returning({ id: receiptItems.id, productId: receiptItems.productId });
    const itemIdByProduct = new Map(persistedItems.map((item) => [item.productId, item.id]));

    await tx.insert(receiptBagWeights).values(
      items.flatMap((item) => {
        const receiptItemId = itemIdByProduct.get(item.productId);
        if (!receiptItemId) throw new Error('Supplier receipt item insert lost a product row.');
        return item.bags.map((bag, index) => ({
          receiptItemId,
          bagNumber: index + 1,
          labelCode: bag.bagCode,
          grossWeightKg: bag.weightKg,
          tareWeightKg: '0.000',
          netWeightKg: bag.weightKg,
        }));
      }),
    );

    const productBalances: ReceivedSupplierInbound['productBalances'][number][] = [];
    for (const item of items) {
      const movement = await applyWarehouseMovement(tx, {
        productId: item.productId,
        eventType: 'receipt',
        onHandDelta: item.bags.length,
        reservedDelta: 0,
        sourceType: 'supplier_receipt',
        sourceId: created.id,
        reason: `Supplier receipt ${normalized.referenceCode}`,
        metadata: {
          bagCount: item.bags.length,
          supplierName: normalized.supplierName,
          receivedAt: input.receivedAt.toISOString(),
          totalWeightKg:
            item.totalWeightGrams === null ? null : gramsToKilogramsExact(item.totalWeightGrams),
        },
        actorUserId: input.receivedByUserId,
        // Stock becomes available when this command is recorded, not at a client-supplied
        // document date. Backdating an after-balance would invalidate later snapshots.
        occurredAt: now,
      });
      productBalances.push({
        productId: item.productId,
        receivedQuantity: item.bags.length,
        onHandQuantity: movement.onHandQuantity,
        reservedQuantity: movement.reservedQuantity,
      });
    }

    const totalWeightKg = items.some((item) => item.totalWeightGrams === null)
      ? null
      : gramsToKilogramsExact(
          items.reduce((total, item) => total + (item.totalWeightGrams ?? 0n), 0n),
        );
    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.receivedByUserId,
      actorRole: input.actorRole,
      actorStoreId: null,
      action: 'SUPPLIER_INBOUND_RECEIVED',
      entityType: 'supplier_inbound_receipt',
      entityId: created.id,
      after: {
        referenceCode: normalized.referenceCode,
        supplierName: normalized.supplierName,
        status: 'submitted',
        version: created.version,
        receivedAt: input.receivedAt.toISOString(),
        totalWeightKg,
        vat: input.vat
          ? { amountVnd: input.vat.amountVnd.toString(), ratePercent: input.vat.ratePercent }
          : null,
        products: productBalances.map((balance) => ({
          productId: balance.productId,
          receivedQuantity: balance.receivedQuantity,
        })),
      },
      metadata: { bagCount: normalized.bags.length },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    });

    return { receiptId: created.id, version: created.version, totalWeightKg, productBalances };
  });
}

export async function confirmSupplierInboundCosts(
  database: Database,
  input: ConfirmSupplierInboundCostsInput,
): Promise<IdempotencyResult<ConfirmedSupplierInboundCosts>> {
  validateCostConfirmationInput(input);
  return withIdempotency(
    database,
    {
      scope: `supplier-inbound.confirm-costs:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const confirmed = await confirmSupplierInboundCostsInTransaction(tx, input);
      return {
        value: confirmed,
        responseStatus: 200,
        responseBody: supplierInboundCostBody(confirmed),
        resourceType: 'supplier_inbound_receipt',
        resourceId: confirmed.receiptId,
      };
    },
  );
}

export async function confirmSupplierInboundCostsInTransaction(
  tx: Transaction,
  input: Omit<ConfirmSupplierInboundCostsInput, 'idempotencyKey' | 'requestHash'>,
): Promise<ConfirmedSupplierInboundCosts> {
  validateCostConfirmationInput(input);
  await assertWarehouseActor(tx, input.confirmedByUserId, input.actorRole);
  return withAdvisoryLock(tx, 'supplier-inbound-receipt', input.receiptId, async () => {
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, input.receiptId), isNull(receipts.deletedAt)))
      .for('update')
      .limit(1);
    if (!receipt) throw new SupplierInboundNotFoundError('Supplier receipt was not found.');
    if (receipt.version !== input.expectedVersion) {
      throw new SupplierInboundConflictError('Supplier receipt version is stale.');
    }
    if (receipt.status !== 'submitted') {
      throw new SupplierInboundConflictError('Only a cost-pending supplier receipt can be priced.');
    }

    const itemRows = await tx
      .select()
      .from(receiptItems)
      .where(eq(receiptItems.receiptId, receipt.id))
      .orderBy(receiptItems.productId);
    const priceByProduct = new Map(
      input.productCosts.map((cost) => [cost.productId, cost.priceVndPerKg]),
    );
    if (
      input.invoiceGoodsCostVnd === undefined &&
      (itemRows.length !== priceByProduct.size ||
        itemRows.some((item) => !priceByProduct.has(item.productId)))
    ) {
      throw new SupplierInboundValidationError(
        'Cost confirmation must contain each receipt product exactly once.',
      );
    }

    const bagRows = await tx
      .select({
        id: receiptBagWeights.id,
        receiptItemId: receiptBagWeights.receiptItemId,
        netWeightKg: receiptBagWeights.netWeightKg,
      })
      .from(receiptBagWeights)
      .innerJoin(receiptItems, eq(receiptBagWeights.receiptItemId, receiptItems.id))
      .where(eq(receiptItems.receiptId, receipt.id))
      .orderBy(receiptBagWeights.receiptItemId, receiptBagWeights.bagNumber);
    const bagsByItem = new Map<string, typeof bagRows>();
    for (const bag of bagRows) {
      const collection = bagsByItem.get(bag.receiptItemId) ?? [];
      collection.push(bag);
      bagsByItem.set(bag.receiptItemId, collection);
    }

    const now = new Date();
    let goodsCostVnd = input.invoiceGoodsCostVnd ?? 0n;
    const goodsCosts: { receiptItemId: string; amountVnd: bigint; productId: string }[] = [];
    for (const item of input.invoiceGoodsCostVnd === undefined ? itemRows : []) {
      const priceVndPerKg = priceByProduct.get(item.productId);
      if (priceVndPerKg === undefined) {
        throw new SupplierInboundValidationError('A receipt product is missing its price.');
      }
      const itemBags = bagsByItem.get(item.id) ?? [];
      if (itemBags.length !== item.bagCount || itemBags.length !== item.quantity) {
        throw new SupplierInboundValidationError('Persisted supplier bag evidence is incomplete.');
      }
      let itemCostVnd = 0n;
      for (const bag of itemBags) {
        if (bag.netWeightKg === null)
          throw new SupplierInboundValidationError(
            'Chưa đủ khối lượng từng bao để xác nhận chi phí theo kg.',
          );
        itemCostVnd += calculateWeightedCostVnd(bag.netWeightKg, priceVndPerKg);
      }
      assertVnd(itemCostVnd, 'product goods cost');
      goodsCostVnd += itemCostVnd;
      assertVnd(goodsCostVnd, 'receipt goods cost');

      await tx
        .update(receiptBagWeights)
        .set({
          pricePerKgVnd: priceVndPerKg,
          goodsCostVnd: sql<bigint>`round(${receiptBagWeights.netWeightKg} * ${priceVndPerKg})::bigint`,
          updatedAt: now,
        })
        .where(eq(receiptBagWeights.receiptItemId, item.id));
      await tx
        .update(receiptItems)
        .set({ pricePerKgVnd: priceVndPerKg, goodsCostVnd: itemCostVnd, updatedAt: now })
        .where(eq(receiptItems.id, item.id));
      goodsCosts.push({
        receiptItemId: item.id,
        amountVnd: itemCostVnd,
        productId: item.productId,
      });
    }

    const totalCostVnd =
      goodsCostVnd +
      input.transportationFeeVnd +
      input.handlingFeeVnd +
      (receipt.vatAmountVnd ?? 0n);
    assertVnd(totalCostVnd, 'receipt total cost');
    await tx.insert(receiptCosts).values([
      ...(input.invoiceGoodsCostVnd === undefined
        ? []
        : [
            {
              receiptId: receipt.id,
              costType: 'goods' as const,
              amountVnd: input.invoiceGoodsCostVnd,
              description: 'Invoice goods total; not allocated to products or bags',
            },
          ]),
      ...goodsCosts.map((cost) => ({
        receiptId: receipt.id,
        receiptItemId: cost.receiptItemId,
        costType: 'goods' as const,
        amountVnd: cost.amountVnd,
        description: `Goods cost for product ${cost.productId}`,
      })),
      {
        receiptId: receipt.id,
        costType: 'shipping' as const,
        amountVnd: input.transportationFeeVnd,
        description: 'Supplier receipt transportation fee',
      },
      {
        receiptId: receipt.id,
        costType: 'handling' as const,
        amountVnd: input.handlingFeeVnd,
        description: 'Supplier receipt handling fee',
      },
      ...(receipt.vatAmountVnd === null
        ? []
        : [
            {
              receiptId: receipt.id,
              costType: 'vat' as const,
              amountVnd: receipt.vatAmountVnd,
              description: `Supplier receipt VAT ${receipt.vatRatePercent}% (entered amount)`,
            },
          ]),
    ]);

    const [confirmed] = await tx
      .update(receipts)
      .set({
        status: 'confirmed',
        confirmedAt: now,
        confirmedByUserId: input.confirmedByUserId,
        totalGoodsCostVnd: goodsCostVnd,
        totalShippingCostVnd: input.transportationFeeVnd,
        totalHandlingCostVnd: input.handlingFeeVnd,
        version: receipt.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(receipts.id, receipt.id),
          eq(receipts.version, input.expectedVersion),
          eq(receipts.status, 'submitted'),
          isNull(receipts.deletedAt),
        ),
      )
      .returning({ version: receipts.version });
    if (!confirmed) {
      throw new SupplierInboundConflictError('Supplier receipt changed during cost confirmation.');
    }

    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.confirmedByUserId,
      actorRole: input.actorRole,
      actorStoreId: null,
      action: 'SUPPLIER_INBOUND_COST_CONFIRMED',
      entityType: 'supplier_inbound_receipt',
      entityId: receipt.id,
      before: { status: receipt.status, version: receipt.version },
      after: {
        status: 'confirmed',
        version: confirmed.version,
        goodsCostVnd: goodsCostVnd.toString(),
        costingBasis: input.invoiceGoodsCostVnd === undefined ? 'WEIGHT' : 'INVOICE',
        transportationFeeVnd: input.transportationFeeVnd.toString(),
        handlingFeeVnd: input.handlingFeeVnd.toString(),
        vatAmountVnd: receipt.vatAmountVnd?.toString() ?? null,
        totalCostVnd: receipt.vatAmountVnd === null ? null : totalCostVnd.toString(),
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    });

    return {
      receiptId: receipt.id,
      version: confirmed.version,
      goodsCostVnd,
      transportationFeeVnd: input.transportationFeeVnd,
      handlingFeeVnd: input.handlingFeeVnd,
      totalCostVnd: receipt.vatAmountVnd === null ? null : totalCostVnd,
    };
  });
}

export async function updateSupplierInboundVat(
  database: Database,
  input: SupplierInboundRequestContext & {
    readonly receiptId: string;
    readonly expectedVersion: number;
    readonly vat: { readonly amountVnd: bigint; readonly ratePercent: 8 };
    readonly reason: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
) {
  assertVnd(input.vat.amountVnd, 'vatAmountVnd');
  if (
    input.vat.ratePercent !== 8 ||
    input.reason.trim().length < 3 ||
    input.reason.trim().length > 500
  ) {
    throw new SupplierInboundValidationError(
      'VAT requires an entered amount, 8% rate and audit reason.',
    );
  }
  return withIdempotency(
    database,
    {
      scope: `supplier-inbound.vat:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      await assertWarehouseActor(tx, input.actorUserId, 'admin');
      return withAdvisoryLock(tx, 'supplier-inbound-receipt', input.receiptId, async () => {
        const [receipt] = await tx
          .select()
          .from(receipts)
          .where(and(eq(receipts.id, input.receiptId), isNull(receipts.deletedAt)))
          .for('update')
          .limit(1);
        if (!receipt) throw new SupplierInboundNotFoundError('Supplier receipt was not found.');
        if (
          receipt.version !== input.expectedVersion ||
          !['submitted', 'confirmed'].includes(receipt.status)
        )
          throw new SupplierInboundConflictError('Receipt is stale or cancelled.');
        const totalCostVnd =
          receipt.totalGoodsCostVnd +
          receipt.totalShippingCostVnd +
          receipt.totalHandlingCostVnd +
          receipt.totalOtherCostVnd +
          input.vat.amountVnd;
        assertVnd(totalCostVnd, 'receipt total including VAT');
        if (receipt.status === 'confirmed') {
          const costs = await tx
            .select({ id: receiptCosts.id })
            .from(receiptCosts)
            .where(and(eq(receiptCosts.receiptId, receipt.id), eq(receiptCosts.costType, 'vat')));
          if (costs.length > 1)
            throw new SupplierInboundValidationError('Receipt has conflicting VAT cost lines.');
          if (costs[0])
            await tx
              .update(receiptCosts)
              .set({
                amountVnd: input.vat.amountVnd,
                description: 'VAT 8% (entered amount; correction recorded in audit)',
              })
              .where(eq(receiptCosts.id, costs[0].id));
          else
            await tx.insert(receiptCosts).values({
              receiptId: receipt.id,
              costType: 'vat',
              amountVnd: input.vat.amountVnd,
              description: 'VAT 8% (entered amount)',
            });
        }
        const version = receipt.version + 1;
        await tx
          .update(receipts)
          .set({
            vatAmountVnd: input.vat.amountVnd,
            vatRatePercent: 8,
            version,
            updatedAt: new Date(),
          })
          .where(eq(receipts.id, receipt.id));
        await tx.insert(auditLogs).values({
          action: 'SUPPLIER_INBOUND_VAT_UPDATED',
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          entityType: 'supplier_inbound_receipt',
          entityId: receipt.id,
          requestId: input.requestId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          before: {
            amountVnd: receipt.vatAmountVnd?.toString() ?? null,
            ratePercent: receipt.vatRatePercent,
            version: receipt.version,
          },
          after: { amountVnd: input.vat.amountVnd.toString(), ratePercent: 8, version },
          metadata: { reason: input.reason.trim() },
        });
        return {
          value: { receiptId: receipt.id, version },
          responseStatus: 200,
          responseBody: { receiptId: receipt.id, version },
          resourceType: 'supplier_inbound_receipt',
          resourceId: receipt.id,
        };
      });
    },
  );
}

export async function cancelSupplierInbound(
  database: Database,
  input: CancelSupplierInboundInput,
): Promise<IdempotencyResult<CancelledSupplierInbound>> {
  validateCancellationInput(input);
  return withIdempotency(
    database,
    {
      scope: `supplier-inbound.cancel:${input.receiptId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const cancelled = await cancelSupplierInboundInTransaction(tx, input);
      return {
        value: cancelled,
        responseStatus: 200,
        responseBody: supplierInboundMutationBody(cancelled),
        resourceType: 'supplier_inbound_receipt',
        resourceId: cancelled.receiptId,
      };
    },
  );
}

export async function cancelSupplierInboundInTransaction(
  tx: Transaction,
  input: Omit<CancelSupplierInboundInput, 'idempotencyKey' | 'requestHash'>,
): Promise<CancelledSupplierInbound> {
  validateCancellationInput(input);
  await assertWarehouseActor(tx, input.cancelledByUserId, input.actorRole);
  return withAdvisoryLock(tx, 'supplier-inbound-receipt', input.receiptId, async () => {
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, input.receiptId), isNull(receipts.deletedAt)))
      .for('update')
      .limit(1);
    if (!receipt) throw new SupplierInboundNotFoundError('Supplier receipt was not found.');
    if (receipt.version !== input.expectedVersion) {
      throw new SupplierInboundConflictError('Supplier receipt version is stale.');
    }
    if (receipt.status !== 'submitted') {
      throw new SupplierInboundConflictError(
        'Only a cost-pending supplier receipt can be cancelled.',
      );
    }

    const itemRows = await tx
      .select({ productId: receiptItems.productId, quantity: receiptItems.quantity })
      .from(receiptItems)
      .where(eq(receiptItems.receiptId, receipt.id))
      .orderBy(receiptItems.productId);
    const [pickedBag] = await tx
      .select({ id: outboundBagPicks.id })
      .from(outboundBagPicks)
      .innerJoin(
        receiptBagWeights,
        eq(outboundBagPicks.sourceReceiptBagWeightId, receiptBagWeights.id),
      )
      .innerJoin(receiptItems, eq(receiptBagWeights.receiptItemId, receiptItems.id))
      .where(eq(receiptItems.receiptId, receipt.id))
      .limit(1);
    if (pickedBag) {
      throw new SupplierInboundConflictError(
        'Supplier receipt contains a bag already linked to an outbound shipment.',
      );
    }

    const reason = input.reason.trim();
    const now = new Date();
    const productBalances: CancelledSupplierInbound['productBalances'][number][] = [];
    try {
      for (const item of itemRows) {
        const movement = await applyWarehouseMovement(tx, {
          productId: item.productId,
          eventType: 'adjustment',
          onHandDelta: -item.quantity,
          reservedDelta: 0,
          sourceType: 'supplier_receipt_cancellation',
          sourceId: receipt.id,
          reason,
          metadata: { originalReceiptId: receipt.id },
          actorUserId: input.cancelledByUserId,
          occurredAt: now,
        });
        productBalances.push({
          productId: item.productId,
          cancelledQuantity: item.quantity,
          onHandQuantity: movement.onHandQuantity,
          reservedQuantity: movement.reservedQuantity,
        });
      }
    } catch (error) {
      if (error instanceof WarehouseBalanceViolationError) {
        throw new SupplierInboundConflictError(
          'Supplier receipt stock is reserved or already consumed and cannot be cancelled.',
        );
      }
      throw error;
    }

    const [cancelled] = await tx
      .update(receipts)
      .set({
        status: 'cancelled',
        notes: reason,
        version: receipt.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(receipts.id, receipt.id),
          eq(receipts.version, input.expectedVersion),
          eq(receipts.status, 'submitted'),
          isNull(receipts.deletedAt),
        ),
      )
      .returning({ version: receipts.version });
    if (!cancelled) {
      throw new SupplierInboundConflictError('Supplier receipt changed during cancellation.');
    }

    await tx.insert(auditLogs).values({
      requestId: input.requestId ?? null,
      actorUserId: input.cancelledByUserId,
      actorRole: input.actorRole,
      actorStoreId: null,
      action: 'SUPPLIER_INBOUND_CANCELLED',
      entityType: 'supplier_inbound_receipt',
      entityId: receipt.id,
      before: { status: receipt.status, version: receipt.version },
      after: {
        status: 'cancelled',
        version: cancelled.version,
        reason,
        products: productBalances.map((balance) => ({
          productId: balance.productId,
          cancelledQuantity: balance.cancelledQuantity,
        })),
      },
      metadata: { reason },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    });

    return { receiptId: receipt.id, version: cancelled.version, productBalances };
  });
}

function normalizeReceiveInput(input: {
  readonly vat?: { readonly amountVnd: bigint; readonly ratePercent: 8 };
  readonly referenceCode: string | undefined;
  readonly supplierName: string;
  readonly receivedAt: Date;
  readonly bags: readonly SupplierInboundBagInput[];
}): {
  referenceCode: string;
  readonly supplierName: string;
  readonly bags: readonly SupplierInboundBagInput[];
} {
  const referenceCode = input.referenceCode?.trim() ?? '';
  if (input.vat) {
    assertVnd(input.vat.amountVnd, 'vatAmountVnd');
    if (input.vat.ratePercent !== 8)
      throw new SupplierInboundValidationError('VAT rate must be 8%.');
  }
  const supplierName = input.supplierName.trim();
  if (
    (input.referenceCode !== undefined && referenceCode.length === 0) ||
    referenceCode.length > 100
  ) {
    throw new SupplierInboundValidationError(
      'Supplier receipt reference must contain 1 to 100 characters.',
    );
  }
  if (supplierName.length === 0 || supplierName.length > 200) {
    throw new SupplierInboundValidationError('Supplier name must contain 1 to 200 characters.');
  }
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.valueOf())) {
    throw new SupplierInboundValidationError('Supplier receipt timestamp is invalid.');
  }
  if (input.bags.length === 0 || input.bags.length > MAX_BAGS_PER_RECEIPT) {
    throw new SupplierInboundValidationError(
      `A supplier receipt must contain 1 to ${MAX_BAGS_PER_RECEIPT} bags.`,
    );
  }

  const bags = input.bags.map((bag) => {
    const bagCode = bag.bagCode.trim();
    if (bag.productId.trim().length === 0) {
      throw new SupplierInboundValidationError('Every supplier bag requires a product.');
    }
    if (bagCode.length === 0 || bagCode.length > 100) {
      throw new SupplierInboundValidationError('Bag codes must contain 1 to 100 characters.');
    }
    if (bag.weightKg !== null && kilogramsToGramsExact(bag.weightKg) <= 0n) {
      throw new SupplierInboundValidationError('Supplier bag weight must be positive.');
    }
    return { productId: bag.productId, bagCode, weightKg: bag.weightKg };
  });
  if (new Set(bags.map((bag) => bag.bagCode)).size !== bags.length) {
    throw new SupplierInboundValidationError('Bag codes must be unique within a receipt.');
  }
  if (new Set(bags.map((bag) => bag.productId)).size > MAX_PRODUCTS_PER_RECEIPT) {
    throw new SupplierInboundValidationError(
      `A supplier receipt cannot contain more than ${MAX_PRODUCTS_PER_RECEIPT} products.`,
    );
  }
  return { referenceCode, supplierName, bags };
}

function aggregateInboundBags(
  bags: readonly SupplierInboundBagInput[],
): readonly AggregatedInboundItem[] {
  const grouped = new Map<
    string,
    {
      bags: { bagCode: string; weightKg: string | null; weightGrams: bigint | null }[];
      total: bigint;
      complete: boolean;
    }
  >();
  for (const bag of bags) {
    const weightGrams = bag.weightKg === null ? null : kilogramsToGramsExact(bag.weightKg);
    const item = grouped.get(bag.productId) ?? { bags: [], total: 0n, complete: true };
    item.bags.push({ bagCode: bag.bagCode, weightKg: bag.weightKg, weightGrams });
    item.total += weightGrams ?? 0n;
    if (weightGrams === null) item.complete = false;
    grouped.set(bag.productId, item);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([productId, item]) => {
      if (item.total > MAX_NUMERIC_WEIGHT_GRAMS) {
        throw new SupplierInboundValidationError(
          `Total bag weight for product ${productId} exceeds the supported range.`,
        );
      }
      return { productId, bags: item.bags, totalWeightGrams: item.complete ? item.total : null };
    });
}

async function assertWarehouseActor(
  tx: Transaction,
  userId: string,
  expectedRole: 'admin' | 'htkd' | 'wholesale_account',
): Promise<void> {
  const [actor] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!actor || actor.status !== 'active' || actor.role !== expectedRole) {
    throw new SupplierInboundAuthorizationError();
  }
}

function validateCostConfirmationInput(input: {
  readonly invoiceGoodsCostVnd?: bigint;
  readonly expectedVersion: number;
  readonly productCosts: readonly SupplierProductCostInput[];
  readonly transportationFeeVnd: bigint;
  readonly handlingFeeVnd: bigint;
}): void {
  validateExpectedVersion(input.expectedVersion);
  if (input.invoiceGoodsCostVnd !== undefined) {
    assertVnd(input.invoiceGoodsCostVnd, 'invoiceGoodsCostVnd');
    if (input.productCosts.length !== 0)
      throw new SupplierInboundValidationError('Invoice amount cannot be combined with kg prices.');
  } else if (
    input.productCosts.length === 0 ||
    input.productCosts.length > MAX_PRODUCTS_PER_RECEIPT
  ) {
    throw new SupplierInboundValidationError(
      `Cost confirmation must contain 1 to ${MAX_PRODUCTS_PER_RECEIPT} products.`,
    );
  }
  if (
    new Set(input.productCosts.map((cost) => cost.productId)).size !== input.productCosts.length
  ) {
    throw new SupplierInboundValidationError('A product cost may appear only once.');
  }
  for (const cost of input.productCosts) assertVnd(cost.priceVndPerKg, 'priceVndPerKg');
  assertVnd(input.transportationFeeVnd, 'transportationFeeVnd');
  assertVnd(input.handlingFeeVnd, 'handlingFeeVnd');
}

function validateCancellationInput(input: {
  readonly expectedVersion: number;
  readonly reason: string;
}): void {
  validateExpectedVersion(input.expectedVersion);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new SupplierInboundValidationError(
      'Supplier receipt cancellation reason must contain 3 to 500 characters.',
    );
  }
}

function validateExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new SupplierInboundValidationError('Expected version must be a non-negative integer.');
  }
}

function assertVnd(value: bigint, label: string): void {
  if (value < 0n || value > MAX_CONTRACT_VND) {
    throw new SupplierInboundValidationError(`${label} is outside the supported VND range.`);
  }
}

function supplierInboundMutationBody(
  result: ReceivedSupplierInbound | CancelledSupplierInbound,
): JsonObject {
  return { receiptId: result.receiptId, version: result.version };
}

function supplierInboundCostBody(result: ConfirmedSupplierInboundCosts): JsonObject {
  return {
    receiptId: result.receiptId,
    version: result.version,
    goodsCostVnd: result.goodsCostVnd.toString(),
    transportationFeeVnd: result.transportationFeeVnd.toString(),
    handlingFeeVnd: result.handlingFeeVnd.toString(),
    totalCostVnd: result.totalCostVnd?.toString() ?? null,
  };
}

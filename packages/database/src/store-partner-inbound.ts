import { and, asc, count, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { formatPartnerInboundNumber } from '@idosi/contracts';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import {
  auditLogs,
  products,
  storeInventoryBags,
  storeInventoryLedgerEntries,
  storePartnerInboundBags,
  storePartnerInboundLines,
  storePartnerInbounds,
  stores,
  users,
} from './schema.js';
import {
  gramsToKilogramsExact,
  kilogramsToGramsExact,
  StoreOperationValidationError,
} from './store-operations.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

const MAX_PRODUCTS_PER_SLIP = 200;
const MAX_BAGS_PER_LINE = 2_000;
const MAX_NUMERIC_WEIGHT_GRAMS = 99_999_999_999_999n;

export interface PartnerInboundLineInput {
  readonly productId: string;
  readonly quantity: number;
  readonly bagWeightsKg: readonly string[];
}

export interface CreateStorePartnerInboundInput {
  readonly storeId: string;
  readonly partnerName: string;
  readonly note: string | null;
  readonly receivedAt: Date;
  readonly lines: readonly PartnerInboundLineInput[];
  readonly createdByUserId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface CreatedStorePartnerInbound {
  readonly partnerInboundId: string;
  readonly referenceCode: string;
  readonly inventoryBagIds: readonly string[];
}

export class StorePartnerInboundAuthorizationError extends Error {
  public readonly code = 'STORE_PARTNER_INBOUND_FORBIDDEN';

  public constructor(message = 'The account is not allowed to record this partner inbound.') {
    super(message);
    this.name = 'StorePartnerInboundAuthorizationError';
  }
}

export class StorePartnerInboundConflictError extends Error {
  public readonly code = 'STORE_PARTNER_INBOUND_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'StorePartnerInboundConflictError';
  }
}

export async function createStorePartnerInbound(
  database: Database,
  input: CreateStorePartnerInboundInput,
): Promise<IdempotencyResult<CreatedStorePartnerInbound>> {
  return withIdempotency(
    database,
    {
      scope: `store-partner-inbound.create:${input.storeId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    async (tx) => {
      const created = await createStorePartnerInboundInTransaction(tx, input);
      return {
        value: created,
        responseStatus: 201,
        responseBody: {
          partnerInboundId: created.partnerInboundId,
          referenceCode: created.referenceCode,
        },
        resourceType: 'store_partner_inbound',
        resourceId: created.partnerInboundId,
      };
    },
  );
}

export async function createStorePartnerInboundInTransaction(
  tx: Transaction,
  input: Omit<CreateStorePartnerInboundInput, 'idempotencyKey' | 'requestHash'>,
): Promise<CreatedStorePartnerInbound> {
  const partnerName = input.partnerName.trim();
  const note = input.note === null ? null : input.note.trim() || null;
  if (partnerName.length === 0 || partnerName.length > 200) {
    throw new StoreOperationValidationError('A partner inbound needs a partner name.');
  }
  if (note !== null && note.length > 1_000) {
    throw new StoreOperationValidationError('The partner inbound note is too long.');
  }
  if (input.lines.length === 0 || input.lines.length > MAX_PRODUCTS_PER_SLIP) {
    throw new StoreOperationValidationError(
      `A partner inbound must contain between 1 and ${MAX_PRODUCTS_PER_SLIP} products.`,
    );
  }

  const seenProducts = new Set<string>();
  let totalQuantity = 0;
  let totalGrams = 0n;
  for (const line of input.lines) {
    if (seenProducts.has(line.productId)) {
      throw new StoreOperationValidationError('A product may appear only once in a partner slip.');
    }
    seenProducts.add(line.productId);
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > MAX_BAGS_PER_LINE ||
      line.bagWeightsKg.length !== line.quantity
    ) {
      throw new StoreOperationValidationError(
        'Each partner line needs a positive quantity and one weight per unit.',
      );
    }
    totalQuantity += line.quantity;
    for (const weightKg of line.bagWeightsKg) {
      const grams = kilogramsToGramsExact(weightKg);
      if (grams <= 0n) {
        throw new StoreOperationValidationError('Partner bag weights must be positive.');
      }
      totalGrams += grams;
    }
  }
  if (totalGrams > MAX_NUMERIC_WEIGHT_GRAMS) {
    throw new StoreOperationValidationError('The partner inbound total weight is out of range.');
  }

  await assertStoreAccountMayRecord(tx, input.createdByUserId, input.storeId);
  await assertProductsExist(tx, [...seenProducts]);

  const referenceCode = await allocateReferenceCode(tx, input.receivedAt);

  return withAdvisoryLock(tx, 'store-partner-inbound', input.storeId, async () => {
    const [slip] = await tx
      .insert(storePartnerInbounds)
      .values({
        referenceCode,
        storeId: input.storeId,
        partnerName,
        note,
        totalQuantity,
        totalWeightKg: gramsToKilogramsExact(totalGrams),
        createdByUserId: input.createdByUserId,
        receivedAt: input.receivedAt,
      })
      .returning({ id: storePartnerInbounds.id });
    if (!slip) throw new Error('Partner inbound insert returned no row.');

    const inventoryBagIds: string[] = [];
    for (const line of input.lines) {
      const [persistedLine] = await tx
        .insert(storePartnerInboundLines)
        .values({
          storePartnerInboundId: slip.id,
          productId: line.productId,
          quantity: line.quantity,
        })
        .returning({ id: storePartnerInboundLines.id });
      if (!persistedLine) throw new Error('Partner inbound line insert returned no row.');

      for (const [index, weightKg] of line.bagWeightsKg.entries()) {
        const bagNumber = index + 1;
        const canonicalWeightKg = gramsToKilogramsExact(kilogramsToGramsExact(weightKg));
        const bagCode = `PIB-${slip.id}-${persistedLine.id}-${bagNumber}`;
        const [partnerBag] = await tx
          .insert(storePartnerInboundBags)
          .values({
            storePartnerInboundLineId: persistedLine.id,
            bagNumber,
            bagCode,
            weightKg: canonicalWeightKg,
          })
          .returning({ id: storePartnerInboundBags.id });
        if (!partnerBag) throw new Error('Partner inbound bag insert returned no row.');

        // Partner goods become ordinary store stock so the floor can open, sell and
        // transfer them exactly like warehouse stock. Cost stays zero: nothing here went
        // through a warehouse invoice, and inventing a price would corrupt cost reporting.
        const [inventoryBag] = await tx
          .insert(storeInventoryBags)
          .values({
            bagCode,
            storeId: input.storeId,
            productId: line.productId,
            sourcePartnerInboundBagId: partnerBag.id,
            status: 'available',
            initialWeightKg: canonicalWeightKg,
            currentWeightKg: canonicalWeightKg,
            costVnd: 0n,
            receivedAt: input.receivedAt,
          })
          .returning({ id: storeInventoryBags.id });
        if (!inventoryBag) throw new Error('Partner inventory bag insert returned no row.');
        inventoryBagIds.push(inventoryBag.id);

        await tx.insert(storeInventoryLedgerEntries).values({
          storeInventoryBagId: inventoryBag.id,
          storeId: input.storeId,
          productId: line.productId,
          eventType: 'receive',
          weightBeforeKg: '0.000',
          weightAfterKg: canonicalWeightKg,
          sourceType: 'store_partner_inbound_bag',
          sourceId: partnerBag.id,
          reason: 'Partner inbound received',
          actorUserId: input.createdByUserId,
          occurredAt: input.receivedAt,
        });
      }
    }

    await tx.insert(auditLogs).values({
      requestId: input.requestId,
      actorUserId: input.createdByUserId,
      action: 'STORE_PARTNER_INBOUND_RECORDED',
      entityType: 'store_partner_inbound',
      entityId: slip.id,
      before: null,
      after: {
        referenceCode,
        storeId: input.storeId,
        partnerName,
        totalQuantity,
        totalWeightKg: gramsToKilogramsExact(totalGrams),
      },
    });

    return { partnerInboundId: slip.id, referenceCode, inventoryBagIds };
  });
}

/**
 * Partner stock lands in the retail floor's inventory, so only an active account of that
 * active retail store may record it. Wholesale stores hold allocation stock rather than
 * floor stock, which is why their kind is refused here.
 */
async function assertStoreAccountMayRecord(
  tx: Transaction,
  userId: string,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id, kind: stores.kind })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true), isNull(stores.deletedAt)))
    .limit(1);
  if (!store || store.kind !== 'retail') {
    throw new StorePartnerInboundAuthorizationError('The store is inactive, deleted or wholesale.');
  }

  const [user] = await tx
    .select({ role: users.role, status: users.status, storeId: users.storeId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active') {
    throw new StorePartnerInboundAuthorizationError();
  }
  if (user.role === 'admin') return;
  if (user.role === 'store' && user.storeId === storeId) return;
  throw new StorePartnerInboundAuthorizationError();
}

async function assertProductsExist(tx: Transaction, productIds: readonly string[]): Promise<void> {
  for (const productId of productIds) {
    const [product] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)))
      .limit(1);
    if (!product) {
      throw new StoreOperationValidationError('A partner inbound product does not exist.');
    }
  }
}

/** Server-owned sequence, allocated after the idempotency gate. Gaps are allowed. */
async function allocateReferenceCode(tx: Transaction, now: Date): Promise<string> {
  for (;;) {
    const result = await tx.execute<{ value: string }>(
      sql`SELECT nextval('store_partner_inbound_number_seq')::text AS value`,
    );
    const candidate = formatPartnerInboundNumber(result.rows[0]!.value, now);
    const [existing] = await tx
      .select({ id: storePartnerInbounds.id })
      .from(storePartnerInbounds)
      .where(eq(storePartnerInbounds.referenceCode, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
}

export interface StorePartnerInboundLineRecord {
  readonly productId: string;
  readonly quantity: number;
  readonly bagWeightsKg: readonly string[];
}

export interface StorePartnerInboundRecord {
  readonly id: string;
  readonly referenceCode: string;
  readonly storeId: string;
  readonly partnerName: string;
  readonly note: string | null;
  readonly lines: readonly StorePartnerInboundLineRecord[];
  readonly totalQuantity: number;
  readonly totalWeightKg: string;
  readonly createdByUserId: string;
  readonly receivedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListStorePartnerInboundsInput {
  readonly storeIds?: readonly string[];
  readonly partner?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface StorePartnerInboundPage {
  readonly data: readonly StorePartnerInboundRecord[];
  readonly totalItems: number;
}

export async function listStorePartnerInbounds(
  database: Database,
  input: ListStorePartnerInboundsInput,
): Promise<StorePartnerInboundPage> {
  // An empty scope means the caller reaches no store at all, which is not the same as an
  // unscoped query; returning everything here would leak other stores' slips.
  if (input.storeIds !== undefined && input.storeIds.length === 0) {
    return { data: [], totalItems: 0 };
  }
  const conditions: SQL[] = [];
  if (input.storeIds !== undefined) {
    conditions.push(inArray(storePartnerInbounds.storeId, [...input.storeIds]));
  }
  if (input.partner !== undefined && input.partner.trim().length > 0) {
    conditions.push(ilike(storePartnerInbounds.partnerName, `%${input.partner.trim()}%`));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRow] = await database
    .select({ value: count() })
    .from(storePartnerInbounds)
    .where(where);
  const rows = await database
    .select({ id: storePartnerInbounds.id })
    .from(storePartnerInbounds)
    .where(where)
    .orderBy(desc(storePartnerInbounds.receivedAt), desc(storePartnerInbounds.id))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  const data: StorePartnerInboundRecord[] = [];
  for (const row of rows) {
    const record = await getStorePartnerInbound(database, row.id);
    if (record) data.push(record);
  }
  return { data, totalItems: Number(totalRow?.value ?? 0) };
}

export async function getStorePartnerInbound(
  database: Database,
  partnerInboundId: string,
): Promise<StorePartnerInboundRecord | null> {
  const [slip] = await database
    .select()
    .from(storePartnerInbounds)
    .where(eq(storePartnerInbounds.id, partnerInboundId))
    .limit(1);
  if (!slip) return null;

  const lineRows = await database
    .select({
      id: storePartnerInboundLines.id,
      productId: storePartnerInboundLines.productId,
      quantity: storePartnerInboundLines.quantity,
    })
    .from(storePartnerInboundLines)
    .where(eq(storePartnerInboundLines.storePartnerInboundId, slip.id))
    .orderBy(asc(storePartnerInboundLines.createdAt), asc(storePartnerInboundLines.id));

  const lines: StorePartnerInboundLineRecord[] = [];
  for (const line of lineRows) {
    const bagRows = await database
      .select({ weightKg: storePartnerInboundBags.weightKg })
      .from(storePartnerInboundBags)
      .where(eq(storePartnerInboundBags.storePartnerInboundLineId, line.id))
      .orderBy(asc(storePartnerInboundBags.bagNumber));
    lines.push({
      productId: line.productId,
      quantity: line.quantity,
      bagWeightsKg: bagRows.map((bag) => bag.weightKg),
    });
  }

  return {
    id: slip.id,
    referenceCode: slip.referenceCode,
    storeId: slip.storeId,
    partnerName: slip.partnerName,
    note: slip.note,
    lines,
    totalQuantity: slip.totalQuantity,
    totalWeightKg: slip.totalWeightKg,
    createdByUserId: slip.createdByUserId,
    receivedAt: slip.receivedAt,
    createdAt: slip.createdAt,
    updatedAt: slip.updatedAt,
  };
}

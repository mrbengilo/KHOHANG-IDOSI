import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type {
  CreatePartnerReceiptRequest,
  ListPartnerReceiptsQuery,
  PartnerReceipt,
  PartnerReceiptStatus,
} from '@idosi/contracts';

import type { Database } from './client.js';
import {
  partnerReceiptLines,
  partnerReceipts,
  products,
  stores,
  users,
  type JsonObject,
} from './schema.js';
import type { Transaction } from './transaction.js';

export interface CreatePartnerReceiptInput {
  readonly storeId: string;
  readonly partnerName: string;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: number;
  }[];
  readonly createdByUserId: string;
}

export interface CreatedPartnerReceipt {
  readonly receiptId: string;
  readonly receiptNumber: string;
  readonly totalQuantity: number;
}

export interface ListPartnerReceiptsInput {
  readonly storeId?: string;
  readonly status?: PartnerReceiptStatus;
  readonly partnerName?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface PartnerReceiptsPage {
  readonly data: readonly PartnerReceipt[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

class PartnerReceiptError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PartnerReceiptError';
  }
}

export class PartnerReceiptNotFoundError extends PartnerReceiptError {
  constructor() {
    super('Không tìm thấy phiếu nhập đối tác', 'PARTNER_RECEIPT_NOT_FOUND');
  }
}

export class PartnerReceiptStoreNotFoundError extends PartnerReceiptError {
  constructor() {
    super('Không tìm thấy cửa hàng', 'STORE_NOT_FOUND');
  }
}

export class PartnerReceiptProductNotFoundError extends PartnerReceiptError {
  constructor(productId: string) {
    super(`Không tìm thấy sản phẩm: ${productId}`, 'PRODUCT_NOT_FOUND');
  }
}

export class PartnerReceiptDuplicateNumberError extends PartnerReceiptError {
  constructor() {
    super('Số phiếu nhập đã tồn tại', 'DUPLICATE_RECEIPT_NUMBER');
  }
}

/**
 * Generate unique receipt number for partner receipts
 */
function generatePartnerReceiptNumber(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `PN-${dateStr}-${timeStr}-${randomStr}`;
}

/**
 * Create a new partner receipt
 */
export async function createDatabasePartnerReceipt(
  db: Database,
  input: CreatePartnerReceiptInput,
): Promise<CreatedPartnerReceipt> {
  return db.transaction(async (tx) => {
    // Verify store exists and is active
    const [store] = await tx
      .select({ id: stores.id, status: stores.status })
      .from(stores)
      .where(and(eq(stores.id, input.storeId), isNull(stores.deletedAt)))
      .limit(1);

    if (!store || store.status !== 'active') {
      throw new PartnerReceiptStoreNotFoundError();
    }

    // Verify all products exist and are active
    const productIds = input.lines.map((line) => line.productId);
    const foundProducts = await tx
      .select({ id: products.id, status: products.status })
      .from(products)
      .where(and(inArray(products.id, productIds), eq(products.status, 'active')));

    if (foundProducts.length !== productIds.length) {
      const foundIds = new Set(foundProducts.map((p) => p.id));
      const missingId = productIds.find((id) => !foundIds.has(id));
      throw new PartnerReceiptProductNotFoundError(missingId || 'unknown');
    }

    // Generate unique receipt number
    let receiptNumber: string;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      receiptNumber = generatePartnerReceiptNumber();
      const [existing] = await tx
        .select({ id: partnerReceipts.id })
        .from(partnerReceipts)
        .where(eq(partnerReceipts.receiptNumber, receiptNumber))
        .limit(1);

      if (!existing) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new PartnerReceiptDuplicateNumberError();
    }

    const totalQuantity = input.lines.reduce((sum, line) => sum + line.quantity, 0);

    // Create receipt
    const [receipt] = await tx
      .insert(partnerReceipts)
      .values({
        receiptNumber: receiptNumber!,
        storeId: input.storeId,
        partnerName: input.partnerName,
        notes: input.notes,
        totalQuantity,
        status: 'draft',
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: partnerReceipts.id, receiptNumber: partnerReceipts.receiptNumber });

    // Create receipt lines
    await tx.insert(partnerReceiptLines).values(
      input.lines.map((line) => ({
        partnerReceiptId: receipt.id,
        productId: line.productId,
        quantity: line.quantity,
      })),
    );

    return {
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      totalQuantity,
    };
  });
}

/**
 * List partner receipts with pagination and filters
 */
export async function listDatabasePartnerReceipts(
  db: Database,
  input: ListPartnerReceiptsInput,
): Promise<PartnerReceiptsPage> {
  const conditions = [isNull(partnerReceipts.deletedAt)];

  if (input.storeId) {
    conditions.push(eq(partnerReceipts.storeId, input.storeId));
  }

  if (input.status) {
    conditions.push(eq(partnerReceipts.status, input.status.toLowerCase() as any));
  }

  if (input.partnerName) {
    conditions.push(ilike(partnerReceipts.partnerName, `%${input.partnerName}%`));
  }

  const where = and(...conditions);

  // Count total items
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(partnerReceipts)
    .where(where);

  const totalItems = countResult?.count ?? 0;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize);

  if (totalItems === 0) {
    return {
      data: [],
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems: 0,
        totalPages: 0,
      },
    };
  }

  // Fetch receipts
  const receipts = await db
    .select({
      id: partnerReceipts.id,
      receiptNumber: partnerReceipts.receiptNumber,
      storeId: partnerReceipts.storeId,
      storeName: stores.name,
      partnerName: partnerReceipts.partnerName,
      status: partnerReceipts.status,
      notes: partnerReceipts.notes,
      totalQuantity: partnerReceipts.totalQuantity,
      version: partnerReceipts.version,
      createdByUserId: partnerReceipts.createdByUserId,
      createdByName: sql<string | null>`${users.displayName}`,
      confirmedByUserId: partnerReceipts.confirmedByUserId,
      confirmedByName: sql<string | null>`confirmed_user.display_name`,
      confirmedAt: partnerReceipts.confirmedAt,
      createdAt: partnerReceipts.createdAt,
      updatedAt: partnerReceipts.updatedAt,
    })
    .from(partnerReceipts)
    .leftJoin(stores, eq(partnerReceipts.storeId, stores.id))
    .leftJoin(users, eq(partnerReceipts.createdByUserId, users.id))
    .leftJoin(sql`users AS confirmed_user`, sql`${partnerReceipts.confirmedByUserId} = confirmed_user.id`)
    .where(where)
    .orderBy(desc(partnerReceipts.createdAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  // Fetch lines for all receipts
  const receiptIds = receipts.map((r) => r.id);
  const lines = receiptIds.length
    ? await db
        .select({
          id: partnerReceiptLines.id,
          partnerReceiptId: partnerReceiptLines.partnerReceiptId,
          productId: partnerReceiptLines.productId,
          productName: products.name,
          quantity: partnerReceiptLines.quantity,
          createdAt: partnerReceiptLines.createdAt,
        })
        .from(partnerReceiptLines)
        .leftJoin(products, eq(partnerReceiptLines.productId, products.id))
        .where(inArray(partnerReceiptLines.partnerReceiptId, receiptIds))
    : [];

  const linesByReceiptId = new Map<string, typeof lines>();
  for (const line of lines) {
    if (!linesByReceiptId.has(line.partnerReceiptId)) {
      linesByReceiptId.set(line.partnerReceiptId, []);
    }
    linesByReceiptId.get(line.partnerReceiptId)!.push(line);
  }

  const data: PartnerReceipt[] = receipts.map((receipt) => ({
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    storeId: receipt.storeId,
    storeName: receipt.storeName ?? 'Unknown',
    partnerName: receipt.partnerName,
    status: receipt.status.toUpperCase() as PartnerReceiptStatus,
    notes: receipt.notes,
    totalQuantity: receipt.totalQuantity,
    version: receipt.version,
    createdByAccountId: receipt.createdByUserId,
    createdByName: receipt.createdByName,
    confirmedByAccountId: receipt.confirmedByUserId,
    confirmedByName: receipt.confirmedByName,
    confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
    lines: (linesByReceiptId.get(receipt.id) ?? []).map((line) => ({
      id: line.id,
      partnerReceiptId: line.partnerReceiptId,
      productId: line.productId,
      productName: line.productName ?? 'Unknown',
      quantity: line.quantity,
      createdAt: line.createdAt.toISOString(),
    })),
  }));

  return {
    data,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalItems,
      totalPages,
    },
  };
}

/**
 * Get a single partner receipt by ID
 */
export async function getDatabasePartnerReceipt(
  db: Database,
  receiptId: string,
): Promise<PartnerReceipt> {
  const [receipt] = await db
    .select({
      id: partnerReceipts.id,
      receiptNumber: partnerReceipts.receiptNumber,
      storeId: partnerReceipts.storeId,
      storeName: stores.name,
      partnerName: partnerReceipts.partnerName,
      status: partnerReceipts.status,
      notes: partnerReceipts.notes,
      totalQuantity: partnerReceipts.totalQuantity,
      version: partnerReceipts.version,
      createdByUserId: partnerReceipts.createdByUserId,
      createdByName: sql<string | null>`${users.displayName}`,
      confirmedByUserId: partnerReceipts.confirmedByUserId,
      confirmedByName: sql<string | null>`confirmed_user.display_name`,
      confirmedAt: partnerReceipts.confirmedAt,
      createdAt: partnerReceipts.createdAt,
      updatedAt: partnerReceipts.updatedAt,
    })
    .from(partnerReceipts)
    .leftJoin(stores, eq(partnerReceipts.storeId, stores.id))
    .leftJoin(users, eq(partnerReceipts.createdByUserId, users.id))
    .leftJoin(sql`users AS confirmed_user`, sql`${partnerReceipts.confirmedByUserId} = confirmed_user.id`)
    .where(and(eq(partnerReceipts.id, receiptId), isNull(partnerReceipts.deletedAt)))
    .limit(1);

  if (!receipt) {
    throw new PartnerReceiptNotFoundError();
  }

  const lines = await db
    .select({
      id: partnerReceiptLines.id,
      partnerReceiptId: partnerReceiptLines.partnerReceiptId,
      productId: partnerReceiptLines.productId,
      productName: products.name,
      quantity: partnerReceiptLines.quantity,
      createdAt: partnerReceiptLines.createdAt,
    })
    .from(partnerReceiptLines)
    .leftJoin(products, eq(partnerReceiptLines.productId, products.id))
    .where(eq(partnerReceiptLines.partnerReceiptId, receiptId));

  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    storeId: receipt.storeId,
    storeName: receipt.storeName ?? 'Unknown',
    partnerName: receipt.partnerName,
    status: receipt.status.toUpperCase() as PartnerReceiptStatus,
    notes: receipt.notes,
    totalQuantity: receipt.totalQuantity,
    version: receipt.version,
    createdByAccountId: receipt.createdByUserId,
    createdByName: receipt.createdByName,
    confirmedByAccountId: receipt.confirmedByUserId,
    confirmedByName: receipt.confirmedByName,
    confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      partnerReceiptId: line.partnerReceiptId,
      productId: line.productId,
      productName: line.productName ?? 'Unknown',
      quantity: line.quantity,
      createdAt: line.createdAt.toISOString(),
    })),
  };
}

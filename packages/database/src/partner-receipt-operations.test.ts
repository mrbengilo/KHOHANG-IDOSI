import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreatePartnerReceiptRequestSchema, PartnerReceiptSchema } from '@idosi/contracts';
import { createDatabase, type DatabaseClient } from './client.js';
import {
  createDatabasePartnerReceipt,
  getDatabasePartnerReceipt,
  listDatabasePartnerReceipts,
  PartnerReceiptNotFoundError,
  PartnerReceiptProductNotFoundError,
  PartnerReceiptStoreNotFoundError,
} from './partner-receipt-operations.js';

const enabled = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);

describe.runIf(enabled)('partner receipt PostgreSQL regression coverage', () => {
  let client: DatabaseClient;
  const groupId = randomUUID();
  const storeId = randomUUID();
  const otherStoreId = randomUUID();
  const userId = randomUUID();
  const wholesaleUserId = randomUUID();
  const productId = randomUUID();
  const secondProductId = randomUUID();
  const suffix = randomUUID();

  beforeAll(async () => {
    client = createDatabase({ connectionString: process.env.DATABASE_URL });
    await client.pool.query('INSERT INTO store_groups(id, code, name) VALUES ($1, $2, $3)', [
      groupId,
      `partner-group-${suffix}`,
      'Partner regression group',
    ]);
    await client.pool.query(
      'INSERT INTO stores(id, group_id, code, name) VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)',
      [storeId, groupId, `partner-a-${suffix}`, 'Store A', otherStoreId, `partner-b-${suffix}`, 'Store B'],
    );
    await client.pool.query(
      'INSERT INTO users(id, store_id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, storeId, `partner-${suffix}`, 'test-only-nonlogin-password-hash', 'Store user', 'store'],
    );
    await client.pool.query(
      'INSERT INTO products(id, sku, slug, name) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [
        productId,
        `partner-one-${suffix}`,
        `partner-one-${suffix}`,
        'First product',
        secondProductId,
        `partner-two-${suffix}`,
        `partner-two-${suffix}`,
        'Second product',
      ],
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.pool.query(
        'DELETE FROM partner_receipt_lines WHERE partner_receipt_id IN (SELECT id FROM partner_receipts WHERE store_id IN ($1, $2))',
        [storeId, otherStoreId],
      );
      await client.pool.query('DELETE FROM partner_receipts WHERE store_id IN ($1, $2)', [
        storeId,
        otherStoreId,
      ]);
      await client.pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userId, wholesaleUserId]);
      await client.pool.query('DELETE FROM products WHERE id IN ($1, $2)', [productId, secondProductId]);
      await client.pool.query('DELETE FROM stores WHERE id IN ($1, $2)', [storeId, otherStoreId]);
      await client.pool.query('DELETE FROM store_groups WHERE id = $1', [groupId]);
    } finally {
      await client.close();
    }
  });

  it('registers the wholesale enum and permits a global wholesale account', async () => {
    await client.pool.query(
      'INSERT INTO users(id, email, password_hash, display_name, role) VALUES ($1, $2, $3, $4, $5)',
      [
        wholesaleUserId,
        `wholesale-${suffix}`,
        'test-only-nonlogin-password-hash',
        'Wholesale user',
        'wholesale_account',
      ],
    );
    const result = await client.pool.query('SELECT store_id, role FROM users WHERE id = $1', [
      wholesaleUserId,
    ]);
    expect(result.rows).toEqual([{ store_id: null, role: 'wholesale_account' }]);
  });

  it('persists a draft, its product lines, and a response matching the API contract', async () => {
    const created = await createDatabasePartnerReceipt(client.db, {
      storeId,
      partnerName: 'Regression partner',
      notes: 'Isolated test record',
      createdByUserId: userId,
      lines: [
        { productId, quantity: 3 },
        { productId: secondProductId, quantity: 4 },
      ],
    });
    const receipt = PartnerReceiptSchema.parse(
      await getDatabasePartnerReceipt(client.db, created.receiptId),
    );
    expect(receipt.status).toBe('DRAFT');
    expect(receipt.totalQuantity).toBe(7);
    expect(receipt.lines).toHaveLength(2);
    expect(receipt.lines.map((line) => line.productName).sort()).toEqual([
      'First product',
      'Second product',
    ]);
    expect(receipt.createdByAccountId).toBe(userId);
    expect(receipt.confirmedByName).toBeNull();
    const page = await listDatabasePartnerReceipts(client.db, {
      storeId,
      partnerName: 'Regression partner',
      status: 'DRAFT',
      page: 1,
      pageSize: 10,
    });
    expect(page.data.map((item) => item.id)).toContain(created.receiptId);
    expect(page.pagination.totalItems).toBe(1);
    const otherPage = await listDatabasePartnerReceipts(client.db, {
      storeId: otherStoreId,
      page: 1,
      pageSize: 10,
    });
    expect(otherPage.data).toEqual([]);
  });

  it('rejects an unknown product without leaving a partial receipt', async () => {
    const missingId = randomUUID();
    await expect(
      createDatabasePartnerReceipt(client.db, {
        storeId,
        partnerName: 'Must roll back',
        notes: null,
        createdByUserId: userId,
        lines: [{ productId: missingId, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(PartnerReceiptProductNotFoundError);
    const result = await client.pool.query(
      'SELECT count(*)::int AS total FROM partner_receipts WHERE store_id = $1 AND partner_name = $2',
      [storeId, 'Must roll back'],
    );
    expect(result.rows[0]?.total).toBe(0);
  });

  it('rejects an unknown store and unknown receipt', async () => {
    await expect(
      createDatabasePartnerReceipt(client.db, {
        storeId: randomUUID(),
        partnerName: 'Unknown store',
        notes: null,
        createdByUserId: userId,
        lines: [{ productId, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(PartnerReceiptStoreNotFoundError);
    await expect(getDatabasePartnerReceipt(client.db, randomUUID())).rejects.toBeInstanceOf(
      PartnerReceiptNotFoundError,
    );
  });

  it('rejects duplicate product lines at the API input boundary', () => {
    const result = CreatePartnerReceiptRequestSchema.safeParse({
      storeId,
      partnerName: 'Duplicate lines',
      lines: [
        { productId, quantity: 1 },
        { productId, quantity: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

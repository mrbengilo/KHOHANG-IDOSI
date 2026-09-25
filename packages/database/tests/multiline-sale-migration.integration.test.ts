import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import {
  createDatabase,
  createStorePartnerInbound,
  createStoreSorting,
  listSortedSaleTransfers,
  receiveSortedSaleTransfer,
} from '../src/index.js';

const pg = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;
pg(
  'upgrades a legacy Sale document without changing identity or inventing bag weights',
  async () => {
    const admin = createDatabase({ connectionString: process.env.DATABASE_URL });
    const name = 'upgrade_' + randomUUID().replaceAll('-', '');
    const folder = await mkdtemp(join(tmpdir(), 'idosi-upgrade-'));
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + name;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const legacy = createDatabase({ connectionString: url.toString() });
    try {
      const migrations = resolve('migrations');
      await cp(migrations, folder, { recursive: true });
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 30);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(legacy.db, { migrationsFolder: folder });
      const group = (
        await legacy.pool.query(
          "INSERT INTO store_groups(code,name) VALUES ('UPGRADE','Upgrade') RETURNING id",
        )
      ).rows[0].id;
      const store = async (code: string) =>
        (
          await legacy.pool.query(
            'INSERT INTO stores(group_id,code,name) VALUES ($1,$2,$2) RETURNING id',
            [group, code],
          )
        ).rows[0].id;
      const source = await store('SRC');
      const destination = await store('DST');
      const actor = async (storeId: string) =>
        (
          await legacy.pool.query(
            "INSERT INTO users(email,display_name,role,status,store_id,password_hash) VALUES ($1,'Legacy operator','store','active',$2,'fixture-only-password-hash-long-enough') RETURNING id",
            [storeId + '@example.invalid', storeId],
          )
        ).rows[0].id;
      const sender = await actor(source);
      const receiver = await actor(destination);
      const product = (
        await legacy.pool.query(
          "INSERT INTO products(sku,slug,name,unit) VALUES ('LEGACY','legacy','Legacy product','bag') RETURNING id",
        )
      ).rows[0].id;
      await createStorePartnerInbound(legacy.db, {
        storeId: source,
        requestId: randomUUID(),
        partnerName: 'Legacy supplier',
        note: null,
        receivedAt: new Date(),
        lines: [{ productId: product, quantity: 1, bagWeightsKg: ['200.000'] }],
        createdByUserId: sender,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      const bag = (
        await legacy.pool.query('SELECT id,version FROM store_inventory_bags WHERE store_id=$1', [
          source,
        ])
      ).rows[0];
      await createStoreSorting(legacy.db, {
        storeId: source,
        inventoryBagId: bag.id,
        expectedInventoryVersion: bag.version,
        reason: 'SALE',
        weightKg: '200.000',
        actorUserId: sender,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      const stock = (
        await legacy.pool.query(
          'UPDATE store_sorted_stocks SET sale_weight_kg=149.999,transferred_out_weight_kg=50.001 WHERE store_id=$1 RETURNING id',
          [source],
        )
      ).rows[0].id;
      const original = (
        await legacy.pool.query(
          "INSERT INTO sorted_sale_transfers(transfer_number,source_stock_id,source_store_id,destination_store_id,product_id,bag_quantity,weight_kg,created_by_user_id) VALUES ('',$1,$2,$3,$4,2,50.001,$5) RETURNING *",
          [stock, source, destination, product, sender],
        )
      ).rows[0];
      await migrate(legacy.db, { migrationsFolder: migrations });
      await migrate(legacy.db, { migrationsFolder: migrations });
      const [upgraded] = await listSortedSaleTransfers(legacy.db, [source]);
      expect(upgraded).toMatchObject({
        id: original.id,
        transferNumber: original.transfer_number,
        weightKg: '50.001',
        bagQuantity: 2,
        lines: null,
        bagWeightsKg: null,
        enteredWeightKg: null,
      });
      await receiveSortedSaleTransfer(legacy.db, {
        transferId: original.id,
        expectedVersion: 0,
        actorUserId: receiver,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      const credit = await legacy.pool.query(
        'SELECT product_id, sale_credited_weight_kg FROM store_sorted_stocks WHERE source_transfer_id=$1',
        [original.id],
      );
      expect(credit.rows).toEqual([{ product_id: product, sale_credited_weight_kg: '50.001' }]);
    } finally {
      await legacy.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
  60_000,
);

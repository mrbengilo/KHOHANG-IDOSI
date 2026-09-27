import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDatabase } from '../src/index.js';

const pg = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;
pg(
  '0034 preserves manual and NULL historical VAT while expanding constraints and snapshot provenance',
  async () => {
    const database = createDatabase({ connectionString: process.env.DATABASE_URL });
    const client = await database.pool.connect();
    const schema = `vat_upgrade_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`CREATE TABLE operational_settings_versions(version integer UNIQUE NOT NULL);
      INSERT INTO operational_settings_versions VALUES (1);
      CREATE TABLE store_receipts(id integer PRIMARY KEY, vat_amount_vnd bigint, vat_rate_percent integer,
        CONSTRAINT store_receipts_vat_valid CHECK ((vat_amount_vnd IS NULL AND vat_rate_percent IS NULL) OR
        (vat_amount_vnd IS NOT NULL AND vat_rate_percent=8 AND vat_amount_vnd BETWEEN 0 AND 9007199254740991)));
      INSERT INTO store_receipts VALUES (1,500000,8),(2,NULL,NULL);`);
      const before = (await client.query('SELECT * FROM store_receipts ORDER BY id')).rows;
      await client.query(
        await readFile(
          new URL('../migrations/0034_configurable_receipt_vat.sql', import.meta.url),
          'utf8',
        ),
      );
      expect((await client.query('SELECT * FROM store_receipts ORDER BY id')).rows).toEqual(
        before.map((row) => ({ ...row, vat_settings_version: null })),
      );
      expect(
        (await client.query('SELECT vat_rate_percent FROM operational_settings_versions')).rows,
      ).toEqual([{ vat_rate_percent: 8 }]);
      await client.query('INSERT INTO operational_settings_versions VALUES (2,10)');
      await client.query('INSERT INTO store_receipts VALUES (3,530000,10,2),(4,0,0,2)');
      for (const statement of [
        'INSERT INTO operational_settings_versions VALUES (3,-1)',
        'INSERT INTO operational_settings_versions VALUES (3,101)',
        "INSERT INTO operational_settings_versions VALUES (3,'8.5')",
        'INSERT INTO store_receipts VALUES (5,1,101,2)',
        'INSERT INTO store_receipts VALUES (5,-1,10,2)',
        'INSERT INTO store_receipts VALUES (5,1,10,999)',
      ]) {
        await client.query('SAVEPOINT invalid_vat');
        await expect(client.query(statement)).rejects.toThrow();
        await client.query('ROLLBACK TO SAVEPOINT invalid_vat');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await database.close();
    }
  },
);

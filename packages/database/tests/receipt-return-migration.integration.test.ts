import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createDatabase } from '../src/index.js';

const pg = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;

pg(
  '0031 preserves legacy return states and requires truthful automatic completion provenance',
  async () => {
    const database = createDatabase({ connectionString: process.env.DATABASE_URL });
    const client = await database.pool.connect();
    const schema = `return_upgrade_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      // Isolate the exact old return constraints; full-schema upgrades also run in the
      // multiline migration suite and CI's fresh/repeated migration commands.
      await client.query(`CREATE TABLE users (id uuid PRIMARY KEY);
      INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000001');
      CREATE TABLE store_receipt_returns (
        id integer PRIMARY KEY, status text, quantity integer DEFAULT 1,
        handed_over_by_user_id uuid, handed_over_at timestamptz,
        received_by_user_id uuid, received_at timestamptz, received_quantity integer,
        store_id uuid,
        CONSTRAINT store_receipt_returns_handover_state CHECK (
          status IN ('pending_handover', 'cancelled') OR (handed_over_by_user_id IS NOT NULL AND handed_over_at IS NOT NULL)),
        CONSTRAINT store_receipt_returns_receive_state CHECK (
          status IN ('pending_handover', 'in_transit', 'cancelled') OR (received_by_user_id IS NOT NULL AND received_at IS NOT NULL AND received_quantity IS NOT NULL))
      );
      INSERT INTO store_receipt_returns(id,status) VALUES (1,'pending_handover');
      INSERT INTO store_receipt_returns VALUES (2,'in_transit',1,'00000000-0000-4000-8000-000000000001',now(),NULL,NULL,NULL);
      INSERT INTO store_receipt_returns VALUES (3,'received',1,'00000000-0000-4000-8000-000000000001',now(),'00000000-0000-4000-8000-000000000001',now(),1);
      INSERT INTO store_receipt_returns VALUES (4,'disputed',1,'00000000-0000-4000-8000-000000000001',now(),'00000000-0000-4000-8000-000000000001',now(),0);`);
      const before = (await client.query('SELECT * FROM store_receipt_returns ORDER BY id')).rows;
      const migration = await readFile(
        new URL('../migrations/0031_receipt_immediate_returns.sql', import.meta.url),
        'utf8',
      );
      await client.query(migration);
      const index = await client.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='store_receipt_returns_effective_store_idx'",
        [schema],
      );
      expect(index.rows[0]?.indexdef).toContain(
        'COALESCE(auto_completed_at, handed_over_at), store_id',
      );
      // A tiny fixture normally favors a sequential scan; force alternatives only to prove
      // this exact report predicate can use the expression index, not to claim a benchmark.
      await client.query('SET LOCAL enable_seqscan=off');
      const plan = await client.query(`EXPLAIN SELECT * FROM store_receipt_returns
      WHERE coalesce(auto_completed_at, handed_over_at) >= now() - interval '1 day'
      AND coalesce(auto_completed_at, handed_over_at) < now() + interval '1 day'`);
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'store_receipt_returns_effective_store_idx',
      );
      const after = (await client.query('SELECT * FROM store_receipt_returns ORDER BY id')).rows;
      expect(after).toEqual(
        before.map((row) => ({ ...row, auto_completed_at: null, auto_completed_by_user_id: null })),
      );
      await client.query(`INSERT INTO store_receipt_returns(id,status,received_quantity,auto_completed_at,auto_completed_by_user_id)
      VALUES (5,'received',1,now(),'00000000-0000-4000-8000-000000000001')`);
      for (const change of [
        'received_quantity=NULL',
        'auto_completed_by_user_id=NULL',
        "status='pending_handover'",
        'handed_over_at=now()',
      ]) {
        await client.query('SAVEPOINT invalid_completion');
        await expect(
          client.query(`UPDATE store_receipt_returns SET ${change} WHERE id=5`),
        ).rejects.toThrow();
        await client.query('ROLLBACK TO SAVEPOINT invalid_completion');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await database.close();
    }
  },
);

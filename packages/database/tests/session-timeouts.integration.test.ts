import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  apiSessionTimeouts,
  closeDatabase,
  createDatabase,
  pool,
  workerSessionTimeouts,
} from '../src/client.js';
import { withSerializableTransaction } from '../src/transaction.js';

const pg = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

async function setting(query: (text: string) => Promise<{ rows: unknown[] }>, name: string) {
  const result = await query(`SELECT current_setting('${name}') AS value`);
  return (result.rows[0] as { value: string }).value;
}

pg('PostgreSQL session timeouts', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('every API pool session is bounded below the browser read deadline', async () => {
    expect(await setting((text) => pool.query(text), 'lock_timeout')).toBe('30s');
    expect(await setting((text) => pool.query(text), 'statement_timeout')).toBe('50s');
    expect(await setting((text) => pool.query(text), 'idle_in_transaction_session_timeout')).toBe(
      '1min',
    );
    expect(apiSessionTimeouts.lock_timeout).toBeLessThan(apiSessionTimeouts.statement_timeout);
    // apps/web/src/lib/http-request.ts gives up on a read after 60 s.
    expect(apiSessionTimeouts.statement_timeout).toBeLessThan(60_000);
  });

  it('worker sessions get their own, longer bounds', async () => {
    const database = createDatabase({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      ...workerSessionTimeouts,
    });
    try {
      const query = (text: string) => database.pool.query(text);
      expect(await setting(query, 'lock_timeout')).toBe('1min');
      expect(await setting(query, 'statement_timeout')).toBe('5min');
      expect(await setting(query, 'idle_in_transaction_session_timeout')).toBe('5min');
    } finally {
      await database.close();
    }
  });

  it('a lock wait ends with 55P03 and rolls back instead of holding the connection', async () => {
    const table = `audit_session_lock_${randomUUID().replaceAll('-', '')}`;
    const relation = sql.identifier(table);
    const database = createDatabase({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      lock_timeout: 200,
    });
    const holder = await database.pool.connect();
    try {
      await database.db.execute(sql`CREATE TABLE ${relation} (id integer PRIMARY KEY, v integer)`);
      await database.db.execute(sql`INSERT INTO ${relation} VALUES (1, 0)`);
      await holder.query('BEGIN');
      await holder.query(`UPDATE "${table}" SET v = 10 WHERE id = 1`);

      const started = Date.now();
      await expect(
        withSerializableTransaction(database.db, async (tx) => {
          await tx.execute(sql`UPDATE ${relation} SET v = 99 WHERE id = 1`);
        }),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
      expect(Date.now() - started).toBeLessThan(5_000);

      await holder.query('ROLLBACK');
      const rows = await database.db.execute(sql`SELECT v FROM ${relation}`);
      expect(rows.rows).toEqual([{ v: 0 }]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await database.db.execute(sql`DROP TABLE IF EXISTS ${relation}`);
      await database.close();
    }
  });

  it('an abandoned open transaction is terminated, releasing its locks', async () => {
    const table = `audit_session_idle_${randomUUID().replaceAll('-', '')}`;
    const relation = sql.identifier(table);
    const database = createDatabase({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idle_in_transaction_session_timeout: 300,
    });
    const abandoned = await database.pool.connect();
    // pg emits the server-side termination on the idle client; the pool must not crash.
    abandoned.on('error', () => undefined);
    try {
      await database.db.execute(sql`CREATE TABLE ${relation} (id integer PRIMARY KEY, v integer)`);
      await database.db.execute(sql`INSERT INTO ${relation} VALUES (1, 0)`);
      await abandoned.query('BEGIN');
      await abandoned.query(`UPDATE "${table}" SET v = 10 WHERE id = 1`);

      // Without the timeout this update would wait forever behind the abandoned row lock.
      const started = Date.now();
      await database.db.execute(sql`UPDATE ${relation} SET v = v + 1 WHERE id = 1`);
      expect(Date.now() - started).toBeLessThan(5_000);
      const rows = await database.db.execute(sql`SELECT v FROM ${relation}`);
      expect(rows.rows).toEqual([{ v: 1 }]);
      await expect(abandoned.query('SELECT 1')).rejects.toThrow();
    } finally {
      abandoned.release(true);
      await database.db.execute(sql`DROP TABLE IF EXISTS ${relation}`);
      await database.close();
    }
  });
});

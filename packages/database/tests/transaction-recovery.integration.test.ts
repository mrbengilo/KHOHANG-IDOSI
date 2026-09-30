import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDatabase } from '../src/client.js';
import { withSerializableTransaction } from '../src/transaction.js';

const pg = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;

pg(
  'real deadlock retries roll back the losing attempt and commit each operation once',
  async () => {
    const database = createDatabase({ connectionString: process.env.DATABASE_URL, max: 4 });
    const table = `audit_deadlock_${randomUUID().replaceAll('-', '')}`;
    const relation = sql.identifier(table);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = [0, 0];
    try {
      await database.db.execute(
        sql`CREATE TABLE ${relation} (id integer PRIMARY KEY, value integer NOT NULL)`,
      );
      await database.db.execute(sql`INSERT INTO ${relation} VALUES (1, 0), (2, 0)`);
      await Promise.all(
        [0, 1].map((index) =>
          withSerializableTransaction(database.db, async (tx) => {
            attempts[index] = (attempts[index] ?? 0) + 1;
            await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
            await tx.execute(sql`UPDATE ${relation} SET value = value + 1 WHERE id = ${index + 1}`);
            // Both first attempts own different row locks before either asks for the other.
            if (attempts[index] === 1) {
              if (++arrived === 2) release();
              await barrier;
            }
            await tx.execute(sql`UPDATE ${relation} SET value = value + 1 WHERE id = ${2 - index}`);
          }),
        ),
      );
      expect(attempts.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(2);
      const result = await database.db.execute(sql`SELECT value FROM ${relation} ORDER BY id`);
      expect(result.rows).toEqual([{ value: 2 }, { value: 2 }]);
    } finally {
      release();
      await database.db.execute(sql`DROP TABLE IF EXISTS ${relation}`);
      await database.close();
    }
  },
  15_000,
);

pg('a bounded pool rejects saturation then recovers after the connection is released', async () => {
  const database = createDatabase({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 150,
  });
  const held = await database.pool.connect();
  try {
    await expect(database.pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    expect(database.pool.waitingCount).toBe(0);
  } finally {
    held.release();
  }
  try {
    expect((await database.pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
    expect(database.pool.idleCount).toBe(1);
  } finally {
    await database.close();
  }
});

pg('lock timeout rolls back the blocked write and a later transaction can proceed', async () => {
  const database = createDatabase({ connectionString: process.env.DATABASE_URL, max: 3 });
  const table = `audit_lock_${randomUUID().replaceAll('-', '')}`;
  const relation = sql.identifier(table);
  const held = await database.pool.connect();
  try {
    await database.db.execute(
      sql`CREATE TABLE ${relation} (id integer PRIMARY KEY, value integer NOT NULL)`,
    );
    await database.db.execute(sql`INSERT INTO ${relation} VALUES (1, 0)`);
    await held.query('BEGIN');
    await held.query(`UPDATE "${table}" SET value = 10 WHERE id = 1`);
    await expect(
      withSerializableTransaction(database.db, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '150ms'`);
        await tx.execute(sql`UPDATE ${relation} SET value = 99 WHERE id = 1`);
      }),
    ).rejects.toMatchObject({ cause: { code: '55P03' } });
    await held.query('ROLLBACK');
    await withSerializableTransaction(database.db, async (tx) => {
      await tx.execute(sql`UPDATE ${relation} SET value = value + 1 WHERE id = 1`);
    });
    expect((await database.db.execute(sql`SELECT value FROM ${relation}`)).rows).toEqual([
      { value: 1 },
    ]);
  } finally {
    await held.query('ROLLBACK');
    held.release();
    await database.db.execute(sql`DROP TABLE IF EXISTS ${relation}`);
    await database.close();
  }
});

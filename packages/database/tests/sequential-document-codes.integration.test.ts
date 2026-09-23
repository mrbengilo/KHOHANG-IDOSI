import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, db, orderSessions } from '../src/index.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('sequential document codes', () => {
  afterAll(closeDatabase);

  it('assigns a short code on insert and rolls its counter back with the transaction', async () => {
    let rolledBack = '';
    await expect(
      db.transaction(async (tx) => {
        const [session] = await tx
          .insert(orderSessions)
          .values({
            code: '',
            businessDate: '2099-01-01',
            inventorySnapshotDueAt: new Date('2099-01-01T01:00:00Z'),
            requestDeadlineAt: new Date('2099-01-01T02:00:00Z'),
            policyVersion: 'test',
          })
          .returning({ code: orderSessions.code });
        rolledBack = session!.code;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const [committed] = await db
      .execute<{ code: string }>(sql`SELECT next_document_code('PDH') AS code`)
      .then((result) => result.rows);
    expect(committed!.code).toBe(rolledBack);
    expect(committed!.code).toMatch(/^PDH-[0-9]{6}$/);
    const waitCode = await db.execute<{ code: string }>(
      sql`SELECT next_document_code('PC') AS code`,
    );
    expect(waitCode.rows[0]!.code).toMatch(/^PC-[0-9]{7}$/);
  });

  it('issues distinct increasing codes to concurrent writers', async () => {
    const codes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const result = await db.execute<{ code: string }>(
          sql`SELECT next_document_code('TST') AS code`,
        );
        return result.rows[0]!.code;
      }),
    );
    const numbers = codes.map((code) => Number(code.slice(4))).sort((a, b) => a - b);
    expect(codes.every((code) => /^TST-[0-9]{6}$/.test(code))).toBe(true);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, index) => numbers[0]! + index));
  });
});

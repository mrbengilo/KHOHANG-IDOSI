import { createDatabase, orderSessions } from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PostgresAllocationJobRepository } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
describePostgres('daily worker calendar without browser traffic', () => {
  it('prepares once before snapshot, recovers today after 08:00, and respects cancellation', async () => {
    const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
    const repository = new PostgresAllocationJobRepository(client);
    const dates = ['2096-06-10', '2096-06-11'];
    const query = (date: string, time: string) => ({
      now: new Date(`${date}T${time}+07:00`),
      earliestBusinessDate: date,
      limit: 50,
    });
    try {
      const before = await Promise.all([
        repository.listDueSessions(query(dates[0]!, '07:00:00')),
        repository.listDueSessions(query(dates[0]!, '07:00:00')),
      ]);
      expect(before).toEqual([[], []]);
      const created = await client.db
        .select()
        .from(orderSessions)
        .where(and(eq(orderSessions.businessDate, dates[0]!), isNull(orderSessions.deletedAt)));
      expect(created).toHaveLength(1);
      expect(created[0]!.createdByUserId).toBeNull();
      const due = await repository.listDueSessions(query(dates[0]!, '08:05:00'));
      expect(due.map((row) => row.id)).toContain(created[0]!.id);
      const recovered = await repository.listDueSessions(query(dates[1]!, '08:05:00'));
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.businessDate).toBe(dates[1]);
      await client.db
        .update(orderSessions)
        .set({ status: 'cancelled' })
        .where(eq(orderSessions.id, recovered[0]!.id));
      expect(await repository.listDueSessions(query(dates[1]!, '08:10:00'))).toEqual([]);
    } finally {
      for (const date of dates) {
        await client.db
          .update(orderSessions)
          .set({ deletedAt: new Date() })
          .where(eq(orderSessions.businessDate, date));
      }
      await client.close();
    }
  });
});

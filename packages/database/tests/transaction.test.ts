import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { withSerializableTransaction, type Transaction } from '../src/transaction.js';

describe('serializable transaction retry', () => {
  it.each(['40001', '40P01'])('retries a wrapped PostgreSQL %s failure', async (sqlState) => {
    const firstTransaction = { attempt: 1 } as unknown as Transaction;
    const secondTransaction = { attempt: 2 } as unknown as Transaction;
    const transaction = vi
      .fn()
      .mockImplementationOnce(async (operation: (tx: Transaction) => Promise<string>) =>
        operation(firstTransaction),
      )
      .mockImplementationOnce(async (operation: (tx: Transaction) => Promise<string>) =>
        operation(secondTransaction),
      );
    const database = { transaction } as unknown as Database;
    const wrappedSerializationFailure = new Error('Drizzle query failed', {
      cause: new Error('PostgreSQL transaction aborted', {
        cause: Object.assign(new Error('retry transaction'), { code: sqlState }),
      }),
    });
    const operation = vi
      .fn<(tx: Transaction) => Promise<string>>()
      .mockRejectedValueOnce(wrappedSerializationFailure)
      .mockResolvedValueOnce('committed');

    await expect(withSerializableTransaction(database, operation)).resolves.toBe('committed');
    expect(operation).toHaveBeenNthCalledWith(1, firstTransaction);
    expect(operation).toHaveBeenNthCalledWith(2, secondTransaction);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: 'serializable' });
  });

  it('does not retry business failures or unrelated database errors', async () => {
    const businessError = Object.assign(new Error('stale receipt'), {
      code: 'SUPPLIER_INBOUND_CONFLICT',
    });
    const transaction = vi.fn(async (operation: (tx: Transaction) => Promise<never>) =>
      operation({} as Transaction),
    );
    const database = { transaction } as unknown as Database;
    const operation = vi.fn<(tx: Transaction) => Promise<never>>().mockRejectedValue(businessError);

    await expect(withSerializableTransaction(database, operation)).rejects.toBe(businessError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('stops at the configured retry bound and preserves the final driver error', async () => {
    const failures = [1, 2, 3].map((attempt) =>
      Object.assign(new Error(`serialization failure ${attempt}`), { code: '40001' }),
    );
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(failures[0])
      .mockRejectedValueOnce(failures[1])
      .mockRejectedValueOnce(failures[2]);
    const database = { transaction } as unknown as Database;
    const operation = vi.fn<(tx: Transaction) => Promise<never>>();

    await expect(withSerializableTransaction(database, operation, { maxAttempts: 3 })).rejects.toBe(
      failures[2],
    );
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(operation).not.toHaveBeenCalled();
  });
});

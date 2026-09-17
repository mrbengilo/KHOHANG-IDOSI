import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

type TransactionCallback = Parameters<Database['transaction']>[0];
export type Transaction = Parameters<TransactionCallback>[0];

export interface TransactionOptions {
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  readonly accessMode?: 'read only' | 'read write';
  readonly deferrable?: boolean;
}

export interface RetryableTransactionOptions extends TransactionOptions {
  readonly maxAttempts?: number;
}

export async function withTransaction<T>(
  database: Database,
  operation: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return database.transaction(operation, {
    isolationLevel: options.isolationLevel ?? 'read committed',
    accessMode: options.accessMode ?? 'read write',
    deferrable: options.deferrable ?? false,
  });
}

export async function withSerializableTransaction<T>(
  database: Database,
  operation: (tx: Transaction) => Promise<T>,
  options: RetryableTransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer.');
  }

  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      return await withTransaction(database, operation, {
        isolationLevel: 'serializable',
        accessMode: options.accessMode ?? 'read write',
        deferrable: options.deferrable ?? false,
      });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }

  throw new Error('Serializable transaction exhausted its retry budget.');
}

export async function withAdvisoryLock<T>(
  tx: Transaction,
  namespace: string,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (namespace.trim().length === 0 || key.trim().length === 0) {
    throw new Error('Advisory lock namespace and key must not be blank.');
  }

  const lockName = `${namespace}:${key}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`);
  return operation();
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = Reflect.get(error, 'code');
  return code === '40001' || code === '40P01';
}

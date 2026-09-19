import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

const RETRYABLE_TRANSACTION_SQLSTATES = new Set(['40001', '40P01']);
const RETRY_BASE_DELAY_MS = 5;
const RETRY_MAX_DELAY_MS = 50;
const MAX_ERROR_CAUSE_DEPTH = 8;

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
      await waitBeforeTransactionRetry(attempt);
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

export function isRetryableTransactionError(error: unknown): boolean {
  let current = error;
  const visited = new Set<object>();

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || visited.has(current)) {
      return false;
    }
    visited.add(current);

    try {
      const code = Reflect.get(current, 'code');
      if (typeof code === 'string' && RETRYABLE_TRANSACTION_SQLSTATES.has(code)) {
        return true;
      }
      current = Reflect.get(current, 'cause');
    } catch {
      return false;
    }
  }

  return false;
}

async function waitBeforeTransactionRetry(failedAttempt: number): Promise<void> {
  const exponentialDelay = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
  );
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(RETRY_MAX_DELAY_MS, exponentialDelay + jitter));
  });
}

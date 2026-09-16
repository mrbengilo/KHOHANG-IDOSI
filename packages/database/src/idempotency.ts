import { and, eq } from 'drizzle-orm';

import type { Database } from './client.js';
import { idempotencyKeys, type JsonValue } from './schema.js';
import { withAdvisoryLock, withSerializableTransaction, type Transaction } from './transaction.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LOCK_MS = 5 * 60 * 1_000;

export interface IdempotencyInput {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly ttlMs?: number;
  readonly lockMs?: number;
}

export interface IdempotentOperationResult<T> {
  readonly value: T;
  readonly responseStatus: number;
  readonly responseBody: JsonValue | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

export type IdempotencyResult<T> =
  | ({ readonly replayed: false } & IdempotentOperationResult<T>)
  | {
      readonly replayed: true;
      readonly responseStatus: number;
      readonly responseBody: JsonValue | null;
      readonly resourceType: string | null;
      readonly resourceId: string | null;
    };

export class IdempotencyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_KEY_REUSED';

  public constructor(scope: string, key: string) {
    super(
      `Idempotency key "${key}" was already used with a different request in scope "${scope}".`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyInProgressError extends Error {
  public readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  public constructor(scope: string, key: string) {
    super(`Idempotent operation "${scope}:${key}" is still in progress.`);
    this.name = 'IdempotencyInProgressError';
  }
}

export async function withIdempotency<T>(
  database: Database,
  input: IdempotencyInput,
  operation: (tx: Transaction) => Promise<IdempotentOperationResult<T>>,
): Promise<IdempotencyResult<T>> {
  validateInput(input);

  return withSerializableTransaction(database, (tx) =>
    withAdvisoryLock(tx, 'idempotency', `${input.scope}:${input.key}`, async () => {
      const now = new Date();
      const lockMs = input.lockMs ?? DEFAULT_LOCK_MS;
      const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, input.scope), eq(idempotencyKeys.key, input.key)))
        .limit(1);

      if (existing && existing.expiresAt > now) {
        if (existing.requestHash !== input.requestHash) {
          throw new IdempotencyConflictError(input.scope, input.key);
        }

        if (existing.status === 'completed') {
          if (existing.responseStatus === null) {
            throw new Error('Completed idempotency record is missing its response status.');
          }

          return {
            replayed: true,
            responseStatus: existing.responseStatus,
            responseBody: existing.responseBody,
            resourceType: existing.resourceType,
            resourceId: existing.resourceId,
          };
        }

        if (existing.status === 'in_progress' && existing.lockedUntil > now) {
          throw new IdempotencyInProgressError(input.scope, input.key);
        }
      }

      const lockedUntil = new Date(now.getTime() + lockMs);
      const expiresAt = new Date(now.getTime() + ttlMs);

      if (existing) {
        await tx
          .update(idempotencyKeys)
          .set({
            requestHash: input.requestHash,
            status: 'in_progress',
            responseStatus: null,
            responseBody: null,
            resourceType: null,
            resourceId: null,
            lockedUntil,
            expiresAt,
            updatedAt: now,
          })
          .where(eq(idempotencyKeys.id, existing.id));
      } else {
        await tx.insert(idempotencyKeys).values({
          scope: input.scope,
          key: input.key,
          requestHash: input.requestHash,
          status: 'in_progress',
          lockedUntil,
          expiresAt,
        });
      }

      const result = await operation(tx);

      await tx
        .update(idempotencyKeys)
        .set({
          status: 'completed',
          responseStatus: result.responseStatus,
          responseBody: result.responseBody,
          resourceType: result.resourceType,
          resourceId: result.resourceId,
          lockedUntil: now,
          updatedAt: new Date(),
        })
        .where(and(eq(idempotencyKeys.scope, input.scope), eq(idempotencyKeys.key, input.key)));

      return { replayed: false, ...result };
    }),
  );
}

function validateInput(input: IdempotencyInput): void {
  if (input.scope.trim().length === 0 || input.key.trim().length === 0) {
    throw new Error('Idempotency scope and key must not be blank.');
  }

  if (input.requestHash.trim().length === 0) {
    throw new Error('Idempotency requestHash must not be blank.');
  }

  for (const [name, value] of [
    ['ttlMs', input.ttlMs ?? DEFAULT_TTL_MS],
    ['lockMs', input.lockMs ?? DEFAULT_LOCK_MS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
}

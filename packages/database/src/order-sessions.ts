import { and, eq, isNull, ne } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import { auditLogs, orderSessions, users, type JsonObject } from './schema.js';
import { withAdvisoryLock, type Transaction } from './transaction.js';

const HO_CHI_MINH_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
});

export interface CreateOrderSessionInput {
  readonly businessDate: string;
  readonly requestOpensAt: Date;
  readonly requestClosesAt: Date;
  readonly allocationStartsAt: Date;
  readonly policyVersion: string;
  readonly createdByUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
}

export interface TransitionOrderSessionInput {
  readonly orderSessionId: string;
  readonly targetStatus: 'open' | 'closed' | 'cancelled';
  readonly expectedVersion: number;
  readonly reason?: string | null;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId?: string | null;
  readonly transitionedAt?: Date;
}

export type OrderSessionRecord = typeof orderSessions.$inferSelect;

export class OrderSessionAuthorizationError extends Error {
  public readonly code = 'ORDER_SESSION_FORBIDDEN';

  public constructor() {
    super('Only an active administrator can manage order sessions.');
    this.name = 'OrderSessionAuthorizationError';
  }
}

export class OrderSessionConflictError extends Error {
  public readonly code = 'ORDER_SESSION_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'OrderSessionConflictError';
  }
}

export class OrderSessionNotFoundError extends Error {
  public readonly code = 'ORDER_SESSION_NOT_FOUND';

  public constructor() {
    super('Order session does not exist.');
    this.name = 'OrderSessionNotFoundError';
  }
}

export class OrderSessionValidationError extends Error {
  public readonly code = 'ORDER_SESSION_VALIDATION_ERROR';

  public constructor(message: string) {
    super(message);
    this.name = 'OrderSessionValidationError';
  }
}

export async function createOrderSession(
  database: Database,
  input: CreateOrderSessionInput,
): Promise<IdempotencyResult<OrderSessionRecord>> {
  validateCreateInput(input);
  return withIdempotency(
    database,
    {
      scope: 'order-session.create',
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'order-session-business-date', input.businessDate, async () => {
        await assertActiveAdministrator(tx, input.createdByUserId);
        const [existing] = await tx
          .select({ id: orderSessions.id })
          .from(orderSessions)
          .where(
            and(
              eq(orderSessions.businessDate, input.businessDate),
              ne(orderSessions.status, 'cancelled'),
              isNull(orderSessions.deletedAt),
            ),
          )
          .limit(1);
        if (existing) {
          throw new OrderSessionConflictError(
            `An active order session already exists for ${input.businessDate}.`,
          );
        }

        const [created] = await tx
          .insert(orderSessions)
          .values({
            code: '', // Assigned by the database in the same transaction.
            businessDate: input.businessDate,
            status: 'draft',
            openedAt: input.requestOpensAt,
            inventorySnapshotDueAt: input.requestClosesAt,
            requestDeadlineAt: input.allocationStartsAt,
            policyVersion: input.policyVersion.trim(),
            createdByUserId: input.createdByUserId,
          })
          .returning();
        if (!created) throw new Error('Order session insert returned no row.');

        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: input.createdByUserId,
          actorRole: 'admin',
          action: 'ORDER_SESSION_CREATED',
          entityType: 'order_session',
          entityId: created.id,
          after: sessionAuditSnapshot(created),
        });

        return {
          value: created,
          responseStatus: 201,
          responseBody: { orderSessionId: created.id, version: created.version },
          resourceType: 'order_session',
          resourceId: created.id,
        };
      }),
  );
}

export async function transitionOrderSession(
  database: Database,
  input: TransitionOrderSessionInput,
): Promise<IdempotencyResult<OrderSessionRecord>> {
  validateTransitionInput(input);
  return withIdempotency(
    database,
    {
      scope: `order-session.transition:${input.orderSessionId}`,
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    },
    (tx) =>
      withAdvisoryLock(tx, 'order-session', input.orderSessionId, async () => {
        await assertActiveAdministrator(tx, input.actorUserId);
        const [current] = await tx
          .select()
          .from(orderSessions)
          .where(and(eq(orderSessions.id, input.orderSessionId), isNull(orderSessions.deletedAt)))
          .for('update')
          .limit(1);
        if (!current) throw new OrderSessionNotFoundError();
        if (current.version !== input.expectedVersion) {
          throw new OrderSessionConflictError('Order session version is stale.');
        }

        assertTransition(current, input);
        if (current.status === input.targetStatus) {
          return sessionOperationResult(current);
        }

        const transitionedAt = input.transitionedAt ?? new Date();
        const closedAt =
          input.targetStatus === 'closed'
            ? transitionedAt
            : input.targetStatus === 'cancelled'
              ? transitionedAt >= (current.openedAt ?? current.createdAt)
                ? transitionedAt
                : null
              : current.closedAt;
        const [updated] = await tx
          .update(orderSessions)
          .set({
            status: input.targetStatus,
            closedAt,
            version: current.version + 1,
            updatedAt: transitionedAt,
          })
          .where(
            and(
              eq(orderSessions.id, current.id),
              eq(orderSessions.version, input.expectedVersion),
              eq(orderSessions.status, current.status),
              isNull(orderSessions.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new OrderSessionConflictError('Order session changed during transition.');
        }

        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          action: `ORDER_SESSION_${input.targetStatus.toUpperCase()}`,
          entityType: 'order_session',
          entityId: updated.id,
          before: sessionAuditSnapshot(current),
          after: sessionAuditSnapshot(updated),
          metadata: input.reason ? { reason: input.reason.trim() } : {},
        });

        return sessionOperationResult(updated);
      }),
  );
}

function sessionOperationResult(row: OrderSessionRecord) {
  return {
    value: row,
    responseStatus: 200,
    responseBody: { orderSessionId: row.id, status: row.status, version: row.version },
    resourceType: 'order_session',
    resourceId: row.id,
  } as const;
}

function assertTransition(current: OrderSessionRecord, input: TransitionOrderSessionInput): void {
  const allowed =
    (current.status === 'draft' && ['open', 'cancelled'].includes(input.targetStatus)) ||
    (current.status === 'open' && ['open', 'closed', 'cancelled'].includes(input.targetStatus)) ||
    (current.status === 'closed' && ['closed', 'cancelled'].includes(input.targetStatus));
  if (!allowed) {
    throw new OrderSessionConflictError(
      `Order session cannot transition from ${current.status} to ${input.targetStatus}.`,
    );
  }
  const transitionedAt = input.transitionedAt ?? new Date();
  if (
    input.targetStatus === 'open' &&
    (transitionedAt < (current.openedAt ?? current.createdAt) ||
      transitionedAt >= current.inventorySnapshotDueAt)
  ) {
    throw new OrderSessionConflictError('Order session is outside its configured request window.');
  }
}

async function assertActiveAdministrator(tx: Transaction, userId: string): Promise<void> {
  const [administrator] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.role, 'admin'),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!administrator) throw new OrderSessionAuthorizationError();
}

function validateCreateInput(input: CreateOrderSessionInput): void {
  for (const [name, instant] of [
    ['requestOpensAt', input.requestOpensAt],
    ['requestClosesAt', input.requestClosesAt],
    ['allocationStartsAt', input.allocationStartsAt],
  ] as const) {
    if (Number.isNaN(instant.getTime())) {
      throw new OrderSessionValidationError(`${name} must be a valid instant.`);
    }
    if (hoChiMinhBusinessDate(instant) !== input.businessDate) {
      throw new OrderSessionValidationError(
        `${name} must fall on the business date in Asia/Ho_Chi_Minh.`,
      );
    }
  }
  if (input.requestOpensAt >= input.requestClosesAt) {
    throw new OrderSessionValidationError('Request close time must be after request open time.');
  }
  if (input.requestClosesAt > input.allocationStartsAt) {
    throw new OrderSessionValidationError(
      'Allocation start time cannot precede the request close time.',
    );
  }
  if (input.policyVersion.trim().length === 0 || input.policyVersion.trim().length > 80) {
    throw new OrderSessionValidationError(
      'policyVersion must contain between 1 and 80 characters.',
    );
  }
}

function validateTransitionInput(input: TransitionOrderSessionInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new OrderSessionValidationError('expectedVersion must be a non-negative safe integer.');
  }
  if (input.targetStatus === 'cancelled' && (input.reason?.trim().length ?? 0) < 3) {
    throw new OrderSessionValidationError('Cancellation requires an audit reason.');
  }
  if (input.reason !== undefined && input.reason !== null && input.reason.trim().length > 500) {
    throw new OrderSessionValidationError('reason must not exceed 500 characters.');
  }
}

function hoChiMinhBusinessDate(instant: Date): string {
  const parts = HO_CHI_MINH_DATE_FORMATTER.formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Unable to resolve Asia/Ho_Chi_Minh date.');
  return `${year}-${month}-${day}`;
}

function sessionAuditSnapshot(row: OrderSessionRecord): JsonObject {
  return {
    businessDate: row.businessDate,
    status: row.status,
    requestOpensAt: (row.openedAt ?? row.createdAt).toISOString(),
    requestClosesAt: row.inventorySnapshotDueAt.toISOString(),
    allocationStartsAt: row.requestDeadlineAt.toISOString(),
    policyVersion: row.policyVersion,
    version: row.version,
  };
}

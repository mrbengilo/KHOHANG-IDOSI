import { SupportedAllocationPolicyVersionSchema } from '@idosi/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { withIdempotency, type IdempotencyResult } from './idempotency.js';
import { auditLogs, orderRequests, orderSessions, users, type JsonObject } from './schema.js';
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
  /** Server clock for tests; a new session may not be scheduled into the past. */
  readonly now?: Date;
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

/** The new schedule would make the session unreachable for stores; nothing is created. */
export class OrderSessionScheduleConflictError extends Error {
  public readonly code = 'ORDER_SESSION_SCHEDULE_CONFLICT';

  public constructor(message: string) {
    super(message);
    this.name = 'OrderSessionScheduleConflictError';
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

/**
 * Adds an Admin (MANUAL) session. Any number of sessions may share a business date; each keeps
 * its own requests, snapshot, offers, allocation run and documents. The system's DEFAULT session
 * of the date is neither replaced, rescheduled, closed nor merged by this command.
 */
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
        const now = input.now ?? new Date();
        if (input.requestClosesAt.getTime() <= now.getTime()) {
          // A session scheduled into the past would snapshot and allocate history it never saw.
          throw new OrderSessionValidationError(
            'Giờ chốt nhận đơn đã qua; chỉ tạo được phiên có giờ chốt trong tương lai.',
          );
        }
        // Stores are routed to the open session that closes first, ties broken by creation
        // order. A new session closing at exactly the same instant as an existing one would
        // therefore never receive an order; it is refused instead of silently staying empty.
        const [sameClose] = await tx
          .select({ code: orderSessions.code })
          .from(orderSessions)
          .where(
            and(
              eq(orderSessions.inventorySnapshotDueAt, input.requestClosesAt),
              inArray(orderSessions.status, ['draft', 'open']),
              isNull(orderSessions.deletedAt),
            ),
          )
          .limit(1);
        if (sameClose) {
          throw new OrderSessionScheduleConflictError(
            `Phiên ${sameClose.code} đã chốt nhận đơn đúng thời điểm này; chọn giờ chốt khác để cửa hàng gửi được đơn vào phiên mới.`,
          );
        }

        const [created] = await tx
          .insert(orderSessions)
          .values({
            code: '', // Assigned by the database in the same transaction.
            businessDate: input.businessDate,
            kind: 'manual',
            status: 'draft',
            openedAt: input.requestOpensAt,
            inventorySnapshotDueAt: input.requestClosesAt,
            requestDeadlineAt: input.allocationStartsAt,
            policyVersion: input.policyVersion.trim(),
            createdByUserId: input.createdByUserId,
            createdAt: now,
            updatedAt: now,
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

/**
 * Opens every scheduled (draft) session, of any kind, whose request window has started and not
 * yet closed. Each session keeps its own stored schedule; nothing here assumes 08:00/09:00.
 */
export async function openDueScheduledSessions(
  tx: Transaction,
  now: Date,
  source: 'allocation_worker' | 'ordering_context',
): Promise<readonly OrderSessionRecord[]> {
  const due = await tx
    .select()
    .from(orderSessions)
    .where(
      and(
        eq(orderSessions.status, 'draft'),
        isNull(orderSessions.deletedAt),
        sql`coalesce(${orderSessions.openedAt}, ${orderSessions.createdAt}) <= ${now}`,
        sql`${orderSessions.inventorySnapshotDueAt} > ${now}`,
      ),
    )
    .orderBy(orderSessions.inventorySnapshotDueAt, orderSessions.createdAt, orderSessions.id)
    .for('update', { skipLocked: true });
  const opened: OrderSessionRecord[] = [];
  for (const session of due) {
    const [row] = await tx
      .update(orderSessions)
      .set({ status: 'open', updatedAt: now })
      .where(and(eq(orderSessions.id, session.id), eq(orderSessions.status, 'draft')))
      .returning();
    if (!row) continue;
    await tx.insert(auditLogs).values({
      action: 'ORDER_SESSION_AUTO_OPENED',
      entityType: 'order_session',
      entityId: row.id,
      before: sessionAuditSnapshot(session),
      after: sessionAuditSnapshot(row),
      metadata: { source, reason: 'Scheduled request window started' },
    });
    opened.push(row);
  }
  return opened;
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

        // A cancelled session is never allocated, so its pending requests must not linger as
        // "submitted" forever. They are cancelled with the session and free the stores' slots.
        const cancelledRequests =
          input.targetStatus === 'cancelled'
            ? await tx
                .update(orderRequests)
                .set({
                  status: 'cancelled',
                  cancelledAt: transitionedAt,
                  cancellationReason: `Phiên đặt hàng bị hủy: ${input.reason?.trim() ?? ''}`.trim(),
                  updatedAt: transitionedAt,
                })
                .where(
                  and(
                    eq(orderRequests.orderSessionId, current.id),
                    eq(orderRequests.status, 'submitted'),
                    isNull(orderRequests.deletedAt),
                  ),
                )
                .returning({ id: orderRequests.id, storeId: orderRequests.storeId })
            : [];

        await tx.insert(auditLogs).values({
          requestId: input.requestId ?? null,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          action: `ORDER_SESSION_${input.targetStatus.toUpperCase()}`,
          entityType: 'order_session',
          entityId: updated.id,
          before: sessionAuditSnapshot(current),
          after: sessionAuditSnapshot(updated),
          metadata: {
            ...(input.reason ? { reason: input.reason.trim() } : {}),
            ...(cancelledRequests.length > 0
              ? { cancelledOrderRequestIds: cancelledRequests.map((request) => request.id) }
              : {}),
          },
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
    input.targetStatus === 'cancelled' &&
    current.status !== 'cancelled' &&
    // A scheduled session that never opened was never snapshotted by the worker (it only runs
    // open/closed sessions), so no priority stock is held for it and it may still be cancelled.
    current.status !== 'draft' &&
    transitionedAt >= current.inventorySnapshotDueAt
  ) {
    // From the 08:00 snapshot on, priority stock is held and stores are answering offers.
    // Only the 09:00 run can settle those holds, so the session must run to completion.
    throw new OrderSessionConflictError(
      'Không thể hủy phiên sau mốc chụp tồn: hàng ưu tiên đã được giữ và phiên sẽ tự chốt ở mốc phân bổ.',
    );
  }
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
  if (input.requestClosesAt >= input.allocationStartsAt) {
    // Priority offers are created at the request close and stores answer them until allocation
    // starts; a session without that window could only create offers that are already expired.
    throw new OrderSessionValidationError(
      'Giờ bắt đầu phân bổ phải sau giờ chốt nhận đơn để cửa hàng có thời gian xác nhận hàng ưu tiên.',
    );
  }
  if (!SupportedAllocationPolicyVersionSchema.safeParse(input.policyVersion).success) {
    throw new OrderSessionValidationError('Phiên bản chính sách phân bổ không được hỗ trợ.');
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
    code: row.code,
    kind: row.kind,
    businessDate: row.businessDate,
    status: row.status,
    requestOpensAt: (row.openedAt ?? row.createdAt).toISOString(),
    requestClosesAt: row.inventorySnapshotDueAt.toISOString(),
    allocationStartsAt: row.requestDeadlineAt.toISOString(),
    policyVersion: row.policyVersion,
    version: row.version,
  };
}

import { DomainError, invariant } from './errors.js';
import {
  ALLOCATION_PRIORITY_POLICY,
  comparePriority,
  isNewOrderPriority,
  type AllocationPriority,
  type NewOrderPriority,
} from './policy.js';
import {
  businessDate,
  compareTimestamps,
  isoTimestamp,
  nonEmpty,
  positiveInteger,
  safeIntegerSum,
  stableTupleKey,
  type BusinessDate,
  type IsoTimestamp,
} from './validation.js';

export const ORDER_SESSION_STATUSES = [
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'ALLOCATING',
  'ALLOCATED',
  'CANCELLED',
] as const;

export type OrderSessionStatus = (typeof ORDER_SESSION_STATUSES)[number];

export interface OrderSession {
  readonly id: string;
  readonly businessDate: BusinessDate;
  readonly requestOpensAt: IsoTimestamp;
  readonly requestClosesAt: IsoTimestamp;
  readonly allocationStartsAt: IsoTimestamp;
  readonly status: OrderSessionStatus;
}

export interface OrderSessionInput {
  readonly id: string;
  readonly businessDate: string;
  readonly requestOpensAt: string;
  readonly requestClosesAt: string;
  readonly allocationStartsAt: string;
  readonly status: OrderSessionStatus;
}

export function createOrderSession(input: OrderSessionInput): OrderSession {
  const requestOpensAt = isoTimestamp(input.requestOpensAt, 'requestOpensAt');
  const requestClosesAt = isoTimestamp(input.requestClosesAt, 'requestClosesAt');
  const allocationStartsAt = isoTimestamp(input.allocationStartsAt, 'allocationStartsAt');

  invariant(
    compareTimestamps(requestOpensAt, requestClosesAt) < 0,
    'INVALID_ARGUMENT',
    'requestOpensAt must be before requestClosesAt',
  );
  invariant(
    compareTimestamps(requestClosesAt, allocationStartsAt) <= 0,
    'INVALID_ARGUMENT',
    'allocationStartsAt must be at or after requestClosesAt',
  );
  invariant(
    ORDER_SESSION_STATUSES.includes(input.status),
    'INVALID_ARGUMENT',
    'Unknown order session status',
    { status: input.status },
  );

  return Object.freeze({
    id: nonEmpty(input.id, 'sessionId'),
    businessDate: businessDate(input.businessDate),
    requestOpensAt,
    requestClosesAt,
    allocationStartsAt,
    status: input.status,
  });
}

export function isRequestWindowOpen(session: OrderSession, at: string): boolean {
  const timestamp = isoTimestamp(at, 'at');
  return (
    session.status === 'OPEN' &&
    compareTimestamps(timestamp, session.requestOpensAt) >= 0 &&
    compareTimestamps(timestamp, session.requestClosesAt) < 0
  );
}

export const STORE_ORDER_REQUEST_STATUSES = ['SUBMITTED', 'MERGED', 'CANCELLED'] as const;
export type StoreOrderRequestStatus = (typeof STORE_ORDER_REQUEST_STATUSES)[number];
export type RequestSequence = 1 | 2;

export interface StoreOrderRequestLine {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly priority: NewOrderPriority;
}

export interface StoreOrderRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly requestSequence: RequestSequence;
  readonly idempotencyKey: string;
  readonly submittedAt: IsoTimestamp;
  readonly status: StoreOrderRequestStatus;
  readonly lines: readonly StoreOrderRequestLine[];
}

export type OrderRequest = StoreOrderRequest;

export interface StoreOrderRequestInput {
  readonly id: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly requestSequence: RequestSequence;
  readonly idempotencyKey: string;
  readonly submittedAt: string;
  readonly status?: StoreOrderRequestStatus;
  readonly lines: readonly Readonly<{
    id: string;
    productId: string;
    quantity: number;
    priority: NewOrderPriority;
  }>[];
}

export function createStoreOrderRequest(input: StoreOrderRequestInput): StoreOrderRequest {
  const status = input.status ?? 'SUBMITTED';
  invariant(
    STORE_ORDER_REQUEST_STATUSES.includes(status),
    'INVALID_ARGUMENT',
    'Unknown store order request status',
    { status },
  );
  invariant(
    input.requestSequence === 1 || input.requestSequence === 2,
    'INVALID_ARGUMENT',
    'requestSequence must be 1 or 2',
    { requestSequence: input.requestSequence },
  );
  invariant(input.lines.length > 0, 'INVALID_ARGUMENT', 'An order request needs at least one line');

  const seenLineIds = new Set<string>();
  const seenProducts = new Set<string>();
  const lines = input.lines.map((line): StoreOrderRequestLine => {
    const id = nonEmpty(line.id, 'lineId');
    const productId = nonEmpty(line.productId, 'productId');
    invariant(!seenLineIds.has(id), 'INVALID_ARGUMENT', 'Request line ids must be unique', {
      lineId: id,
    });
    invariant(
      !seenProducts.has(productId),
      'INVALID_ARGUMENT',
      'A product can occur only once in an order request',
      { productId },
    );
    invariant(
      isNewOrderPriority(line.priority),
      'INVALID_ARGUMENT',
      'P0A is reserved for confirmed prior wait tickets',
      { priority: line.priority },
    );
    seenLineIds.add(id);
    seenProducts.add(productId);
    return Object.freeze({
      id,
      productId,
      quantity: positiveInteger(line.quantity, 'line.quantity'),
      priority: line.priority,
    });
  });

  lines.sort((left, right) => left.productId.localeCompare(right.productId));
  return Object.freeze({
    id: nonEmpty(input.id, 'requestId'),
    sessionId: nonEmpty(input.sessionId, 'sessionId'),
    storeId: nonEmpty(input.storeId, 'storeId'),
    requestSequence: input.requestSequence,
    idempotencyKey: nonEmpty(input.idempotencyKey, 'idempotencyKey'),
    submittedAt: isoTimestamp(input.submittedAt, 'submittedAt'),
    status,
    lines: Object.freeze(lines),
  });
}

function sameRequestPayload(left: StoreOrderRequest, right: StoreOrderRequest): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.storeId === right.storeId &&
    left.requestSequence === right.requestSequence &&
    JSON.stringify(left.lines) === JSON.stringify(right.lines)
  );
}

export function assertAtMostTwoRequestsPerStoreSession(
  requests: readonly StoreOrderRequest[],
): void {
  const grouped = new Map<string, StoreOrderRequest[]>();
  for (const request of requests) {
    const key = stableTupleKey([request.sessionId, request.storeId]);
    const group = grouped.get(key) ?? [];
    group.push(request);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    invariant(
      group.length <= 2,
      'REQUEST_LIMIT_EXCEEDED',
      'A store may submit at most two requests in an order session',
      { sessionId: group[0]?.sessionId ?? '', storeId: group[0]?.storeId ?? '' },
    );
    invariant(
      new Set(group.map((request) => request.requestSequence)).size === group.length,
      'DUPLICATE_REQUEST_SEQUENCE',
      'A request sequence may be used only once per store and session',
      { sessionId: group[0]?.sessionId ?? '', storeId: group[0]?.storeId ?? '' },
    );
  }
}

export interface SubmitOrderRequestResult {
  readonly request: StoreOrderRequest;
  readonly requests: readonly StoreOrderRequest[];
  readonly replayed: boolean;
}

export function submitOrderRequest(
  session: OrderSession,
  existingRequests: readonly StoreOrderRequest[],
  input: StoreOrderRequestInput,
): SubmitOrderRequestResult {
  const candidate = createStoreOrderRequest(input);
  invariant(
    candidate.status === 'SUBMITTED',
    'INVALID_ARGUMENT',
    'A newly submitted order request must have SUBMITTED status',
    { status: candidate.status },
  );
  invariant(
    candidate.sessionId === session.id,
    'INVALID_ARGUMENT',
    'Request session does not match the supplied order session',
  );
  assertAtMostTwoRequestsPerStoreSession(existingRequests);

  const replay = existingRequests.find(
    (request) =>
      request.sessionId === candidate.sessionId &&
      request.storeId === candidate.storeId &&
      request.idempotencyKey === candidate.idempotencyKey,
  );
  if (replay !== undefined) {
    if (!sameRequestPayload(replay, candidate)) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The request idempotency key was already used with another payload',
        { idempotencyKey: candidate.idempotencyKey },
      );
    }
    return Object.freeze({ request: replay, requests: existingRequests, replayed: true });
  }

  invariant(
    isRequestWindowOpen(session, candidate.submittedAt),
    'REQUEST_WINDOW_CLOSED',
    'The order session is not accepting requests at submittedAt',
    { sessionId: session.id, submittedAt: candidate.submittedAt },
  );
  invariant(
    !existingRequests.some((request) => request.id === candidate.id),
    'INVALID_ARGUMENT',
    'Request id must be unique',
    { requestId: candidate.id },
  );

  const priorForStore = existingRequests.filter(
    (request) => request.sessionId === candidate.sessionId && request.storeId === candidate.storeId,
  );
  invariant(
    priorForStore.length < 2,
    'REQUEST_LIMIT_EXCEEDED',
    'A store may submit at most two requests in an order session',
    { sessionId: candidate.sessionId, storeId: candidate.storeId },
  );
  invariant(
    candidate.requestSequence === priorForStore.length + 1,
    'DUPLICATE_REQUEST_SEQUENCE',
    'Request sequence must follow the store submission order',
    { requestSequence: candidate.requestSequence },
  );

  const requests = Object.freeze([...existingRequests, candidate]);
  return Object.freeze({ request: candidate, requests, replayed: false });
}

export interface MergedDemandSourceLine {
  readonly requestId: string;
  readonly requestSequence: RequestSequence;
  readonly lineId: string;
  readonly quantity: number;
  readonly priority: NewOrderPriority;
}

export interface MergedDemand {
  readonly demandId: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly priority: NewOrderPriority;
  readonly source: 'ORDER_REQUEST';
  readonly sourceIds: readonly string[];
  readonly sourceLines: readonly MergedDemandSourceLine[];
}

interface MutableMergedDemand {
  demandId: string;
  sessionId: string;
  storeId: string;
  productId: string;
  requestedQuantity: number;
  priority: NewOrderPriority;
  source: 'ORDER_REQUEST';
  sourceIds: string[];
  sourceLines: MergedDemandSourceLine[];
}

export function mergeOrderRequests(
  requests: readonly StoreOrderRequest[],
): readonly MergedDemand[] {
  assertAtMostTwoRequestsPerStoreSession(requests);
  const merged = new Map<string, MutableMergedDemand>();

  for (const request of requests) {
    if (request.status === 'CANCELLED') {
      continue;
    }
    for (const line of request.lines) {
      const key = stableTupleKey([request.sessionId, request.storeId, line.productId]);
      const current = merged.get(key);
      const sourceLine: MergedDemandSourceLine = Object.freeze({
        requestId: request.id,
        requestSequence: request.requestSequence,
        lineId: line.id,
        quantity: line.quantity,
        priority: line.priority,
      });
      if (current === undefined) {
        merged.set(key, {
          demandId: `request-demand:${key}`,
          sessionId: request.sessionId,
          storeId: request.storeId,
          productId: line.productId,
          requestedQuantity: line.quantity,
          priority: line.priority,
          source: 'ORDER_REQUEST',
          sourceIds: [request.id],
          sourceLines: [sourceLine],
        });
        continue;
      }

      current.requestedQuantity = safeIntegerSum(
        current.requestedQuantity,
        line.quantity,
        'merged demand quantity',
      );
      if (comparePriority(line.priority, current.priority) < 0) {
        current.priority = line.priority;
      }
      current.sourceIds.push(request.id);
      current.sourceLines.push(sourceLine);
    }
  }

  return Object.freeze(
    [...merged.values()]
      .map((demand): MergedDemand => {
        const sourceLines = [...demand.sourceLines].sort(
          (left, right) =>
            left.requestSequence - right.requestSequence || left.lineId.localeCompare(right.lineId),
        );
        const sourceIds = [...new Set(demand.sourceIds)].sort();
        const highestPriority = sourceLines.reduce<AllocationPriority>(
          (priority, source) =>
            ALLOCATION_PRIORITY_POLICY[source.priority].rank <
            ALLOCATION_PRIORITY_POLICY[priority].rank
              ? source.priority
              : priority,
          sourceLines[0]?.priority ?? 'P3',
        ) as NewOrderPriority;
        return Object.freeze({
          ...demand,
          priority: highestPriority,
          sourceIds: Object.freeze(sourceIds),
          sourceLines: Object.freeze(sourceLines),
        });
      })
      .sort(
        (left, right) =>
          left.sessionId.localeCompare(right.sessionId) ||
          left.storeId.localeCompare(right.storeId) ||
          left.productId.localeCompare(right.productId),
      ),
  );
}

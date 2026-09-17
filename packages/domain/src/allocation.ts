import { invariant } from './errors.js';
import { type MergedDemand } from './orders.js';
import {
  ALLOCATION_POLICY_VERSION,
  ALLOCATION_PRIORITIES,
  assertDemandSourceAllowed,
  comparePriority,
  isAllocationPriority,
  type AllocationDemandSource,
  type AllocationPriority,
} from './policy.js';
import { type DailyPriorityOffer } from './priority-offers.js';
import { assertValidWaitTicket, type WaitTicket } from './wait-tickets.js';
import {
  isoTimestamp,
  nonEmpty,
  nonNegativeInteger,
  positiveInteger,
  safeIntegerSum,
  stableTupleKey,
  uniqueStrings,
  type IsoTimestamp,
} from './validation.js';

export interface InventorySnapshot {
  readonly id: string;
  readonly version: string;
  readonly productId: string;
  readonly availableQuantity: number;
  readonly capturedAt: IsoTimestamp;
}

export interface InventorySnapshotInput {
  readonly id: string;
  readonly version: string;
  readonly productId: string;
  readonly availableQuantity: number;
  readonly capturedAt: string;
}

export function createInventorySnapshot(input: InventorySnapshotInput): InventorySnapshot {
  return Object.freeze({
    id: nonEmpty(input.id, 'snapshotId'),
    version: nonEmpty(input.version, 'snapshotVersion'),
    productId: nonEmpty(input.productId, 'productId'),
    availableQuantity: nonNegativeInteger(input.availableQuantity, 'availableQuantity'),
    capturedAt: isoTimestamp(input.capturedAt, 'capturedAt'),
  });
}

export interface AllocationDemand {
  readonly demandId: string;
  readonly sessionId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly priority: AllocationPriority;
  readonly source: AllocationDemandSource;
  readonly sourceIds: readonly string[];
  readonly sourceWaitTicketId: string | null;
}

export interface BuildAllocationDemandsInput {
  readonly sessionId: string;
  readonly mergedRequests: readonly MergedDemand[];
  readonly waitTickets: readonly WaitTicket[];
  readonly priorityOffers: readonly DailyPriorityOffer[];
}

export function buildAllocationDemands(
  input: BuildAllocationDemandsInput,
): readonly AllocationDemand[] {
  const sessionId = nonEmpty(input.sessionId, 'sessionId');
  const ticketsById = new Map<string, WaitTicket>();
  for (const ticket of input.waitTickets) {
    assertValidWaitTicket(ticket);
    invariant(!ticketsById.has(ticket.id), 'INVALID_ARGUMENT', 'Wait ticket ids must be unique', {
      ticketId: ticket.id,
    });
    ticketsById.set(ticket.id, ticket);
  }

  const demands: AllocationDemand[] = input.mergedRequests.map((demand) => {
    invariant(
      demand.sessionId === sessionId,
      'INVALID_ARGUMENT',
      'Merged request demand belongs to another session',
      { demandId: demand.demandId },
    );
    return Object.freeze({
      demandId: demand.demandId,
      sessionId,
      storeId: demand.storeId,
      productId: demand.productId,
      requestedQuantity: demand.requestedQuantity,
      priority: demand.priority,
      source: 'ORDER_REQUEST',
      sourceIds: demand.sourceIds,
      sourceWaitTicketId: null,
    });
  });

  const confirmedByTicket = new Map<string, number>();
  for (const offer of input.priorityOffers) {
    if (offer.status !== 'CONFIRMED') {
      continue;
    }
    const ticket = ticketsById.get(offer.waitTicketId);
    invariant(
      ticket !== undefined,
      'INVALID_ARGUMENT',
      'Confirmed priority offer references an unknown wait ticket',
      { offerId: offer.id, waitTicketId: offer.waitTicketId },
    );
    invariant(
      ticket.status === 'ACTIVE' &&
        ticket.storeId === offer.storeId &&
        ticket.productId === offer.productId,
      'INVALID_STATE',
      'Confirmed priority offer no longer matches an active wait ticket',
      { offerId: offer.id, waitTicketId: offer.waitTicketId },
    );
    const confirmedSoFar = confirmedByTicket.get(ticket.id) ?? 0;
    const confirmedTotal = safeIntegerSum(
      confirmedSoFar,
      offer.confirmedQuantity,
      'confirmed priority quantity',
    );
    invariant(
      confirmedTotal <= ticket.openQuantity - ticket.reservedQuantity,
      'WAIT_QUANTITY_EXCEEDED',
      'Confirmed priority quantity exceeds unreserved wait quantity',
      { waitTicketId: ticket.id, confirmedTotal },
    );
    confirmedByTicket.set(ticket.id, confirmedTotal);
    demands.push(
      Object.freeze({
        demandId: `confirmed-wait:${offer.id}`,
        sessionId,
        storeId: ticket.storeId,
        productId: ticket.productId,
        requestedQuantity: positiveInteger(offer.confirmedQuantity, 'offer.confirmedQuantity'),
        priority: 'P0A',
        source: 'CONFIRMED_WAIT',
        sourceIds: Object.freeze([offer.id, ticket.id]),
        sourceWaitTicketId: ticket.id,
      }),
    );
  }

  return Object.freeze(
    demands.sort(
      (left, right) =>
        comparePriority(left.priority, right.priority) ||
        left.storeId.localeCompare(right.storeId) ||
        left.productId.localeCompare(right.productId) ||
        left.demandId.localeCompare(right.demandId),
    ),
  );
}

export interface AllocationInput {
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly policyVersion: string;
  readonly allocatedAt: string;
  readonly snapshot: InventorySnapshot;
  readonly demands: readonly AllocationDemand[];
  /** Stable global store ring. If omitted, unique demand stores are sorted by id. */
  readonly storeOrder?: readonly string[];
  /** The next store to inspect, not the previously served store. */
  readonly startCursor: string | null;
}

export interface AllocationStep {
  readonly sequence: number;
  readonly priority: AllocationPriority;
  readonly round: number;
  readonly storeId: string;
  readonly demandId: string;
  readonly productId: string;
  readonly quantity: 1;
}

export interface AllocationLine {
  readonly demandId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly priority: AllocationPriority;
  readonly source: AllocationDemandSource;
  readonly sourceWaitTicketId: string | null;
  readonly quantity: number;
  readonly rounds: readonly number[];
}

export interface AllocationRemainder {
  readonly demandId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly priority: AllocationPriority;
  readonly source: AllocationDemandSource;
  readonly sourceIds: readonly string[];
  readonly sourceWaitTicketId: string | null;
  readonly requestedQuantity: number;
  readonly allocatedQuantity: number;
  readonly remainingQuantity: number;
}

export interface AllocationRoundSummary {
  readonly priority: AllocationPriority;
  readonly round: number;
  readonly grants: number;
}

export interface AllocationResult {
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly policyVersion: typeof ALLOCATION_POLICY_VERSION;
  readonly allocatedAt: IsoTimestamp;
  readonly snapshotId: string;
  readonly snapshotVersion: string;
  readonly productId: string;
  readonly availableBefore: number;
  readonly allocatedQuantity: number;
  readonly availableAfter: number;
  readonly cursorBefore: string | null;
  /** Next store to inspect in the following allocation run. */
  readonly nextCursor: string | null;
  readonly storeOrder: readonly string[];
  readonly steps: readonly AllocationStep[];
  readonly allocations: readonly AllocationLine[];
  readonly remainders: readonly AllocationRemainder[];
  readonly rounds: readonly AllocationRoundSummary[];
}

interface DemandState {
  readonly demand: AllocationDemand;
  remainingQuantity: number;
}

interface MutableAllocationLine {
  readonly demand: AllocationDemand;
  quantity: number;
  readonly rounds: number[];
}

function validateDemand(demand: AllocationDemand, input: AllocationInput): void {
  nonEmpty(demand.demandId, 'demandId');
  nonEmpty(demand.sessionId, 'demand.sessionId');
  nonEmpty(demand.storeId, 'demand.storeId');
  nonEmpty(demand.productId, 'demand.productId');
  positiveInteger(demand.requestedQuantity, 'demand.requestedQuantity');
  invariant(
    demand.sessionId === input.sessionId,
    'INVALID_ARGUMENT',
    'Allocation demand belongs to another session',
    { demandId: demand.demandId },
  );
  invariant(
    demand.productId === input.snapshot.productId,
    'INVALID_ARGUMENT',
    'Allocation demand product does not match the stock snapshot',
    { demandId: demand.demandId, productId: demand.productId },
  );
  invariant(
    isAllocationPriority(demand.priority),
    'INVALID_ARGUMENT',
    'Unknown allocation priority',
    { demandId: demand.demandId, priority: demand.priority },
  );
  assertDemandSourceAllowed(demand.priority, demand.source);
  const sourceIds = uniqueStrings(demand.sourceIds, 'sourceIds');
  invariant(sourceIds.length > 0, 'INVALID_ARGUMENT', 'Allocation demand needs a source id', {
    demandId: demand.demandId,
  });
  if (demand.source === 'CONFIRMED_WAIT') {
    invariant(
      demand.sourceWaitTicketId !== null,
      'INVALID_ARGUMENT',
      'Confirmed wait demand must reference its wait ticket',
      { demandId: demand.demandId },
    );
    nonEmpty(demand.sourceWaitTicketId, 'sourceWaitTicketId');
  } else {
    invariant(
      demand.sourceWaitTicketId === null,
      'INVALID_ARGUMENT',
      'Only confirmed wait demand may reference a wait ticket',
      { demandId: demand.demandId },
    );
  }
}

function resolveStoreOrder(input: AllocationInput): readonly string[] {
  const demandStores = [...new Set(input.demands.map((demand) => demand.storeId))].sort();
  const order =
    input.storeOrder === undefined
      ? demandStores
      : [...uniqueStrings(input.storeOrder, 'storeOrder')];
  const knownStores = new Set(order);
  invariant(
    demandStores.every((storeId) => knownStores.has(storeId)),
    'INVALID_ARGUMENT',
    'storeOrder must include every store with demand',
  );
  if (input.startCursor !== null) {
    nonEmpty(input.startCursor, 'startCursor');
    invariant(
      knownStores.has(input.startCursor),
      'INVALID_ARGUMENT',
      'startCursor must occur in storeOrder',
      { startCursor: input.startCursor },
    );
  }
  return Object.freeze(order);
}

export function allocateInventory(input: AllocationInput): AllocationResult {
  invariant(
    input.policyVersion === ALLOCATION_POLICY_VERSION,
    'UNSUPPORTED_POLICY_VERSION',
    'Allocation policy version is not supported',
    { policyVersion: input.policyVersion },
  );
  const allocationId = nonEmpty(input.allocationId, 'allocationId');
  const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey');
  const sessionId = nonEmpty(input.sessionId, 'sessionId');
  const allocatedAt = isoTimestamp(input.allocatedAt, 'allocatedAt');
  const snapshot = createInventorySnapshot(input.snapshot);

  const seenDemandIds = new Set<string>();
  let requestedTotal = 0;
  for (const demand of input.demands) {
    validateDemand(demand, input);
    invariant(
      !seenDemandIds.has(demand.demandId),
      'INVALID_ARGUMENT',
      'Allocation demand ids must be unique',
      { demandId: demand.demandId },
    );
    seenDemandIds.add(demand.demandId);
    requestedTotal = safeIntegerSum(
      requestedTotal,
      demand.requestedQuantity,
      'total requested quantity',
    );
  }

  const storeOrder = resolveStoreOrder(input);
  const states: DemandState[] = input.demands
    .map((demand) => ({ demand, remainingQuantity: demand.requestedQuantity }))
    .sort(
      (left, right) =>
        comparePriority(left.demand.priority, right.demand.priority) ||
        left.demand.storeId.localeCompare(right.demand.storeId) ||
        left.demand.demandId.localeCompare(right.demand.demandId),
    );

  const statesByPriorityAndStore = new Map<string, DemandState[]>();
  for (const state of states) {
    const key = stableTupleKey([state.demand.priority, state.demand.storeId]);
    const group = statesByPriorityAndStore.get(key) ?? [];
    group.push(state);
    statesByPriorityAndStore.set(key, group);
  }

  let available = snapshot.availableQuantity;
  let cursorIndex = input.startCursor === null ? 0 : storeOrder.indexOf(input.startCursor);
  let madeAnyGrant = false;
  const steps: AllocationStep[] = [];
  const mutableLines = new Map<string, MutableAllocationLine>();
  const rounds: AllocationRoundSummary[] = [];

  for (const priority of ALLOCATION_PRIORITIES) {
    let round = 0;
    while (available > 0) {
      const hasRemaining = states.some(
        (state) => state.demand.priority === priority && state.remainingQuantity > 0,
      );
      if (!hasRemaining || storeOrder.length === 0) {
        break;
      }

      round += 1;
      const roundStartIndex = cursorIndex;
      let grantsThisRound = 0;
      for (let offset = 0; offset < storeOrder.length && available > 0; offset += 1) {
        const storeIndex = (roundStartIndex + offset) % storeOrder.length;
        const storeId = storeOrder[storeIndex];
        invariant(storeId !== undefined, 'INVALID_STATE', 'Store ring index is invalid');
        const group = statesByPriorityAndStore.get(stableTupleKey([priority, storeId]));
        const state = group?.find((candidate) => candidate.remainingQuantity > 0);
        if (state === undefined) {
          continue;
        }

        state.remainingQuantity -= 1;
        available -= 1;
        grantsThisRound += 1;
        madeAnyGrant = true;
        cursorIndex = (storeIndex + 1) % storeOrder.length;
        const sequence = steps.length + 1;
        steps.push(
          Object.freeze({
            sequence,
            priority,
            round,
            storeId,
            demandId: state.demand.demandId,
            productId: state.demand.productId,
            quantity: 1,
          }),
        );

        const line = mutableLines.get(state.demand.demandId);
        if (line === undefined) {
          mutableLines.set(state.demand.demandId, {
            demand: state.demand,
            quantity: 1,
            rounds: [round],
          });
        } else {
          line.quantity += 1;
          line.rounds.push(round);
        }
      }
      invariant(grantsThisRound > 0, 'INVALID_STATE', 'Allocation round made no progress');
      rounds.push(Object.freeze({ priority, round, grants: grantsThisRound }));
    }
  }

  const allocations: AllocationLine[] = [...mutableLines.values()].map((line) =>
    Object.freeze({
      demandId: line.demand.demandId,
      storeId: line.demand.storeId,
      productId: line.demand.productId,
      priority: line.demand.priority,
      source: line.demand.source,
      sourceWaitTicketId: line.demand.sourceWaitTicketId,
      quantity: line.quantity,
      rounds: Object.freeze([...line.rounds]),
    }),
  );
  allocations.sort(
    (left, right) =>
      (steps.find((step) => step.demandId === left.demandId)?.sequence ?? 0) -
      (steps.find((step) => step.demandId === right.demandId)?.sequence ?? 0),
  );

  const remainders: AllocationRemainder[] = states.map((state) => {
    const allocatedQuantity = state.demand.requestedQuantity - state.remainingQuantity;
    return Object.freeze({
      demandId: state.demand.demandId,
      storeId: state.demand.storeId,
      productId: state.demand.productId,
      priority: state.demand.priority,
      source: state.demand.source,
      sourceIds: state.demand.sourceIds,
      sourceWaitTicketId: state.demand.sourceWaitTicketId,
      requestedQuantity: state.demand.requestedQuantity,
      allocatedQuantity,
      remainingQuantity: state.remainingQuantity,
    });
  });
  const allocatedQuantity = snapshot.availableQuantity - available;
  invariant(
    allocatedQuantity <= snapshot.availableQuantity && allocatedQuantity <= requestedTotal,
    'INVALID_STATE',
    'Allocation conservation invariant failed',
  );

  return Object.freeze({
    allocationId,
    idempotencyKey,
    sessionId,
    policyVersion: ALLOCATION_POLICY_VERSION,
    allocatedAt,
    snapshotId: snapshot.id,
    snapshotVersion: snapshot.version,
    productId: snapshot.productId,
    availableBefore: snapshot.availableQuantity,
    allocatedQuantity,
    availableAfter: available,
    cursorBefore: input.startCursor,
    nextCursor:
      madeAnyGrant && storeOrder.length > 0 ? (storeOrder[cursorIndex] ?? null) : input.startCursor,
    storeOrder,
    steps: Object.freeze(steps),
    allocations: Object.freeze(allocations),
    remainders: Object.freeze(remainders),
    rounds: Object.freeze(rounds),
  });
}

export function allocatedQuantityForDemand(result: AllocationResult, demandId: string): number {
  return result.allocations.find((allocation) => allocation.demandId === demandId)?.quantity ?? 0;
}

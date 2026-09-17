import {
  ALLOCATION_POLICY_VERSION,
  allocateInventory,
  buildAllocationDemands,
  createInventorySnapshot,
  createDailyPriorityOffer,
  type AllocationResult,
  type DailyPriorityOffer,
  type MergedDemand,
  type WaitTicket,
} from '@idosi/domain';

export interface ProductSnapshotPlan {
  readonly id: string;
  readonly version: string;
  readonly productId: string;
  readonly availableQuantity: number;
  readonly capturedAt: string;
}

export interface PlanPriorityOffersInput {
  readonly businessDate: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly snapshots: readonly ProductSnapshotPlan[];
  readonly waitTickets: readonly WaitTicket[];
  readonly existingOffers: readonly DailyPriorityOffer[];
  offerId(ticketId: string): string;
}

/**
 * Plans the temporary 08:00 holds one unit per store per round. Persisting the
 * returned offers is intentionally left to the caller's transaction.
 */
export function planPriorityOffers(input: PlanPriorityOffersInput): readonly DailyPriorityOffer[] {
  const committedByProduct = new Map<string, number>();
  for (const offer of input.existingOffers) {
    const committed =
      offer.status === 'CONFIRMED'
        ? offer.confirmedQuantity
        : offer.status === 'PENDING' && offer.expiresAt > input.createdAt
          ? offer.offeredQuantity
          : 0;
    committedByProduct.set(
      offer.productId,
      (committedByProduct.get(offer.productId) ?? 0) + committed,
    );
  }
  const availableByProduct = new Map(
    input.snapshots.map((snapshot) => [
      snapshot.productId,
      Math.max(0, snapshot.availableQuantity - (committedByProduct.get(snapshot.productId) ?? 0)),
    ]),
  );
  const ticketsByProduct = new Map<string, WaitTicket[]>();

  for (const ticket of input.waitTickets) {
    if (ticket.status !== 'ACTIVE' || ticket.openQuantity <= ticket.reservedQuantity) continue;
    const group = ticketsByProduct.get(ticket.productId) ?? [];
    group.push(ticket);
    ticketsByProduct.set(ticket.productId, group);
  }

  const planned: DailyPriorityOffer[] = [];
  for (const [productId, rawTickets] of [...ticketsByProduct].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    let available = availableByProduct.get(productId) ?? 0;
    const tickets = rawTickets.sort(
      (left, right) =>
        left.originalRequestedAt.localeCompare(right.originalRequestedAt) ||
        left.storeId.localeCompare(right.storeId) ||
        left.id.localeCompare(right.id),
    );
    const quantities = new Map(tickets.map((ticket) => [ticket.id, 0]));

    while (available > 0) {
      let granted = 0;
      for (const ticket of tickets) {
        if (available === 0) break;
        const alreadyOffered = quantities.get(ticket.id) ?? 0;
        const eligible = ticket.openQuantity - ticket.reservedQuantity;
        if (alreadyOffered >= eligible) continue;
        quantities.set(ticket.id, alreadyOffered + 1);
        available -= 1;
        granted += 1;
      }
      if (granted === 0) break;
    }

    for (const ticket of tickets) {
      const offeredQuantity = quantities.get(ticket.id) ?? 0;
      if (offeredQuantity === 0) continue;
      const offer = createDailyPriorityOffer(ticket, [...input.existingOffers, ...planned], {
        id: input.offerId(ticket.id),
        businessDate: input.businessDate,
        offeredQuantity,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
      planned.push(offer);
    }
  }

  return Object.freeze(planned);
}

export interface PlanProductAllocationInput {
  readonly allocationId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly policyVersion: string;
  readonly allocatedAt: string;
  readonly snapshot: ProductSnapshotPlan;
  readonly mergedRequests: readonly MergedDemand[];
  readonly waitTickets: readonly WaitTicket[];
  readonly priorityOffers: readonly DailyPriorityOffer[];
  readonly storeOrder: readonly string[];
  readonly startCursor: string | null;
}

export function planProductAllocation(input: PlanProductAllocationInput): AllocationResult {
  if (input.policyVersion !== ALLOCATION_POLICY_VERSION) {
    throw new Error(
      `Unsupported allocation policy ${input.policyVersion}; expected ${ALLOCATION_POLICY_VERSION}.`,
    );
  }
  const demands = buildAllocationDemands({
    sessionId: input.sessionId,
    mergedRequests: input.mergedRequests,
    waitTickets: input.waitTickets,
    priorityOffers: input.priorityOffers,
  }).filter((demand) => demand.productId === input.snapshot.productId);

  return allocateInventory({
    allocationId: input.allocationId,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    policyVersion: input.policyVersion,
    allocatedAt: input.allocatedAt,
    snapshot: createInventorySnapshot(input.snapshot),
    demands,
    storeOrder: input.storeOrder,
    startCursor: input.startCursor,
  });
}

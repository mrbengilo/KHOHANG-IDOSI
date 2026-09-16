import { invariant } from './errors.js';

export const ALLOCATION_POLICY_VERSION = 'idosi-round-robin-p0a-p3-v1' as const;

export const ALLOCATION_PRIORITIES = ['P0A', 'P0B', 'P1', 'P2', 'P3'] as const;
export type AllocationPriority = (typeof ALLOCATION_PRIORITIES)[number];
export type NewOrderPriority = Exclude<AllocationPriority, 'P0A'>;

/**
 * P0A is deliberately source-restricted. The other tiers are explicit business
 * classifications supplied by the application layer; request sequence never
 * changes them.
 */
export const ALLOCATION_PRIORITY_POLICY: Readonly<
  Record<
    AllocationPriority,
    Readonly<{
      rank: number;
      description: string;
      allowedSources: readonly AllocationDemandSource[];
    }>
  >
> = {
  P0A: {
    rank: 0,
    description: 'Previously waiting demand confirmed during its daily priority window',
    allowedSources: ['CONFIRMED_WAIT'],
  },
  P0B: {
    rank: 1,
    description: 'Explicit business tier P0B; never inferred from request sequence',
    allowedSources: ['ORDER_REQUEST', 'POLICY'],
  },
  P1: {
    rank: 2,
    description: 'Explicit business tier P1; never inferred from request sequence',
    allowedSources: ['ORDER_REQUEST', 'POLICY'],
  },
  P2: {
    rank: 3,
    description: 'Explicit business tier P2; never inferred from request sequence',
    allowedSources: ['ORDER_REQUEST', 'POLICY'],
  },
  P3: {
    rank: 4,
    description: 'Explicit business tier P3; never inferred from request sequence',
    allowedSources: ['ORDER_REQUEST', 'POLICY'],
  },
};

export type AllocationDemandSource = 'CONFIRMED_WAIT' | 'ORDER_REQUEST' | 'POLICY';

export function isAllocationPriority(value: string): value is AllocationPriority {
  return (ALLOCATION_PRIORITIES as readonly string[]).includes(value);
}

export function isNewOrderPriority(value: string): value is NewOrderPriority {
  return value !== 'P0A' && isAllocationPriority(value);
}

export function assertDemandSourceAllowed(
  priority: AllocationPriority,
  source: AllocationDemandSource,
): void {
  invariant(
    ALLOCATION_PRIORITY_POLICY[priority].allowedSources.includes(source),
    'INVALID_ARGUMENT',
    `${source} is not allowed to claim ${priority}`,
    { priority, source },
  );
}

export function comparePriority(left: AllocationPriority, right: AllocationPriority): number {
  return ALLOCATION_PRIORITY_POLICY[left].rank - ALLOCATION_PRIORITY_POLICY[right].rank;
}

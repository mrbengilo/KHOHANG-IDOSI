import { z } from 'zod';

/** Ordered allocation tiers; lower tiers are evaluated before higher tiers. */
export const AllocationPrioritySchema = z.enum(['P0A', 'P0B', 'P1', 'P2', 'P3']);
export type AllocationPriority = z.infer<typeof AllocationPrioritySchema>;

/** P0A is reserved for a confirmed prior wait ticket, never for a new request. */
export const NewOrderPrioritySchema = z.enum(['P0B', 'P1', 'P2', 'P3']);
export type NewOrderPriority = z.infer<typeof NewOrderPrioritySchema>;

export const AllocationReasonCodeSchema = z.enum([
  'WAIT_TICKET_ACCEPTED',
  'OPENING_STOCK_SHORTAGE',
  'STORE_NO_OPENING_STOCK',
  'NORMAL_REQUEST',
  'MANUAL_POLICY_OVERRIDE',
]);
export type AllocationReasonCode = z.infer<typeof AllocationReasonCodeSchema>;

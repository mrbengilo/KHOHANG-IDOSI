import { z } from 'zod';
import { EntityIdSchema } from './common.js';
import { OrderSessionSchema } from './orders.js';

export const PrepareOrderingRequestSchema = z.object({ storeId: EntityIdSchema }).strict();
export const OrderingContextSchema = z
  .object({
    session: OrderSessionSchema,
    usedSlots: z.number().int().nonnegative(),
    maxSlots: z.literal(2),
  })
  .strict();
export type OrderingContext = z.infer<typeof OrderingContextSchema>;
export const OrderingContextResponseSchema = z.object({ data: OrderingContextSchema }).strict();

/** The submission window spans midnight; the snapshot/allocation date stays in Vietnam time. */
export function nextOrderingWindow(now: Date, snapshotTime: string, cutoffTime: string) {
  const localDate = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let businessDate = localDate;
  if (now >= new Date(`${localDate}T${snapshotTime.slice(0, 5)}:00+07:00`)) {
    businessDate = new Date(Date.parse(`${localDate}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
  }
  return {
    businessDate,
    requestOpensAt: now.toISOString(),
    requestClosesAt: new Date(`${businessDate}T${snapshotTime.slice(0, 5)}:00+07:00`).toISOString(),
    allocationStartsAt: new Date(
      `${businessDate}T${cutoffTime.slice(0, 5)}:00+07:00`,
    ).toISOString(),
  };
}

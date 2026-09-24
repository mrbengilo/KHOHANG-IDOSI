import { and, eq, or, sql, type SQL } from 'drizzle-orm';

import { allocationLines, dailyPriorityOffers } from './schema.js';

/**
 * An accepted priority offer keeps the status `accepted` after the 09:00 run has allocated
 * it. Only offers that are still being answered, or accepted but not yet allocated, hold a
 * claim on their wait ticket; an allocated one is history and must not block the ticket.
 */
export function livePriorityOfferCondition(): SQL {
  return or(
    eq(dailyPriorityOffers.status, 'offered'),
    and(
      eq(dailyPriorityOffers.status, 'accepted'),
      sql`not exists (select 1 from ${allocationLines} where ${allocationLines.priorityOfferId} = ${dailyPriorityOffers.id})`,
    ),
  )!;
}

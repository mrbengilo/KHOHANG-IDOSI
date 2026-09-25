import type { ListStoreBagOpeningsQuery, StoreBagOpening } from '@idosi/contracts';
import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
import type { PageResult } from './store-inventory-operations.js';

/** One opening per physical bag. Audit snapshots win; legacy unknowns remain unknown.
 * Lateral lookups use the entity/time and bag/time indexes, never an application audit scan.
 */
export function openingHistoryQuery(
  query: ListStoreBagOpeningsQuery,
  storeIds?: readonly string[],
) {
  const conditions = [sql`true`];
  // Transfers create a new destination bag; the source bag retains its store identity.
  const bagScope =
    storeIds === undefined
      ? sql`true`
      : storeIds.length
        ? sql`b.store_id in (${sql.join(
            storeIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
  if (query.storeId) conditions.push(sql`h."storeId" = ${query.storeId}::uuid`);
  if (storeIds !== undefined)
    conditions.push(
      storeIds.length
        ? sql`h."storeId" in (${sql.join(
            storeIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`,
    );
  if (query.productId) conditions.push(sql`h."productId" = ${query.productId}::uuid`);
  if (query.bagCode)
    conditions.push(
      sql`h."bagCode" ilike ${'%' + query.bagCode.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%'}`,
    );
  if (query.from) conditions.push(sql`h."openedAt" >= ${query.from}::timestamptz`);
  if (query.to) conditions.push(sql`h."openedAt" < ${query.to}::timestamptz`);
  return sql`with history as (
    select coalesce(a.id, l.id, b.id) as id, b.id as "bagId",
      coalesce(a.before->>'displayCode', b.display_code, a.before->>'bagCode') as "bagCode",
      coalesce((a.before->>'storeId')::uuid, l.store_id, b.store_id) as "storeId",
      coalesce((a.before->>'productId')::uuid, l.product_id) as "productId",
      coalesce(a.before->>'currentWeightKg', l.weight_before_kg::text) as "weightBeforeKg",
      a.after->>'normalSaleAppliedKg' as "normalSaleAppliedKg",
      coalesce(a.after->>'currentWeightKg', l.weight_after_kg::text) as "weightAfterKg",
      coalesce(a.actor_user_id, l.actor_user_id) as "actorAccountId",
      upper(coalesce(a.actor_role, source_audit.actor_role)::text) as "actorRole",
      coalesce((a.after->>'openedAt')::timestamptz, a.created_at, b.opened_at) as "openedAt",
      case when a.id is not null then 'BUTTON'
        when l.source_type = 'store_sorting_event' then 'SORTING'
        when l.source_type = 'store_transfer_dispatch' then 'TRANSFER'
        when l.source_type = 'store_outbound' then 'OUTBOUND'
        when l.source_type like 'idosi_normal_sale%' then 'IDOSI' else 'LEGACY' end as source,
      case b.status::text when 'opened' then 'OPEN' when 'depleted' then 'EMPTY'
        else upper(b.status::text) end as "currentStatus"
    from store_inventory_bags b
    left join lateral (
      select id, "before", "after", actor_user_id, actor_role, created_at from audit_logs
      where entity_type = 'store_inventory_bag' and entity_id = b.id
        and action = 'STORE_INVENTORY_BAG_OPENED'
      order by created_at, id limit 1
    ) a on true
    left join lateral (
      select id, store_id, product_id, weight_before_kg, weight_after_kg, actor_user_id, source_type, source_id
      from store_inventory_ledger_entries
      where store_inventory_bag_id = b.id and occurred_at = b.opened_at
        and source_type in ('store_sorting_event', 'store_transfer_dispatch', 'store_outbound', 'idosi_normal_sale', 'idosi_normal_sale_correction')
      order by occurred_at, id limit 1
    ) l on a.id is null
    left join lateral (
      -- These writers verify the store actor before snapshotting its role. Match the
      -- exact source event AND ledger actor, never a nearby audit or today's role.
      select actor_role from audit_logs
      where entity_id = l.source_id and actor_user_id = l.actor_user_id
        and ((l.source_type = 'store_sorting_event' and entity_type = 'store_sorting_event'
          and action = 'STORE_SORTING_RECORDED')
          or (l.source_type = 'store_transfer_dispatch' and entity_type = 'store_transfer'
          and action = 'STORE_TRANSFER_DISPATCHED'))
      order by created_at, id limit 1
    ) source_audit on a.id is null
    where ${bagScope} and (b.opened_at is not null or a.id is not null or b.status = 'opened')
  ), filtered as (select * from history h where ${sql.join(conditions, sql` and `)})`;
}

export async function listStoreBagOpenings(
  database: Database,
  query: ListStoreBagOpeningsQuery,
  storeIds?: readonly string[],
): Promise<PageResult<StoreBagOpening>> {
  const base = openingHistoryQuery(query, storeIds);
  const [countResult, rows] = await Promise.all([
    database.execute<{ total: string }>(sql`${base} select count(*)::text as total from filtered`),
    database.execute<StoreBagOpening & Record<string, unknown>>(sql`${base}
      select page.*, nullif(btrim(u.display_name), '') as "actorDisplayName"
      from (select * from filtered order by "openedAt" desc nulls last, id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}) page
      left join users u on u.id = page."actorAccountId"
      order by page."openedAt" desc nulls last, page.id desc`),
  ]);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);
  return {
    data: rows.rows.map((row) => ({
      ...row,
      openedAt: row.openedAt === null ? null : new Date(row.openedAt).toISOString(),
    })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / query.pageSize),
    },
  };
}

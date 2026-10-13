import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  db,
  listSupplierCommitments,
  listSupplierReconciliationSummary,
  loadSupplierAllocationCaps,
  withSerializableTransaction,
} from '../src/index.js';
import { createSupplierFixture } from './fixtures/supplier.js';

/**
 * Opt-in (RUN_PERF_TESTS=1 with RUN_POSTGRES_TESTS=1): 100 reconciled SKUs × 20 stores = 2,000
 * live holds with 10,000 B order events and links. Records p50/p95 of the read models and the
 * worker cap; budgets are generous ceilings, the measured numbers go to the release evidence.
 */
const describePerf =
  process.env.RUN_POSTGRES_TESTS === '1' && process.env.RUN_PERF_TESTS === '1'
    ? describe
    : describe.skip;

async function measure(label: string, runs: number, task: () => Promise<unknown>) {
  const durations: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await task();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(runs * 0.5)]!;
  const p95 = durations[Math.min(runs - 1, Math.floor(runs * 0.95))]!;
  console.log(`[perf] ${label}: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=${runs})`);
  return { p50, p95 };
}

describePerf('supplier reconciliation read models at scale', () => {
  afterAll(() => closeDatabase());

  it('summary, commitment pages and worker caps stay within budget', async () => {
    const fx = await createSupplierFixture();
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const date = '2026-10-12';
    // Bulk fixture in SQL: 20 stores, 100 products, one session/run with a line per pair.
    await db.execute(sql`
      with g as (select id as group_id from store_groups limit 1)
      insert into stores (code, name, group_id)
      select 'PERF-' || ${tag} || '-' || n, 'Perf store ' || n, g.group_id
      from generate_series(1, 20) n, g`);
    await db.execute(sql`
      insert into products (sku, slug, name)
      select 'PERF-' || ${tag} || '-' || n, 'perf-' || ${tag} || '-' || n, 'Perf product ' || n
      from generate_series(1, 100) n`);
    await db.execute(sql`
      insert into supplier_source_products (source_id, product_id, created_by_user_id)
      select ${fx.sourceId}::uuid, p.id, ${fx.adminId}::uuid from products p
      where p.sku like ${`PERF-${tag}-%`}`);
    const [session] = (
      await db.execute<{ id: string }>(sql`
        insert into order_sessions (code, kind, business_date, status, inventory_snapshot_due_at,
          request_deadline_at, policy_version, created_by_user_id, deleted_at)
        values (${`PERF-${tag}`}, 'manual', ${date}, 'completed', ${`${date}T08:00:00+07:00`},
          ${`${date}T09:00:00+07:00`}, 'idosi-round-robin-p0a-p3-v1', ${fx.adminId}::uuid, now())
        returning id`)
    ).rows;
    const [snapshot] = (
      await db.execute<{ id: string }>(sql`
        insert into inventory_snapshots (order_session_id, business_date, snapshot_type, status,
          captured_at, completed_at, balance_version)
        values (${session!.id}::uuid, ${date}, 'manual', 'completed', now(), now(), 0)
        returning id`)
    ).rows;
    const [run] = (
      await db.execute<{ id: string }>(sql`
        insert into allocation_runs (order_session_id, inventory_snapshot_id, run_number, status,
          policy_version, idempotency_key)
        values (${session!.id}::uuid, ${snapshot!.id}::uuid, 1, 'completed',
          'idosi-round-robin-p0a-p3-v1', ${randomUUID()})
        returning id`)
    ).rows;
    await db.execute(sql`
      insert into order_requests (order_session_id, store_id, request_number, status, submitted_at,
        requested_by_user_id)
      select ${session!.id}::uuid, s.id, 1, 'allocated', now(), ${fx.adminId}::uuid
      from stores s where s.code like ${`PERF-${tag}-%`}`);
    await db.execute(sql`
      insert into order_request_items (order_request_id, product_id, requested_quantity)
      select r.id, p.id, 10 from order_requests r
      join products p on p.sku like ${`PERF-${tag}-%`}
      where r.order_session_id = ${session!.id}::uuid`);
    await db.execute(sql`
      insert into merged_orders (order_session_id, store_id, status, request_count)
      select ${session!.id}::uuid, s.id, 'allocated', 1 from stores s
      where s.code like ${`PERF-${tag}-%`}`);
    await db.execute(sql`
      insert into merged_order_items (merged_order_id, product_id, requested_quantity, priority_level)
      select m.id, p.id, 10, 'P1' from merged_orders m
      join products p on p.sku like ${`PERF-${tag}-%`}
      where m.order_session_id = ${session!.id}::uuid`);
    await db.execute(sql`
      insert into merged_order_sources (merged_order_item_id, order_request_item_id, requested_quantity)
      select mi.id, ri.id, 10 from merged_order_items mi
      join merged_orders m on m.id = mi.merged_order_id
      join order_requests r on r.order_session_id = m.order_session_id and r.store_id = m.store_id
      join order_request_items ri on ri.order_request_id = r.id and ri.product_id = mi.product_id
      where m.order_session_id = ${session!.id}::uuid`);
    await db.execute(sql`
      insert into allocation_lines (allocation_run_id, merged_order_id, store_id, product_id,
        order_request_item_id, priority_level, round_number, sequence_in_round, requested_quantity,
        allocated_quantity, status, reason_code)
      select ${run!.id}::uuid, m.id, m.store_id, ri.product_id, ri.id, 'P1', 1,
        row_number() over (), 10, 10, 'allocated', 'PERF'
      from merged_orders m
      join order_requests r on r.order_session_id = m.order_session_id and r.store_id = m.store_id
      join order_request_items ri on ri.order_request_id = r.id
      where m.order_session_id = ${session!.id}::uuid`);
    await db.execute(sql`
      insert into reservations (product_id, store_id, allocation_line_id, quantity)
      select l.product_id, l.store_id, l.id, 10 from allocation_lines l
      where l.allocation_run_id = ${run!.id}::uuid`);
    await db.execute(sql`
      insert into allocation_result_decisions (allocation_run_id, order_session_id, store_id, status,
        granted_quantity, responded_at, responded_by_user_id)
      select ${run!.id}::uuid, ${session!.id}::uuid, s.id, 'accepted', 1000, now(), ${fx.adminId}::uuid
      from stores s where s.code like ${`PERF-${tag}-%`}`);
    // Ledger: 20,000 bags on hand and reserved per SKU group (opening + hold, one entry each).
    await db.execute(sql`
      insert into warehouse_balances (product_id, on_hand_quantity, reserved_quantity, version)
      select p.id, 300, 200, 2 from products p where p.sku like ${`PERF-${tag}-%`}`);
    await db.execute(sql`
      insert into warehouse_ledger_entries (product_id, event_type, on_hand_delta, reserved_delta,
        on_hand_after, reserved_after, source_type, source_id)
      select p.id, 'opening_balance', 300, 0, 300, 0, 'perf_opening', gen_random_uuid()
      from products p where p.sku like ${`PERF-${tag}-%`}`);
    await db.execute(sql`
      insert into warehouse_ledger_entries (product_id, event_type, on_hand_delta, reserved_delta,
        on_hand_after, reserved_after, source_type, source_id)
      select p.id, 'reservation', 0, 200, 300, 200, 'allocation_run', ${run!.id}::uuid
      from products p where p.sku like ${`PERF-${tag}-%`}`);
    // 10,000 B order events (5 per hold, 1 bag each) and their links.
    const [batch] = (
      await db.execute<{ id: string }>(sql`
        insert into supplier_event_batches (source_id, kind, external_ref, occurred_at,
          created_by_user_id, idempotency_key, request_hash)
        values (${fx.sourceId}::uuid, 'order', ${`PERF-${tag}`}, now() - interval '1 minute',
          ${fx.adminId}::uuid, ${randomUUID()}, 'perf')
        returning id`)
    ).rows;
    await db.execute(sql`
      insert into supplier_external_events (id, batch_id, source_id, product_id, kind, quantity,
        external_ref, external_line_ref, store_id, occurred_at, coverage, created_by_user_id)
      select gen_random_uuid(), ${batch!.id}::uuid, ${fx.sourceId}::uuid, r.product_id, 'order', 1,
        ${`PERF-${tag}`}, r.id || '-' || n, r.store_id, now() - interval '1 minute', 'open',
        ${fx.adminId}::uuid
      from reservations r cross join generate_series(1, 5) n
      join allocation_lines l on l.id = r.allocation_line_id
      where l.allocation_run_id = ${run!.id}::uuid`);
    await db.execute(sql`
      insert into supplier_order_source_links (event_id, allocation_line_id, reservation_id,
        store_id, product_id, quantity)
      select e.id, r.allocation_line_id, r.id, r.store_id, r.product_id, 1
      from supplier_external_events e
      join reservations r on e.external_line_ref like r.id || '-%'
      where e.batch_id = ${batch!.id}::uuid`);
    const [counts] = (
      await db.execute<{ holds: string; links: string }>(sql`
        select (select count(*) from reservations r join allocation_lines l on l.id = r.allocation_line_id
                where l.allocation_run_id = ${run!.id}::uuid) as holds,
               (select count(*) from supplier_order_source_links k join supplier_external_events e
                on e.id = k.event_id where e.batch_id = ${batch!.id}::uuid) as links`)
    ).rows;
    expect(Number(counts!.holds)).toBe(2_000);
    expect(Number(counts!.links)).toBe(10_000);
    const summary = await measure('summary 100 SKU', 15, () =>
      listSupplierReconciliationSummary(db, {
        filter: 'ALL',
        page: 1,
        pageSize: 100,
        search: `PERF-${tag}`,
      }),
    );
    const commitments = await measure('commitments page 1 (2,000 holds)', 15, () =>
      listSupplierCommitments(db, { filter: 'ORDERABLE', page: 1, pageSize: 20 }),
    );
    const caps = await measure('worker caps (all mapped SKUs)', 15, () =>
      withSerializableTransaction(db, (tx) => loadSupplierAllocationCaps(tx)),
    );
    const result = await listSupplierReconciliationSummary(db, {
      filter: 'ALL',
      page: 1,
      pageSize: 100,
      search: `PERF-${tag}`,
    });
    expect(result.totalItems).toBe(100);
    // Each SKU: 20 holds × 10 bags, 5 ordered per hold → 100 ordered, 100 not yet ordered.
    expect(result.data.every((row) => row.position.unorderedReservedQuantity === 100)).toBe(true);
    expect(result.data.every((row) => row.position.orderedReservedQuantity === 100)).toBe(true);
    // Ceilings, not targets: they catch an N+1 or full-history scan regression.
    expect(summary.p95).toBeLessThan(2_000);
    expect(commitments.p95).toBeLessThan(2_000);
    expect(caps.p95).toBeLessThan(2_000);
  }, 180_000);
});

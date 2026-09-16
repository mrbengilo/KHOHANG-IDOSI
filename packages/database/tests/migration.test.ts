import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0000_initial.sql', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
const storeOperationsSource = readFileSync(
  new URL('../src/store-operations.ts', import.meta.url),
  'utf8',
);
const journal = JSON.parse(
  readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { tag: string; breakpoints: boolean }[] };
const snapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0000_snapshot.json', import.meta.url), 'utf8'),
) as { tables: Record<string, { name: string }> };

const requiredTables = [
  'allocation_lines',
  'allocation_runs',
  'audit_logs',
  'daily_priority_offers',
  'htkd_assignments',
  'idempotency_keys',
  'inventory_snapshot_items',
  'inventory_snapshots',
  'merged_order_items',
  'merged_order_sources',
  'merged_orders',
  'order_request_items',
  'order_requests',
  'order_sessions',
  'outbound_bag_picks',
  'outbound_request_lines',
  'outbound_requests',
  'products',
  'receipt_bag_weights',
  'receipt_costs',
  'receipt_items',
  'receipts',
  'reservations',
  'sessions',
  'store_groups',
  'store_inventory_bags',
  'store_inventory_ledger_entries',
  'store_outbounds',
  'store_receipt_bags',
  'store_receipt_lines',
  'store_receipts',
  'stores',
  'users',
  'wait_tickets',
  'warehouse_balances',
  'warehouse_ledger_entries',
] as const;

describe('initial migration invariants', () => {
  it.each(requiredTables)('creates %s', (tableName) => {
    expect(migration).toMatch(new RegExp(`CREATE TABLE "?${tableName}"?\\s*\\(`));
  });

  it('keeps the Drizzle snapshot, journal, and SQL baseline in sync', () => {
    const sqlTables = [...migration.matchAll(/CREATE TABLE "?([a-z_]+)"?\s*\(/g)]
      .map((match) => match[1])
      .sort();
    const snapshotTables = Object.values(snapshot.tables)
      .map((table) => table.name)
      .sort();

    expect(sqlTables).toEqual([...requiredTables].sort());
    expect(snapshotTables).toEqual([...requiredTables].sort());
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      tag: '0000_initial',
      breakpoints: true,
    });
  });

  it('enforces at most two request slots for each store and session', () => {
    expect(migration).toContain('"order_requests_max_two_slots"');
    expect(migration).toContain('"order_requests_session_store_slot_uidx"');
    expect(migration).toMatch(/"request_number" BETWEEN 1 AND 2/);
  });

  it('defaults new requests to P1 and preserves per-store merged scope', () => {
    expect(migration).toMatch(/"priority_level" "priority_level" DEFAULT 'P1' NOT NULL/);
    expect(migration).toContain('"order_request_items_priority_not_p0a"');
    expect(migration).toContain('"merged_orders_session_store_version_uidx"');
    expect(migration).toContain('merged_order_sources_validate_scope');
  });

  it('serializes new order items against one active wait per store/product', () => {
    expect(migration).toContain('"wait_tickets_one_active_store_product_uidx"');
    expect(migration).toContain('order_request_items_block_active_wait');
    expect(migration).toContain('wait_tickets_lock_active_transition');
    expect(migration).toContain('store-product-wait:');
  });

  it('normalizes every active unconfirmed wait to P0B', () => {
    expect(migration).toMatch(
      /CREATE TABLE "wait_tickets"[\s\S]*"priority_level" "priority_level" DEFAULT 'P0B' NOT NULL/,
    );
    expect(schemaSource).toContain("priorityLevelEnum('priority_level').notNull().default('P0B')");
    expect(storeOperationsSource).not.toContain("priorityLevel: 'P3'");
    expect(storeOperationsSource).toContain("priorityLevel: 'P0B'");
  });

  it('binds P0A allocations to accepted wait offers and otherwise requires merged provenance', () => {
    expect(migration).toContain('"allocation_lines_exactly_one_source"');
    expect(migration).toContain('"allocation_lines_priority_source"');
    expect(migration).toContain('"allocation_lines_order_has_merged_order"');
    expect(migration).toContain('"allocation_lines_priority_offer_uidx"');
    expect(migration).toContain('allocation_lines_validate_scope');
    expect(migration).toContain('o.business_date <= snapshot_business_date');
    expect(migration).toContain("o.status = 'accepted'");
  });

  it('allows a weekly session to capture one opening snapshot on each business day', () => {
    expect(migration).toMatch(
      /"inventory_snapshots_session_day_type_uidx"[\s\S]*"order_session_id","business_date","snapshot_type"/,
    );
    expect(migration).not.toContain('inventory_snapshots_session_type_uidx');
  });

  it('uses exact database and Drizzle types for VND and gram-precision weights', () => {
    const vndColumns = [...migration.matchAll(/"[a-z_]+_vnd" bigint\b/gi)];
    const weightColumns = [...migration.matchAll(/"[a-z_]*weight_kg" numeric\(14, 3\)/gi)];

    expect(vndColumns.length).toBeGreaterThanOrEqual(20);
    expect(weightColumns.length).toBeGreaterThanOrEqual(10);
    expect(migration).not.toMatch(/"[a-z_]+_vnd" (?:real|double precision|numeric)/i);
    expect(schemaSource).not.toContain("mode: 'number'");
    expect(schemaSource).not.toContain('.default(0n)');
  });

  it('persists store receipt, inventory ledger, and store outbound workflows separately', () => {
    for (const name of [
      'store_receipts',
      'store_receipt_lines',
      'store_receipt_bags',
      'store_inventory_bags',
      'store_inventory_ledger_entries',
      'store_outbounds',
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE "${name}"`));
    }
    expect(migration).not.toContain('store_receipt_lines_received_price');
    expect(migration).toContain('store_receipts_validate_finalization');
    expect(migration).toContain('store_outbounds_validate_review');
  });

  it('uses exact case-sensitive account identity and one non-deleted STORE account per store', () => {
    expect(migration).toContain('"users_email_uidx"');
    expect(migration).not.toContain('users_email_lower_uidx');
    expect(migration).toContain('"users_one_store_account_uidx"');
    expect(migration).toMatch(/"role" = 'store' AND "users"\."deleted_at" IS NULL/);
  });

  it('revokes sessions when store access or HTKD assignment is revoked', () => {
    expect(migration).toContain('stores_disable_users_after_deactivation');
    expect(migration).toContain('users_revoke_sessions_after_security_change');
    expect(migration).toContain('htkd_assignments_revoke_sessions');
    expect(migration).toContain('token_version = token_version + 1');
  });

  it('increments optimistic versions exactly once', () => {
    for (const table of [
      'stores',
      'products',
      'warehouse_balances',
      'order_sessions',
      'outbound_requests',
      'receipts',
      'store_receipts',
      'store_inventory_bags',
      'store_outbounds',
    ]) {
      expect(migration).toContain(`${table}_set_updated_at_and_bump_version`);
    }
    expect(migration).toContain('NEW.version := OLD.version + 1');
  });

  it('makes warehouse/store ledgers and audit rows immutable', () => {
    expect(migration).toContain('warehouse_ledger_entries_immutable');
    expect(migration).toContain('store_inventory_ledger_entries_immutable');
    expect(migration).toContain('audit_logs_immutable');
  });

  it('blocks hard deletion of business documents', () => {
    const protectedTables = [
      'order_sessions',
      'order_requests',
      'merged_orders',
      'wait_tickets',
      'inventory_snapshots',
      'allocation_runs',
      'reservations',
      'receipts',
      'outbound_requests',
      'store_receipts',
      'store_inventory_bags',
      'store_outbounds',
    ] as const;

    for (const table of protectedTables) {
      expect(migration).toContain(`CREATE TRIGGER ${table}_no_hard_delete`);
    }
  });
});

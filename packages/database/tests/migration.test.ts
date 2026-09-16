import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0000_initial.sql', import.meta.url), 'utf8');

const requiredTables = [
  'users',
  'sessions',
  'stores',
  'htkd_assignments',
  'products',
  'warehouse_balances',
  'warehouse_ledger_entries',
  'order_sessions',
  'order_requests',
  'order_request_items',
  'merged_orders',
  'wait_tickets',
  'daily_priority_offers',
  'inventory_snapshots',
  'allocation_runs',
  'allocation_lines',
  'reservations',
  'receipts',
  'receipt_items',
  'receipt_bag_weights',
  'receipt_costs',
  'store_inventory_bags',
  'outbound_requests',
  'outbound_request_lines',
  'audit_logs',
  'idempotency_keys',
] as const;

describe('initial migration invariants', () => {
  it.each(requiredTables)('creates %s', (tableName) => {
    expect(migration).toMatch(new RegExp(`CREATE TABLE ${tableName} \\(`));
  });

  it('enforces at most two request slots for each store and session', () => {
    expect(migration).toContain(
      'CONSTRAINT order_requests_max_two_slots CHECK (request_number BETWEEN 1 AND 2)',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX order_requests_session_store_slot_uidx ON order_requests(order_session_id, store_id, request_number)',
    );
  });

  it('allows only one active wait ticket per store and product', () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX wait_tickets_one_active_store_product_uidx ON wait_tickets(store_id, product_id) WHERE status = 'active' AND deleted_at IS NULL",
    );
  });

  it('uses exact database types for VND and weights', () => {
    const vndColumns = [...migration.matchAll(/\b[a-z_]+_vnd BIGINT\b/g)];
    const weightColumns = [...migration.matchAll(/\b[a-z_]+_weight_kg NUMERIC\(14,3\)/g)];

    expect(vndColumns.length).toBeGreaterThanOrEqual(10);
    expect(weightColumns.length).toBeGreaterThanOrEqual(6);
    expect(migration).not.toMatch(/\b[a-z_]+_vnd (?:REAL|DOUBLE PRECISION|NUMERIC)/);
  });

  it('makes ledger and audit rows immutable', () => {
    expect(migration).toContain('warehouse_ledger_entries_immutable BEFORE UPDATE OR DELETE');
    expect(migration).toContain('audit_logs_immutable BEFORE UPDATE OR DELETE');
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
    ] as const;

    for (const table of protectedTables) {
      expect(migration).toContain(
        `CREATE TRIGGER ${table}_no_hard_delete BEFORE DELETE ON ${table}`,
      );
    }
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0000_initial.sql', import.meta.url), 'utf8');
const forwardMigration = readFileSync(
  new URL('../migrations/0001_store_kind_product_conversions.sql', import.meta.url),
  'utf8',
);
const waitOfferMigration = readFileSync(
  new URL('../migrations/0002_wait_offer_history_index.sql', import.meta.url),
  'utf8',
);
const storeTransferMigration = readFileSync(
  new URL('../migrations/0004_store_transfers.sql', import.meta.url),
  'utf8',
);
const operationalSettingsMigration = readFileSync(
  new URL('../migrations/0003_operational_settings_versions.sql', import.meta.url),
  'utf8',
);
const schemaSource = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
const seedDataSource = readFileSync(new URL('../src/seed-data.ts', import.meta.url), 'utf8');
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
const forwardSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0001_snapshot.json', import.meta.url), 'utf8'),
) as {
  prevId: string;
  tables: Record<string, { name: string; columns: Record<string, unknown> }>;
  enums: Record<string, { values: string[] }>;
};
const waitOfferSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0002_snapshot.json', import.meta.url), 'utf8'),
) as {
  prevId: string;
  tables: Record<string, { indexes: Record<string, unknown> }>;
};
const operationalSettingsSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0003_snapshot.json', import.meta.url), 'utf8'),
) as {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
};
const storeTransferSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0004_snapshot.json', import.meta.url), 'utf8'),
) as {
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
  enums: Record<string, { values: string[] }>;
};

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
    expect(journal.entries).toHaveLength(5);
    expect(journal.entries[0]).toMatchObject({
      tag: '0000_initial',
      breakpoints: true,
    });
    expect(journal.entries[1]).toMatchObject({
      tag: '0001_store_kind_product_conversions',
      breakpoints: true,
    });
    expect(journal.entries[2]).toMatchObject({
      tag: '0002_wait_offer_history_index',
      breakpoints: true,
    });
    expect(journal.entries[3]).toMatchObject({
      tag: '0003_operational_settings_versions',
      breakpoints: true,
    });
    expect(journal.entries[4]).toMatchObject({
      tag: '0004_store_transfers',
      breakpoints: true,
    });
  });

  it('adds exact-cost transfer provenance and safe lifecycle constraints', () => {
    expect(storeTransferMigration).toContain(
      `CREATE TYPE "public"."store_transfer_status" AS ENUM('draft', 'in_transit', 'received', 'cancelled')`,
    );
    expect(storeTransferMigration).toContain('CREATE TABLE "store_transfers"');
    expect(storeTransferMigration).toContain('"weight_kg" numeric(14, 3) NOT NULL');
    expect(storeTransferMigration).toContain('"cost_vnd" bigint');
    expect(storeTransferMigration).toContain('"store_transfers_distinct_stores"');
    expect(storeTransferMigration).toContain('"store_transfers_dispatch_state"');
    expect(storeTransferMigration).toContain('"store_transfers_receive_state"');
    expect(storeTransferMigration).toContain('"store_inventory_bags_exactly_one_provenance"');
    expect(storeTransferMigration).toContain(
      '"store_inventory_bags_source_inventory_bag_id_store_inventory_bags_id_fk"',
    );
    expect(storeTransferMigration).toContain(
      '"store_inventory_bags_source_transfer_id_store_transfers_id_fk"',
    );
    expect(storeTransferSnapshot.prevId).toBe(operationalSettingsSnapshot.id);
    expect(storeTransferSnapshot.enums['public.store_transfer_status']?.values).toEqual([
      'draft',
      'in_transit',
      'received',
      'cancelled',
    ]);
    expect(storeTransferSnapshot.tables).toHaveProperty('public.store_transfers');
    expect(storeTransferSnapshot.tables['public.store_inventory_bags']?.columns).toHaveProperty(
      'source_transfer_id',
    );
  });

  it('indexes priority-offer history without losing the migration snapshot chain', () => {
    expect(waitOfferMigration).toContain('"daily_priority_offers_wait_history_idx"');
    expect(waitOfferMigration).toContain('("wait_ticket_id", "created_at")');
    expect(schemaSource).toContain("index('daily_priority_offers_wait_history_idx')");
    expect(waitOfferSnapshot.prevId).toBe('37fb48c4-d8ab-48e1-aaa8-0059998d5aac');
    expect(
      waitOfferSnapshot.tables['public.daily_priority_offers']?.indexes[
        'daily_priority_offers_wait_history_idx'
      ],
    ).toBeDefined();
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

  it('requires relational provenance for every wait ticket and daily offer', () => {
    expect(migration).toMatch(
      /CREATE TABLE "daily_priority_offers"[\s\S]*?"wait_ticket_id" uuid NOT NULL/,
    );
    expect(migration).toMatch(
      /CREATE TABLE "wait_tickets"[\s\S]*?"source_order_request_item_id" uuid NOT NULL/,
    );
    expect(schemaSource).toContain(
      "sourceOrderRequestItemId: uuid('source_order_request_item_id')",
    );
    expect(schemaSource).toContain("waitTicketId: uuid('wait_ticket_id')");
  });

  it('allows only full accepted offers and zero accepted quantity otherwise', () => {
    expect(migration).toContain('"daily_priority_offers_acceptance_quantity_consistent"');
    expect(migration).toContain(
      `"status" = 'accepted' AND "daily_priority_offers"."accepted_quantity" = "daily_priority_offers"."offered_quantity"`,
    );
    expect(migration).toContain(
      `"status" <> 'accepted' AND "daily_priority_offers"."accepted_quantity" = 0`,
    );
    expect(migration).toContain('"daily_priority_offers_response_timestamp"');
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

  it('allows the half-open request cutoff to equal the 08:00 snapshot instant', () => {
    expect(migration).toContain(
      '"order_sessions_deadline_order" CHECK ("order_sessions"."request_deadline_at" >= "order_sessions"."inventory_snapshot_due_at")',
    );
    expect(schemaSource).toContain(
      'sql`${table.requestDeadlineAt} >= ${table.inventorySnapshotDueAt}`',
    );
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

  it('makes ledgers, audit rows, and allocation provenance immutable', () => {
    for (const table of [
      'warehouse_ledger_entries',
      'store_inventory_ledger_entries',
      'audit_logs',
      'merged_order_items',
      'merged_order_sources',
      'allocation_lines',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION prevent_immutable_mutation\\(\\)`,
        ),
      );
    }
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

describe('operational settings migration', () => {
  it('creates immutable, versioned settings with safe operational constraints', () => {
    expect(operationalSettingsMigration).toContain('CREATE TABLE "operational_settings_versions"');
    expect(operationalSettingsMigration).toContain('"operational_settings_versions_version_uidx"');
    expect(operationalSettingsMigration).toContain(
      '"operational_settings_versions_cutoff_after_snapshot"',
    );
    expect(operationalSettingsMigration).toContain('"idosi_sync_interval_minutes" IN (15, 30)');
    expect(operationalSettingsMigration).toContain(
      'CREATE TRIGGER operational_settings_versions_immutable',
    );
    expect(operationalSettingsMigration).toContain("'Asia/Ho_Chi_Minh'");
    expect(operationalSettingsMigration).toContain("'08:00'");
    expect(operationalSettingsMigration).toContain("'09:00'");
    expect(schemaSource).toContain('export const operationalSettingsVersions = pgTable(');
    expect(operationalSettingsSnapshot.prevId).toBe('67f76077-c02e-4657-858f-6c753b546d57');
    expect(
      operationalSettingsSnapshot.tables['public.operational_settings_versions']?.columns,
    ).toHaveProperty('snapshot_time');
    expect(
      operationalSettingsSnapshot.tables['public.operational_settings_versions']?.indexes,
    ).toHaveProperty('operational_settings_versions_version_uidx');
  });
});

describe('store kind and product conversion migration', () => {
  it('adds and backfills the store kind enum from the canonical store group', () => {
    expect(forwardMigration).toContain(
      `CREATE TYPE "public"."store_kind" AS ENUM('retail', 'wholesale')`,
    );
    expect(forwardMigration).toContain(`SET "kind" = 'wholesale'::"store_kind"`);
    expect(forwardMigration).toContain(`AND "store_groups"."code" = 'SI_TINH'`);
    expect(schemaSource).toContain("storeKindEnum('kind').notNull().default('retail')");
  });

  it('stores exact versioned conversion ratios with bounded effective periods', () => {
    expect(forwardMigration).toMatch(/CREATE TABLE "product_conversions"/);
    expect(forwardMigration).toContain('"weight_kilograms" numeric(14, 3) NOT NULL');
    expect(forwardMigration).toContain('product_conversions_product_version_uidx');
    expect(forwardMigration).toContain('product_conversions_effective_period_valid');
    expect(forwardMigration).toContain('product_conversions_validate_period');
    expect(forwardMigration).toContain('product_conversions_protect_history');
    expect(schemaSource).toContain(
      "weightKilograms: numeric('weight_kilograms', { precision: 14, scale: 3 }).notNull()",
    );
    expect(forwardSnapshot.tables['public.product_conversions']?.columns).toHaveProperty(
      'weight_kilograms',
    );
    expect(forwardSnapshot.tables['public.stores']?.columns).toHaveProperty('kind');
    expect(forwardSnapshot.enums['public.store_kind']?.values).toEqual(['retail', 'wholesale']);
  });

  it('backfills all 25 approved ratios and preserves bedding as one item for three kg', () => {
    const conversionRows = [
      ...forwardMigration.matchAll(/^\s*\('[A-Z_]+', \d+, '\d+\.\d{3}'\),?$/gm),
    ];

    expect(conversionRows).toHaveLength(25);
    expect(forwardMigration).toContain(`('CHAN_GA_BAO_GOI_NEM_GON', 1, '3.000')`);
    expect(seedDataSource).not.toMatch(/1\s*\/\s*3/);
    expect(seedDataSource).not.toContain('itemsPerKg');
  });

  it('reconciles legacy catalog rows before conversion backfill without changing product IDs', () => {
    const renamePosition = forwardMigration.indexOf(`SET "sku" = 'DO_NAM'`);
    const conversionInsertPosition = forwardMigration.indexOf('INSERT INTO "product_conversions"');

    expect(renamePosition).toBeGreaterThan(-1);
    expect(renamePosition).toBeLessThan(conversionInsertPosition);
    expect(forwardMigration).toContain(`WHERE "sku" = 'DO_NAM_CUA_HANG'`);
    expect(forwardMigration).toContain(
      `WHERE "sku" IN ('THAP_CAM_TON', 'HANG_JEANS_TAI_CHE', 'HANG_THUN_TAI_CHE')`,
    );
    expect(forwardMigration).toContain(`SET "name" = 'KHÁCH SỈ'`);
  });
});

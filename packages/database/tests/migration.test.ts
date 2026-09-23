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
const idosiStatisticsMigration = readFileSync(
  new URL('../migrations/0005_idosi_statistics_snapshots.sql', import.meta.url),
  'utf8',
);
const storeGroupVersionMigration = readFileSync(
  new URL('../migrations/0006_store_group_versions.sql', import.meta.url),
  'utf8',
);
const currentMensProductNameMigration = readFileSync(
  new URL('../migrations/0010_current_mens_product_name.sql', import.meta.url),
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
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
  enums: Record<string, { values: string[] }>;
};
const idosiStatisticsSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0005_snapshot.json', import.meta.url), 'utf8'),
) as {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
};
const storeGroupVersionSnapshot = JSON.parse(
  readFileSync(new URL('../migrations/meta/0006_snapshot.json', import.meta.url), 'utf8'),
) as {
  id: string;
  prevId: string;
  tables: Record<
    string,
    { columns: Record<string, unknown>; checkConstraints: Record<string, unknown> }
  >;
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
  it('bounds legacy PN prefixes before the bigint cast and preserves nullable weight evidence', () => {
    const weightMigration = readFileSync(
      new URL('../migrations/0008_optional_supplier_weight.sql', import.meta.url),
      'utf8',
    );
    expect(weightMigration).toContain("substring(receipt_number FROM '^PN([0-9]{1,18})-')::bigint");
    expect(weightMigration).toContain("WHERE receipt_number ~ '^PN[0-9]{1,18}-'");
    expect(weightMigration).toContain('receipt_bag_weights_weight_presence');
    expect(weightMigration).not.toMatch(/UPDATE\s+"?receipt_bag_weights/i);
    const previous = JSON.parse(
      readFileSync(new URL('../migrations/meta/0007_snapshot.json', import.meta.url), 'utf8'),
    ) as { id: string };
    const current = JSON.parse(
      readFileSync(new URL('../migrations/meta/0008_snapshot.json', import.meta.url), 'utf8'),
    ) as { prevId: string };
    expect(current.prevId).toBe(previous.id);
  });
  it('adds nullable exact VAT without inventing historical amounts', () => {
    const vatMigration = readFileSync(
      new URL('../migrations/0007_receipt_vat.sql', import.meta.url),
      'utf8',
    );
    expect(vatMigration).toContain('ADD COLUMN "vat_amount_vnd" bigint');
    expect(vatMigration).toContain('ADD CONSTRAINT "receipts_vat_valid"');
    expect(vatMigration).not.toMatch(/UPDATE\s+"?receipts/i);
    const vatSnapshot = JSON.parse(
      readFileSync(new URL('../migrations/meta/0007_snapshot.json', import.meta.url), 'utf8'),
    ) as { prevId: string };
    expect(vatSnapshot.prevId).toBe(storeGroupVersionSnapshot.id);
  });
  it('adds the wholesale role without using it in the same transaction', () => {
    const roleMigration = readFileSync(
      new URL('../migrations/0011_wholesale_account_role.sql', import.meta.url),
      'utf8',
    );
    expect(roleMigration).toContain(`ALTER TYPE "public"."user_role" ADD VALUE`);
    expect(roleMigration).toContain(`'wholesale'`);
    // PostgreSQL refuses a new enum label inside the transaction that created it, so this
    // migration must not read or write the value it adds.
    expect(roleMigration).not.toMatch(/INSERT|UPDATE|SELECT/i);
  });

  it('keeps partner stock inside the single-provenance rule for store inventory', () => {
    const partnerMigration = readFileSync(
      new URL('../migrations/0012_store_partner_inbound.sql', import.meta.url),
      'utf8',
    );
    for (const table of [
      'store_partner_inbounds',
      'store_partner_inbound_lines',
      'store_partner_inbound_bags',
    ]) {
      expect(partnerMigration).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    }
    expect(partnerMigration).toContain(
      'ALTER TABLE "store_inventory_bags" ADD COLUMN "source_partner_inbound_bag_id" uuid',
    );
    // Exactly one of receipt, transfer or partner provenance, never none and never two.
    expect(partnerMigration).toContain(
      'DROP CONSTRAINT "store_inventory_bags_exactly_one_provenance"',
    );
    expect(partnerMigration).toMatch(
      /\("source_store_receipt_bag_id" IS NOT NULL\)::integer \+ \("source_transfer_id" IS NOT NULL\)::integer \+ \("source_partner_inbound_bag_id" IS NOT NULL\)::integer\) = 1/,
    );
    expect(partnerMigration).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });

  it('adds the new reasons and piece count while preserving historical rows', () => {
    const reasonsMigration = readFileSync(
      new URL('../migrations/0016_store_outbound_reasons.sql', import.meta.url),
      'utf8',
    );
    const pieceCountMigration = readFileSync(
      new URL('../migrations/0017_store_outbound_piece_count.sql', import.meta.url),
      'utf8',
    );
    for (const reason of ['sale_kg', 'sale_piece', 'cancel']) {
      expect(reasonsMigration).toContain(`ADD VALUE IF NOT EXISTS '${reason}'`);
    }
    expect(reasonsMigration).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(pieceCountMigration).toContain('ADD COLUMN "piece_count" integer');
    expect(pieceCountMigration).toContain('store_outbounds_piece_count_matches_reason');
    expect(pieceCountMigration).not.toMatch(/UPDATE|DELETE/i);
  });

  it('records weighed bags without guessing historical transfers', () => {
    const weighedBagsMigration = readFileSync(
      new URL('../migrations/0020_weighed_dispatch_bags.sql', import.meta.url),
      'utf8',
    );
    expect(weighedBagsMigration).toContain(
      'ALTER TABLE sorted_sale_transfers ADD COLUMN bag_weights_kg numeric(14,3)[];',
    );
    expect(weighedBagsMigration).toContain('CREATE TABLE store_charity_exports');
    expect(weighedBagsMigration).toContain("assign_document_code('export_number', 'PTT')");
    expect(weighedBagsMigration).not.toMatch(/UPDATE \w+ SET|DELETE FROM|DROP TABLE/i);
  });

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
    expect(journal.entries).toHaveLength(21);
    expect(journal.entries[8]).toMatchObject({ tag: '0008_optional_supplier_weight' });
    expect(journal.entries[9]).toMatchObject({ tag: '0009_supported_allocation_policy' });
    expect(journal.entries[10]).toMatchObject({
      tag: '0010_current_mens_product_name',
      breakpoints: true,
    });
    // A migration file that is not in the journal never runs, so every new SQL file has
    // to appear here as well; that is what this length check is guarding.
    expect(journal.entries[11]).toMatchObject({
      tag: '0011_wholesale_account_role',
      breakpoints: true,
    });
    expect(journal.entries[12]).toMatchObject({
      tag: '0012_store_partner_inbound',
      breakpoints: true,
    });
    expect(journal.entries[13]).toMatchObject({
      tag: '0013_replace_inactive_store_accounts',
      breakpoints: true,
    });
    expect(journal.entries[14]).toMatchObject({
      tag: '0014_store_bag_display_codes',
      breakpoints: true,
    });
    expect(journal.entries[15]).toMatchObject({
      tag: '0015_sequential_document_codes',
      breakpoints: true,
    });
    expect(journal.entries[16]).toMatchObject({ tag: '0016_store_outbound_reasons' });
    expect(journal.entries[17]).toMatchObject({ tag: '0017_store_outbound_piece_count' });
    expect(journal.entries[18]).toMatchObject({ tag: '0018_sorted_stock_idosi_sync' });
    expect(journal.entries[19]).toMatchObject({ tag: '0019_sorted_sale_transfers' });
    expect(journal.entries[20]).toMatchObject({ tag: '0020_weighed_dispatch_bags' });
    expect(journal.entries[7]).toMatchObject({ tag: '0007_receipt_vat', breakpoints: true });
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
    expect(journal.entries[5]).toMatchObject({
      tag: '0005_idosi_statistics_snapshots',
      breakpoints: true,
    });
    expect(journal.entries[6]).toMatchObject({
      tag: '0006_store_group_versions',
      breakpoints: true,
    });
  });

  it('adds optimistic concurrency to store-group lifecycle changes', () => {
    expect(storeGroupVersionMigration).toContain(
      'ALTER TABLE "store_groups" ADD COLUMN "version" integer DEFAULT 0 NOT NULL',
    );
    expect(storeGroupVersionMigration).toContain('"store_groups_version_nonnegative"');
    expect(storeGroupVersionSnapshot.prevId).toBe(idosiStatisticsSnapshot.id);
    expect(storeGroupVersionSnapshot.tables['public.store_groups']?.columns).toHaveProperty(
      'version',
    );
    expect(
      storeGroupVersionSnapshot.tables['public.store_groups']?.checkConstraints,
    ).toHaveProperty('store_groups_version_nonnegative');
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

  it('stores one replaceable IDOSI aggregate per scope without touching inventory tables', () => {
    expect(idosiStatisticsMigration).toContain('CREATE TABLE "idosi_statistics_snapshots"');
    expect(idosiStatisticsMigration).toContain('CREATE TABLE "idosi_statistics_sync_attempts"');
    expect(idosiStatisticsMigration).toContain('"idosi_statistics_snapshots_store_scope_uidx"');
    expect(idosiStatisticsMigration).toContain('idosi_statistics_sync_attempts_immutable');
    expect(idosiStatisticsMigration).not.toMatch(/store_inventory|warehouse_balance/iu);
    expect(schemaSource).toContain('idosiStatisticsSnapshots');
    expect(schemaSource).toContain('idosiStatisticsSyncAttempts');
    expect(idosiStatisticsSnapshot.prevId).toBe(storeTransferSnapshot.id);
    expect(idosiStatisticsSnapshot.tables).toHaveProperty('public.idosi_statistics_snapshots');
    expect(idosiStatisticsSnapshot.tables).toHaveProperty('public.idosi_statistics_sync_attempts');
    expect(
      idosiStatisticsSnapshot.tables['public.idosi_statistics_snapshots']?.indexes,
    ).toHaveProperty('idosi_statistics_snapshots_store_scope_uidx');
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

  it('uses exact case-sensitive account identity and one active STORE account per store', () => {
    expect(migration).toContain('"users_email_uidx"');
    expect(migration).not.toContain('users_email_lower_uidx');
    expect(migration).toContain('"users_one_store_account_uidx"');
    expect(migration).toMatch(/"role" = 'store' AND "users"\."deleted_at" IS NULL/);
    const replacement = readFileSync(
      new URL('../migrations/0013_replace_inactive_store_accounts.sql', import.meta.url),
      'utf8',
    );
    expect(replacement).toContain('"users_active_email_uidx"');
    expect(replacement).toMatch(
      /"role" = 'store' AND "status" = 'active' AND "deleted_at" IS NULL/,
    );
    expect(schemaSource).toContain("${table.status} = 'active' AND ${table.deletedAt} IS NULL");
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

  it('updates the retired menswear label without rewriting relational history', () => {
    expect(currentMensProductNameMigration).toContain(`WHERE "sku" = 'DO_NAM'`);
    expect(currentMensProductNameMigration).toContain(`SET "name" = 'Quần áo nam'`);
    expect(currentMensProductNameMigration).toContain('PRODUCT_DISPLAY_NAME_UPDATED');
    expect(currentMensProductNameMigration).not.toMatch(
      /UPDATE\s+"?(?:order|receipt|outbound|warehouse)/iu,
    );
    expect(seedDataSource).toContain("name: 'Quần áo nam'");
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

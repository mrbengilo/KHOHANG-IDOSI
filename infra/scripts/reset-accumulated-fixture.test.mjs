// Run after the full PostgreSQL/live-browser suites. Clone their accumulated fixtures so the
// reset also covers connected receipts, adjustments, VAT, ledgers, sorting and multiple roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  planTestDataReset,
  applyTestDataReset,
  verifyTestDataReset,
  EXPECTED_RESET_SCHEMA_HASH,
} from '../../packages/database/dist/test-data-reset.js';

test(
  'reset preserves protected data in the accumulated workflow fixture',
  { timeout: 60000 },
  async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    const url = new URL(process.env.DATABASE_URL);
    const source = url.pathname.slice(1);
    assert.match(source, /^[a-z0-9_]+_(ci|test|fixture)$/);
    const admin = new pg.Pool({ connectionString: url.href, max: 1 });
    const name = 'idosi_reset_accumulated_' + randomUUID().replaceAll('-', '');
    let fixture;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);
      created = true;
      url.pathname = '/' + name;
      fixture = new pg.Pool({ connectionString: url.href, max: 1 });
      const context = {
        host: 'isolated-accumulated-fixture',
        project: 'reset-fixture',
        release: '1'.repeat(40),
        operationId: randomUUID(),
        cutoff: new Date().toISOString(),
        expectedSchemaHash: EXPECTED_RESET_SCHEMA_HASH,
        inventoryHash: '2'.repeat(64),
      };
      const manifest = await planTestDataReset(fixture, context);
      assert.deepEqual(manifest.review, []);
      for (const table of [
        'users',
        'sessions',
        'htkd_assignments',
        'idosi_statistics_snapshots',
        'receipts',
        'receipt_costs',
        'store_receipt_adjustments',
        'store_receipt_returns',
        'store_inventory_bags',
        'store_inventory_ledger_entries',
        'store_sorting_events',
        'sorted_sale_transfers',
        'store_charity_exports',
        'idempotency_keys',
      ]) {
        assert.ok(
          Number(manifest.tables.find((t) => t.name === table)?.count) > 0,
          `Missing workflow fixture: ${table}`,
        );
      }
      assert.equal((await applyTestDataReset(fixture, manifest, manifest.hash)).resumed, false);
      assert.equal((await verifyTestDataReset(fixture, manifest)).state, 'VERIFIED');
      assert.equal((await applyTestDataReset(fixture, manifest, manifest.hash)).resumed, true);
      console.log(
        JSON.stringify({
          fixtureTablesWithRows: manifest.tables.filter((t) => t.count !== '0').length,
          protectedAuditRows: manifest.keptAudit.count,
          state: 'VERIFIED',
        }),
      );
    } finally {
      if (fixture) await fixture.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);

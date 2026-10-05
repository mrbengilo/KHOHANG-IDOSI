import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { expect, it } from 'vitest';

const pgIt = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Upgrades a database that already holds pre-confirmation history: a dispatched and received
 * shipment, a shipment stuck at reserved, priority goods held without a shipment and a run with
 * a store that got nothing. 0038 must classify each result LEGACY, change no stock, and leave
 * every legacy path working, while a new run can no longer complete without decisions.
 */
pgIt(
  '0038 classifies history as legacy without touching stock, repeats safely and guards new runs',
  async () => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    const admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    const databaseName = `decision_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl.href);
    url.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 2 });
    const previous = await mkdtemp(join(tmpdir(), 'idosi-0037-'));
    try {
      // Migrations 0000..0037 only: the schema production runs before this release.
      await cp(migrationsFolder, previous, { recursive: true });
      await rm(join(previous, '0038_allocation_result_decisions.sql'));
      const journalPath = join(previous, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter(
        (entry) => entry.tag !== '0038_allocation_result_decisions',
      );
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: previous });

      const history = await seedHistory(pool);
      const before = await stockState(pool);

      await migrate(drizzle(pool), { migrationsFolder });
      const decisions = await pool.query(
        `SELECT allocation_run_id, store_id, status, origin, granted_quantity, responded_at, responded_by_user_id
         FROM allocation_result_decisions ORDER BY granted_quantity, store_id`,
      );
      expect(decisions.rows).toEqual(
        [
          { run: history.runA, store: history.storeB, granted: 0 },
          { run: history.runA, store: history.storeA, granted: 3 },
          { run: history.runB, store: history.storeA, granted: 4 },
        ]
          .sort((a, b) => a.granted - b.granted || a.store.localeCompare(b.store))
          .map((row) => ({
            allocation_run_id: row.run,
            store_id: row.store,
            status: 'legacy',
            origin: 'legacy_backfill',
            granted_quantity: row.granted,
            // Never a fabricated answer.
            responded_at: null,
            responded_by_user_id: null,
          })),
      );
      expect(await stockState(pool)).toEqual(before);

      // The backfill statement itself is repeatable; the migrator also never re-applies it.
      const sqlText = await readFile(
        join(migrationsFolder, '0038_allocation_result_decisions.sql'),
        'utf8',
      );
      const backfill = sqlText
        .split('--> statement-breakpoint')
        .find((statement) => statement.includes('INSERT INTO "allocation_result_decisions"'))!;
      await pool.query(backfill);
      await migrate(drizzle(pool), { migrationsFolder });
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM allocation_result_decisions')).rows[0].n,
      ).toBe(3);

      // A legacy shipment stuck at reserved may still be released (legacy path).
      await pool.query(
        `UPDATE outbound_requests SET status = 'dispatched', dispatched_at = now() WHERE id = $1`,
        [history.reservedOutbound],
      );
      // A run completed by code that does not publish decisions is refused by the database.
      const run = await pool.query(
        `INSERT INTO allocation_runs (order_session_id, inventory_snapshot_id, run_number, status, policy_version, idempotency_key)
         VALUES ($1, $2, 2, 'running', 'p', $3) RETURNING id`,
        [history.sessionB, history.snapshotB, randomUUID()],
      );
      await pool.query(
        `INSERT INTO allocation_lines (allocation_run_id, merged_order_id, store_id, product_id, order_request_item_id, priority_level, round_number, sequence_in_round, requested_quantity, allocated_quantity, status, reason_code)
         VALUES ($1, $2, $3, $4, $5, 'P1', 1, 1, 1, 1, 'allocated', 'NEW')`,
        [run.rows[0].id, history.mergedB, history.storeA, history.secondProduct, history.itemB2],
      );
      await expect(
        pool.query(`UPDATE allocation_runs SET status = 'completed' WHERE id = $1`, [
          run.rows[0].id,
        ]),
      ).rejects.toThrow(/ALLOCATION_DECISION_MISSING/);
    } finally {
      await pool.end();
      await rm(previous, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
  60_000,
);

async function stockState(pool: pg.Pool) {
  const balances = await pool.query(
    'SELECT product_id, on_hand_quantity, reserved_quantity FROM warehouse_balances ORDER BY product_id',
  );
  const reservationsState = await pool.query(
    'SELECT id, status, outbound_request_line_id, quantity FROM reservations ORDER BY id',
  );
  const outbounds = await pool.query(
    'SELECT id, status, version FROM outbound_requests ORDER BY id',
  );
  const ledger = await pool.query('SELECT count(*)::int AS n FROM warehouse_ledger_entries');
  return {
    balances: balances.rows,
    reservations: reservationsState.rows,
    outbounds: outbounds.rows,
    ledger: ledger.rows,
  };
}

async function seedHistory(pool: pg.Pool) {
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
  const [group] = await q(`INSERT INTO store_groups (code, name) VALUES ('G', 'G') RETURNING id`);
  const [storeA] = await q(
    `INSERT INTO stores (group_id, code, name) VALUES ($1, 'A', 'A') RETURNING id`,
    [group.id],
  );
  const [storeB] = await q(
    `INSERT INTO stores (group_id, code, name) VALUES ($1, 'B', 'B') RETURNING id`,
    [group.id],
  );
  const [user] = await q(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES ('legacy.admin@example.test', 'hash-hash-hash-hash-hash', 'A', 'admin') RETURNING id`,
  );
  const [product] = await q(
    `INSERT INTO products (sku, slug, name) VALUES ('P', 'p', 'P') RETURNING id`,
  );
  await q(
    `INSERT INTO warehouse_balances (product_id, on_hand_quantity, reserved_quantity) VALUES ($1, 20, 7)`,
    [product.id],
  );
  const [secondProduct] = await q(
    `INSERT INTO products (sku, slug, name) VALUES ('P2', 'p2', 'P2') RETURNING id`,
  );
  const mergeSource = async (
    mergedId: string,
    itemId: string,
    quantity: number,
    productId: string = product.id,
  ) => {
    const [mergedItem] = await q(
      `INSERT INTO merged_order_items (merged_order_id, product_id, requested_quantity, priority_level) VALUES ($1, $2, $3, 'P1') RETURNING id`,
      [mergedId, productId, quantity],
    );
    await q(
      `INSERT INTO merged_order_sources (merged_order_item_id, order_request_item_id, requested_quantity) VALUES ($1, $2, $3)`,
      [mergedItem.id, itemId, quantity],
    );
  };
  const session = async (code: string, date: string) => {
    const [row] = await q(
      `INSERT INTO order_sessions (code, business_date, status, inventory_snapshot_due_at, request_deadline_at, policy_version)
       VALUES ($1, $2, 'completed', $3, $4, 'p') RETURNING id`,
      [code, date, `${date}T01:00:00Z`, `${date}T02:00:00Z`],
    );
    const [snapshot] = await q(
      `INSERT INTO inventory_snapshots (order_session_id, business_date, snapshot_type, status, captured_at, completed_at, balance_version)
       VALUES ($1, $2, 'manual', 'completed', now(), now(), 0) RETURNING id`,
      [row.id, date],
    );
    const [run] = await q(
      `INSERT INTO allocation_runs (order_session_id, inventory_snapshot_id, run_number, status, policy_version, idempotency_key)
       VALUES ($1, $2, 1, 'completed', 'p', $3) RETURNING id`,
      [row.id, snapshot.id, randomUUID()],
    );
    const scopes = new Map<string, { mergedId: string; orderId: string }>();
    const scope = async (storeId: string) => {
      const known = scopes.get(storeId);
      if (known) return known;
      const [merged] = await q(
        `INSERT INTO merged_orders (order_session_id, store_id, status, request_count) VALUES ($1, $2, 'allocated', 1) RETURNING id`,
        [row.id, storeId],
      );
      const [order] = await q(
        `INSERT INTO order_requests (order_session_id, store_id, request_number, status, submitted_at, requested_by_user_id)
         VALUES ($1, $2, 1, 'allocated', now(), $3) RETURNING id`,
        [row.id, storeId, user.id],
      );
      const created = { mergedId: merged.id as string, orderId: order.id as string };
      scopes.set(storeId, created);
      return created;
    };
    return { sessionId: row.id, snapshotId: snapshot.id, runId: run.id, scope };
  };
  const line = async (
    s: Awaited<ReturnType<typeof session>>,
    storeId: string,
    allocated: number,
    waitlisted: number,
  ) => {
    const { mergedId, orderId } = await s.scope(storeId);
    const [item] = await q(
      `INSERT INTO order_request_items (order_request_id, product_id, requested_quantity) VALUES ($1, $2, $3) RETURNING id`,
      [orderId, product.id, allocated + waitlisted],
    );
    await mergeSource(mergedId, item.id, allocated + waitlisted);
    const [row] = await q(
      `INSERT INTO allocation_lines (allocation_run_id, merged_order_id, store_id, product_id, order_request_item_id, priority_level, round_number, sequence_in_round, requested_quantity, allocated_quantity, waitlisted_quantity, status, reason_code)
       VALUES ($1, $2, $3, $4, $5, 'P1', 1, 1, $6, $7, $8, $9, 'LEGACY') RETURNING id`,
      [
        s.runId,
        mergedId,
        storeId,
        product.id,
        item.id,
        allocated + waitlisted,
        allocated,
        waitlisted,
        allocated > 0 ? 'allocated' : 'waitlisted',
      ],
    );
    return { lineId: row.id, itemId: item.id };
  };
  const a = await session('S-A', '2026-09-01');
  const b = await session('S-B', '2026-09-02');
  const lineA = await line(a, storeA.id, 3, 0);
  await line(a, storeB.id, 0, 2);
  const lineB = await line(b, storeA.id, 4, 0);
  // Session A: a stuck reserved shipment of 3. Session B: 4 held priority goods, no shipment.
  const [outbound] = await q(
    `INSERT INTO outbound_requests (request_number, store_id, order_session_id, allocation_run_id, status, requested_by_user_id)
     VALUES ('', $1, $2, $3, 'reserved', $4) RETURNING id`,
    [storeA.id, a.sessionId, a.runId, user.id],
  );
  const [outLine] = await q(
    `INSERT INTO outbound_request_lines (outbound_request_id, product_id, allocation_line_id, requested_quantity, approved_quantity, reserved_quantity)
     VALUES ($1, $2, $3, 3, 3, 3) RETURNING id`,
    [outbound.id, product.id, lineA.lineId],
  );
  await q(
    `INSERT INTO reservations (product_id, store_id, allocation_line_id, outbound_request_line_id, quantity) VALUES ($1, $2, $3, $4, 3)`,
    [product.id, storeA.id, lineA.lineId, outLine.id],
  );
  await q(
    `INSERT INTO reservations (product_id, store_id, allocation_line_id, quantity) VALUES ($1, $2, $3, 4)`,
    [product.id, storeA.id, lineB.lineId],
  );
  const scopeB = await b.scope(storeA.id);
  const [extraItem] = await q(
    `INSERT INTO order_request_items (order_request_id, product_id, requested_quantity) VALUES ($1, $2, 1) RETURNING id`,
    [scopeB.orderId, secondProduct.id],
  );
  await mergeSource(scopeB.mergedId, extraItem.id, 1, secondProduct.id);
  return {
    storeA: storeA.id as string,
    storeB: storeB.id as string,
    product: product.id as string,
    secondProduct: secondProduct.id as string,
    runA: a.runId as string,
    runB: b.runId as string,
    sessionB: b.sessionId as string,
    snapshotB: b.snapshotId as string,
    mergedB: scopeB.mergedId,
    itemB2: extraItem.id as string,
    reservedOutbound: outbound.id as string,
  };
}

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
 * Upgrades a database running 0044 that already holds waiting demand: an active ticket, a
 * fulfilled ticket whose goods wait in a PENDING result, and a store whose only ticket was
 * cancelled. 0045 must open exactly one current document for the store with open demand (both
 * the waiting and the awaiting-answer bags), none for the other store, change no ticket, stock,
 * hold or result, and its backfill must be repeatable.
 */
pgIt(
  '0045 backfills one current document per store with open demand and touches nothing else',
  async () => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    const admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    const databaseName = `wait_document_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl.href);
    url.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 2 });
    const previous = await mkdtemp(join(tmpdir(), 'idosi-0044-'));
    try {
      await cp(migrationsFolder, previous, { recursive: true });
      await rm(join(previous, '0045_store_wait_documents.sql'));
      const journalPath = join(previous, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) < 45);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: previous });

      const history = await seedHistory(pool);
      const before = await businessState(pool);

      await migrate(drizzle(pool), { migrationsFolder });
      const documents = await pool.query(
        `SELECT id, code, store_id, status, version, chain_sequence, predecessor_id FROM store_wait_documents`,
      );
      expect(documents.rows).toHaveLength(1);
      const [document] = documents.rows;
      expect(document).toMatchObject({
        store_id: history.storeA,
        status: 'current',
        version: 1,
        chain_sequence: 1,
        predecessor_id: null,
      });
      expect(document.code).toMatch(/^PCT-\d{6}$/u);
      const lines = await pool.query(
        `SELECT product_id, carried_in_quantity, added_quantity, opening_remaining_quantity,
           opening_pending_quantity, confirmed_quantity
         FROM store_wait_document_lines WHERE document_id = $1 ORDER BY product_id`,
        [document.id],
      );
      expect(lines.rows).toEqual(
        [
          { product_id: history.productX, remaining: 3, pending: 0 },
          { product_id: history.productY, remaining: 0, pending: 2 },
        ]
          .sort((left, right) => left.product_id.localeCompare(right.product_id))
          .map((row) => ({
            product_id: row.product_id,
            carried_in_quantity: 0,
            added_quantity: row.remaining + row.pending,
            opening_remaining_quantity: row.remaining,
            opening_pending_quantity: row.pending,
            confirmed_quantity: null,
          })),
      );
      const members = await pool.query(
        `SELECT wait_ticket_id FROM store_wait_document_members WHERE document_id = $1 ORDER BY 1`,
        [document.id],
      );
      expect(members.rows.map((row) => row.wait_ticket_id)).toEqual(
        [history.activeTicket, history.fulfilledTicket].sort(),
      );
      const events = await pool.query(
        `SELECT kind, source_key, actor_user_id FROM store_wait_document_events`,
      );
      expect(events.rows).toEqual([
        { kind: 'migration_backfill', source_key: 'migration:0045', actor_user_id: null },
      ]);
      // Nothing of the business state moved.
      expect(await businessState(pool)).toEqual(before);

      // The backfill statements are repeatable: running them again opens nothing more.
      const sqlText = await readFile(
        join(migrationsFolder, '0045_store_wait_documents.sql'),
        'utf8',
      );
      const statements = sqlText.split('--> statement-breakpoint');
      const start = statements.findIndex((statement) =>
        statement.includes('CREATE TEMP TABLE store_wait_backfill_lines'),
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements.slice(start)) await client.query(statement);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM store_wait_documents')).rows[0].n,
      ).toBe(1);
      // One current document per store is enforced by the database itself.
      await expect(
        pool.query(
          `WITH e AS (INSERT INTO store_wait_document_events (store_id, kind, occurred_at)
             VALUES ($1, 'system_sync', now()) RETURNING id), d AS (SELECT gen_random_uuid() AS id)
           INSERT INTO store_wait_documents (id, store_id, status, chain_id, chain_sequence,
             opened_event_id, opened_at, waiting_since)
           SELECT d.id, $1, 'current', d.id, 1, e.id, now(), now() FROM d, e`,
          [history.storeA],
        ),
      ).rejects.toThrow();
    } finally {
      await pool.end();
      await rm(previous, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
  60_000,
);

async function businessState(pool: pg.Pool) {
  const read = async (text: string) => (await pool.query(text)).rows;
  return {
    tickets: await read(
      `SELECT id, status, original_quantity, remaining_quantity, fulfilled_quantity, queued_at
       FROM wait_tickets ORDER BY id`,
    ),
    balances: await read(
      'SELECT product_id, on_hand_quantity, reserved_quantity FROM warehouse_balances ORDER BY 1',
    ),
    reservations: await read('SELECT id, status, quantity FROM reservations ORDER BY id'),
    decisions: await read(
      'SELECT id, status, version, granted_quantity, revoked_quantity FROM allocation_result_decisions ORDER BY id',
    ),
    ledger: await read('SELECT count(*)::int AS n FROM warehouse_ledger_entries'),
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
  const [productX] = await q(
    `INSERT INTO products (sku, slug, name) VALUES ('X', 'x', 'X') RETURNING id`,
  );
  const [productY] = await q(
    `INSERT INTO products (sku, slug, name) VALUES ('Y', 'y', 'Y') RETURNING id`,
  );
  await q(
    `INSERT INTO warehouse_balances (product_id, on_hand_quantity, reserved_quantity) VALUES ($1, 10, 0), ($2, 10, 2)`,
    [productX.id, productY.id],
  );
  const [session] = await q(
    `INSERT INTO order_sessions (code, business_date, status, inventory_snapshot_due_at, request_deadline_at, policy_version)
     VALUES ('S1', '2026-10-01', 'completed', '2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z', 'p') RETURNING id`,
  );
  const order = async (storeId: string, productId: string, quantity: number) => {
    const [request] = await q(
      `INSERT INTO order_requests (order_session_id, store_id, request_number, status, submitted_at, requested_by_user_id)
       VALUES ($1, $2, 1, 'waitlisted', now(), $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [session.id, storeId, user.id],
    );
    const [existing] = request
      ? [request]
      : await q(`SELECT id FROM order_requests WHERE order_session_id = $1 AND store_id = $2`, [
          session.id,
          storeId,
        ]);
    const [item] = await q(
      `INSERT INTO order_request_items (order_request_id, product_id, requested_quantity) VALUES ($1, $2, $3) RETURNING id`,
      [existing.id, productId, quantity],
    );
    return item.id as string;
  };
  const ticket = async (
    storeId: string,
    productId: string,
    status: string,
    remaining: number,
    fulfilled: number,
  ) => {
    const [row] = await q(
      `INSERT INTO wait_tickets (store_id, product_id, source_order_request_item_id, status, original_quantity, remaining_quantity, fulfilled_quantity, resolved_at, cancellation_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        storeId,
        productId,
        await order(storeId, productId, remaining + fulfilled),
        status,
        remaining + fulfilled,
        remaining,
        fulfilled,
        status === 'active' ? null : new Date(),
        status === 'cancelled' ? 'store_cancelled' : null,
      ],
    );
    return row.id as string;
  };
  const activeTicket = await ticket(storeA.id, productX.id, 'active', 3, 0);
  const fulfilledTicket = await ticket(storeA.id, productY.id, 'fulfilled', 0, 2);
  await ticket(storeB.id, productX.id, 'cancelled', 2, 0);

  // The run granted Y's 2 bags from the ticket; the store has not answered yet.
  const [snapshot] = await q(
    `INSERT INTO inventory_snapshots (order_session_id, business_date, snapshot_type, status, captured_at, completed_at, balance_version)
     VALUES ($1, '2026-10-01', 'manual', 'completed', now(), now(), 0) RETURNING id`,
    [session.id],
  );
  const [run] = await q(
    `INSERT INTO allocation_runs (order_session_id, inventory_snapshot_id, run_number, status, policy_version, idempotency_key)
     VALUES ($1, $2, 1, 'running', 'p', $3) RETURNING id`,
    [session.id, snapshot.id, randomUUID()],
  );
  // A P0A line always comes from an offer the store accepted before the run.
  const [offer] = await q(
    `INSERT INTO daily_priority_offers (business_date, order_session_id, store_id, product_id, wait_ticket_id, priority_level, offered_quantity, eligible_quantity_at_offer, accepted_quantity, status, response_deadline_at, responded_at)
     VALUES ('2026-10-01', $1, $2, $3, $4, 'P0A', 2, 2, 2, 'accepted', '2026-10-01T02:00:00Z', '2026-10-01T01:30:00Z') RETURNING id`,
    [session.id, storeA.id, productY.id, fulfilledTicket],
  );
  const [line] = await q(
    `INSERT INTO allocation_lines (allocation_run_id, store_id, product_id, wait_ticket_id, priority_offer_id, priority_level, round_number, sequence_in_round, requested_quantity, allocated_quantity, status, reason_code)
     VALUES ($1, $2, $3, $4, $5, 'P0A', 1, 1, 2, 2, 'allocated', 'LEGACY') RETURNING id`,
    [run.id, storeA.id, productY.id, fulfilledTicket, offer.id],
  );
  await q(
    `INSERT INTO reservations (product_id, store_id, allocation_line_id, quantity, status) VALUES ($1, $2, $3, 2, 'active')`,
    [productY.id, storeA.id, line.id],
  );
  await q(
    `INSERT INTO allocation_result_decisions (allocation_run_id, order_session_id, store_id, status, version, granted_quantity, origin)
     VALUES ($1, $2, $3, 'pending', 1, 2, 'allocation_run')`,
    [run.id, session.id, storeA.id],
  );
  await q(`UPDATE allocation_runs SET status = 'completed' WHERE id = $1`, [run.id]);
  return {
    storeA: storeA.id as string,
    storeB: storeB.id as string,
    productX: productX.id as string,
    productY: productY.id as string,
    activeTicket,
    fulfilledTicket,
  };
}

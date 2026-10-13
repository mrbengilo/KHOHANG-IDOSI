import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { expect, it } from 'vitest';

import {
  applyReshareCutover,
  applyWarehouseMovement,
  createDatabase,
  planReshareCutover,
  products,
  respondAllocationDecision,
  updateReshareOrderStatus,
  listReshareOrderHistory,
  stores,
  storeGroups,
  users,
  withSerializableTransaction,
  type Database,
} from '../src/index.js';
import { publishPendingResult } from './fixtures/reshare.js';
import type { SupplierFixture } from './fixtures/supplier.js';

const pgIt = process.env.RUN_POSTGRES_TESTS === '1' ? it : it.skip;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Upgrades a 0041 database holding pending, accepted-but-held and accepted-and-received results.
 * 0042 must change no stock and fabricate no RE order; the new acceptance path issues once; an
 * acceptance written the old way can no longer commit; the cutover plan classifies each history
 * case and the reviewed backfill issues only the eligible one, once.
 */
pgIt(
  '0042 upgrades history without touching stock, refuses old-style acceptance and backfills only eligible results once',
  async () => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    const admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    const databaseName = `reshare_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl.href);
    url.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 2 });
    const previous = await mkdtemp(join(tmpdir(), 'idosi-0041-'));
    const client = createDatabase({ connectionString: url.href, max: 4 });
    const database = client.db as Database;
    try {
      // Migrations 0000..0041 only: the schema production runs before this release.
      await cp(migrationsFolder, previous, { recursive: true });
      await rm(join(previous, '0042_reshare_orders_and_issue.sql'));
      const journalPath = join(previous, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) < 42);
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(drizzle(pool), { migrationsFolder: previous });

      // History written by the previous release.
      const token = randomUUID().slice(0, 8);
      const [group] = await database
        .insert(storeGroups)
        .values({ code: `UPG-${token}`, name: 'Upgrade group' })
        .returning();
      const [store] = await database
        .insert(stores)
        .values({ code: `UPG-${token}`, name: 'Cửa hàng nâng cấp', groupId: group!.id })
        .returning();
      const user = async (role: 'admin' | 'store', storeId: string | null) => {
        const [row] = await database
          .insert(users)
          .values({
            email: `upg-${role}-${token}@example.test`,
            passwordHash: 'upgrade-test-password-hash-placeholder',
            displayName: `Upgrade ${role}`,
            role,
            storeId,
          })
          .returning({ id: users.id });
        return row!.id;
      };
      const adminId = await user('admin', null);
      const storeUserId = await user('store', store!.id);
      const [product] = await database
        .insert(products)
        .values({ sku: `UPG-${token}`, slug: `upg-${token}`, name: 'Hàng nâng cấp' })
        .returning({ id: products.id });
      await withSerializableTransaction(database, (tx) =>
        applyWarehouseMovement(tx, {
          productId: product!.id,
          eventType: 'opening_balance',
          onHandDelta: 30,
          reservedDelta: 0,
          sourceType: 'upgrade_opening',
          sourceId: randomUUID(),
        }),
      );
      const fx = { adminId } as SupplierFixture;
      const grant = (quantity: number) =>
        publishPendingResult(
          fx,
          {
            storeId: store!.id,
            grants: [{ productId: product!.id, quantity }],
            preReshareStatusSchema: true,
          },
          database,
        );
      const pending = await grant(2);
      const acceptedHeld = await grant(3);
      const acceptedReceived = await grant(4);
      const laterPending = await grant(1);
      // The previous release accepted without RE orders (no 0042 guard yet).
      for (const result of [acceptedHeld, acceptedReceived]) {
        await pool.query(
          `UPDATE allocation_result_decisions
             SET status = 'accepted', version = 2, responded_at = now(), responded_by_user_id = $2
           WHERE id = $1`,
          [result.decisionId, storeUserId],
        );
      }
      // One of them was received and settled the legacy way.
      await pool.query(
        `UPDATE reservations SET status = 'consumed', consumed_quantity = quantity, consumed_at = now()
         WHERE id = ANY($1::uuid[])`,
        [acceptedReceived.reservationIds],
      );
      await pool.query(
        `INSERT INTO warehouse_ledger_entries (product_id, event_type, on_hand_delta, reserved_delta, on_hand_after, reserved_after, source_type, source_id, event_sequence)
         SELECT b.product_id, 'outbound', -4, -4, b.on_hand_quantity - 4, b.reserved_quantity - 4, 'store_receipt', $2, 1
         FROM warehouse_balances b WHERE b.product_id = $1`,
        [product!.id, randomUUID()],
      );
      await pool.query(
        `UPDATE warehouse_balances SET on_hand_quantity = on_hand_quantity - 4, reserved_quantity = reserved_quantity - 4 WHERE product_id = $1`,
        [product!.id],
      );
      const stock = async () =>
        (
          await pool.query(
            'SELECT on_hand_quantity, reserved_quantity FROM warehouse_balances WHERE product_id = $1',
            [product!.id],
          )
        ).rows[0];
      const before = await stock();
      expect(before).toEqual({ on_hand_quantity: 26, reserved_quantity: 6 });

      await migrate(drizzle(pool), { migrationsFolder });
      // Expand only: no stock moved, no RE order fabricated, the enum gained 'issued'.
      expect(await stock()).toEqual(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM reshare_orders')).rows[0].n).toBe(0);
      expect(
        (await pool.query('SELECT enum_range(NULL::reservation_status)::text AS r')).rows[0].r,
      ).toContain('issued');
      // Rerunning the migrator applies nothing twice.
      await migrate(drizzle(pool), { migrationsFolder });

      // 0043 starts with no manual assertions and supports already-received legacy rows.
      const legacyStatus = await listReshareOrderHistory(database, {
        page: 1,
        pageSize: 20,
        decisionId: acceptedReceived.decisionId,
      });
      expect(legacyStatus.data[0]).toMatchObject({
        status: 'not_ordered',
        statusControl: { version: 0, updatedAt: null },
      });
      await updateReshareOrderStatus(database, {
        decisionId: acceptedReceived.decisionId,
        actorUserId: adminId,
        status: 'ORDERED',
        expectedStatus: 'NOT_ORDERED',
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        requestHash: 'upgrade-status',
      });
      expect(
        (
          await listReshareOrderHistory(database, {
            page: 1,
            pageSize: 20,
            decisionId: acceptedReceived.decisionId,
            status: 'ordered',
          })
        ).data[0],
      ).toMatchObject({ status: 'ordered', order: null, statusControl: { version: 1 } });
      expect(await stock()).toEqual(before);

      // The new acceptance path: one RE order, issued once.
      const answer = await respondAllocationDecision(database, {
        decisionId: pending.decisionId,
        action: 'ACCEPT',
        expectedVersion: 1,
        actorUserId: storeUserId,
        idempotencyKey: randomUUID(),
        requestHash: 'upgrade-accept',
      });
      if (answer.replayed) throw new Error('unexpected replay');
      expect(answer.value.reshareOrderCode).toBe('RE-000001');
      expect(await stock()).toEqual({ on_hand_quantity: 24, reserved_quantity: 4 });

      // An acceptance written the old way (no RE order) cannot commit any more.
      await expect(
        pool.query(
          `UPDATE allocation_result_decisions
             SET status = 'accepted', version = 2, responded_at = now(), responded_by_user_id = $2
           WHERE id = $1`,
          [laterPending.decisionId, storeUserId],
        ),
      ).rejects.toThrow(/RESHARE_ORDER_REQUIRED/u);

      // Dry-run classification of the history.
      const plan = await planReshareCutover(database);
      const category = (decisionId: string) =>
        plan.items.find((item) => item.decisionId === decisionId)?.category;
      expect(category(pending.decisionId)).toBe('HAS_RESHARE_ORDER');
      expect(category(acceptedHeld.decisionId)).toBe('ACCEPTED_ELIGIBLE');
      expect(category(acceptedReceived.decisionId)).toBe('ACCEPTED_SETTLED');
      expect(category(laterPending.decisionId)).toBe('PENDING_NEW_FLOW');
      expect(await stock()).toEqual({ on_hand_quantity: 24, reserved_quantity: 4 });

      // A stale manifest is refused; the reviewed one issues only the eligible result.
      await expect(
        applyReshareCutover(database, {
          decisionIds: [acceptedHeld.decisionId],
          expectedEligibleHash: 'stale',
          actorUserId: adminId,
        }),
      ).rejects.toThrow(/eligible set changed/u);
      const applied = await applyReshareCutover(database, {
        decisionIds: [acceptedHeld.decisionId, acceptedReceived.decisionId],
        expectedEligibleHash: plan.eligibleHash,
        actorUserId: adminId,
      });
      expect(applied.created).toEqual([{ decisionId: acceptedHeld.decisionId, code: 'RE-000002' }]);
      expect(applied.skipped).toEqual([
        { decisionId: acceptedReceived.decisionId, category: 'ACCEPTED_SETTLED' },
      ]);
      expect(await stock()).toEqual({ on_hand_quantity: 21, reserved_quantity: 1 });
      // Rerun: nothing more is issued.
      const rerunPlan = await planReshareCutover(database);
      const rerun = await applyReshareCutover(database, {
        decisionIds: [acceptedHeld.decisionId],
        expectedEligibleHash: rerunPlan.eligibleHash,
        actorUserId: adminId,
      });
      expect(rerun.created).toEqual([]);
      expect(await stock()).toEqual({ on_hand_quantity: 21, reserved_quantity: 1 });
      const [origin] = (
        await pool.query("SELECT origin, actor_role FROM reshare_orders WHERE code = 'RE-000002'")
      ).rows;
      expect(origin).toEqual({ origin: 'backfill', actor_role: 'admin' });
      // Balance still equals the ledger.
      const ledger = (
        await pool.query(
          `SELECT sum(on_hand_delta)::int AS on_hand_quantity, sum(reserved_delta)::int AS reserved_quantity
           FROM warehouse_ledger_entries WHERE product_id = $1`,
          [product!.id],
        )
      ).rows[0];
      expect(ledger).toEqual(await stock());
    } finally {
      await client.close();
      await pool.end();
      await rm(previous, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
  90_000,
);

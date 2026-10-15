import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { WarehouseInventoryResponseSchema } from '@idosi/contracts';
import {
  db,
  pool,
  products,
  stores,
  storeGroups,
  users,
  sessions,
  htkdAssignments,
  orderSessions,
  orderRequests,
  orderRequestItems,
  waitTickets,
  syncAllStoreWaitDocuments,
} from '@idosi/database';
import { eq, sql } from 'drizzle-orm';
import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const postgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
postgres('warehouse remaining demand projection on PostgreSQL', () => {
  let app;
  before(async () => {
    app = await createApi({ repository: new PostgresWarehouseRepository() });
  });
  after(async () => {
    await app?.close();
  });
  async function read(f, role = 'admin', extra = '') {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/warehouse-inventory?projection=waiting-demand-v2&search=${f.prefix}${extra}`,
      headers: f.headers[role],
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return WarehouseInventoryResponseSchema.parse(response.json());
  }
  test('3 + 5 = 8 with zero stock, all read roles, same-name SKUs and independent pagination', async () => {
    const f = await fixture();
    for (const role of ['admin', 'htkd', 'store', 'wholesale']) {
      const page = await read(f, role);
      assert.equal(page.data.length, 3);
      assert.deepEqual(
        page.data.map((row) => row.waitingDemandBags),
        [8, 7, 0],
      );
      for (const row of page.data) {
        assert.equal(row.onHandBags, 0);
        assert.equal(row.reservedBags, 0);
        assert.equal(row.waitTicketHoldBags, 0);
        assert.equal(row.availableBags, 0);
        assert.equal(row.dispatchedBags, 0);
        assert.ok(!JSON.stringify(row).includes(f.storeIds[0]), 'aggregate must not expose stores');
      }
    }
    const page2 = await read(f, 'store', '&page=2&pageSize=1');
    assert.equal(page2.data[0].productId, f.productIds[1]);
    assert.equal(page2.data[0].waitingDemandBags, 7);
    assert.equal(page2.pagination.totalItems, 3);
    const documents = await app.inject({
      method: 'GET',
      url: '/api/v1/wait-documents?pageSize=1',
      headers: f.headers.store,
    });
    assert.equal(documents.statusCode, 200, documents.body);
    assert.equal(
      documents.json().data[0].lines.find((line) => line.productId === f.productIds[0])
        .remainingQuantity,
      3,
    );
    assert.equal((await read(f)).data[0].waitingDemandBags, 8);
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/wait-documents?storeId=${f.storeIds[1]}`,
      headers: f.headers.store,
    });
    assert.equal(foreign.statusCode, 403);
  });
  test('partial remaining, closed/soft-deleted rows and PCT rollover never multiply live demand', async () => {
    const f = await fixture();
    await db
      .update(waitTickets)
      .set({ remainingQuantity: 1, fulfilledQuantity: 2 })
      .where(eq(waitTickets.id, f.tickets[0]));
    await syncAllStoreWaitDocuments(db);
    await syncAllStoreWaitDocuments(db);
    assert.equal((await read(f)).data[0].waitingDemandBags, 6);
    await db
      .update(waitTickets)
      .set({ status: 'cancelled' })
      .where(eq(waitTickets.id, f.tickets[1]));
    await syncAllStoreWaitDocuments(db);
    assert.equal((await read(f)).data[0].waitingDemandBags, 1);
    await db
      .update(waitTickets)
      .set({ deletedAt: new Date() })
      .where(eq(waitTickets.id, f.tickets[0]));
    assert.equal((await read(f)).data[0].waitingDemandBags, 0);
    await db
      .update(waitTickets)
      .set({ status: 'fulfilled', remainingQuantity: 0, fulfilledQuantity: 7 })
      .where(eq(waitTickets.id, f.tickets[2]));
    assert.equal((await read(f)).data[1].waitingDemandBags, 0);
  });
  test('reads see a committed consistent aggregate while both stores change in one writer transaction', async () => {
    const f = await fixture();
    // Always total 8 after commit; between statements the writer has 6. Readers must never see 6.
    const writer = async () => {
      for (let i = 0; i < 6; i++)
        await db.transaction(async (tx) => {
          await tx
            .update(waitTickets)
            .set({ originalQuantity: i % 2 ? 3 : 1, remainingQuantity: i % 2 ? 3 : 1 })
            .where(eq(waitTickets.id, f.tickets[0]));
          await tx.execute(sql`select pg_sleep(0.015)`);
          await tx
            .update(waitTickets)
            .set({ originalQuantity: i % 2 ? 5 : 7, remainingQuantity: i % 2 ? 5 : 7 })
            .where(eq(waitTickets.id, f.tickets[1]));
        });
    };
    const reader = async () => {
      for (let i = 0; i < 12; i++) assert.equal((await read(f)).data[0].waitingDemandBags, 8);
    };
    await Promise.all([writer(), reader(), reader()]);
    const canonical = await db.execute(
      sql`select sum(remaining_quantity)::integer as demand from wait_tickets where product_id=${f.productIds[0]} and status='active' and deleted_at is null and remaining_quantity>0`,
    );
    assert.equal((await read(f)).data[0].waitingDemandBags, canonical.rows[0].demand);
  });
  test('old tabs fail visibly, new schema requires demand, and unknown projections are rejected', async () => {
    const f = await fixture();
    const old = await app.inject({
      method: 'GET',
      url: '/api/v1/warehouse-inventory',
      headers: f.headers.admin,
    });
    assert.equal(old.statusCode, 409);
    assert.match(old.body, /tải lại trang/);
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v1/warehouse-inventory?projection=future',
      headers: f.headers.admin,
    });
    assert.equal(unknown.statusCode, 400);
    const page = await read(f);
    const { waitingDemandBags: _missing, ...legacy } = page.data[0];
    assert.equal(
      WarehouseInventoryResponseSchema.safeParse({ ...page, data: [legacy] }).success,
      false,
    );
    await db.update(users).set({ status: 'locked' }).where(eq(users.id, f.userIds.store));
    const locked = await app.inject({
      method: 'GET',
      url: '/api/v1/warehouse-inventory?projection=waiting-demand-v2',
      headers: f.headers.store,
    });
    assert.ok([401, 403].includes(locked.statusCode));
  });
  test('bounded read query count and indexed demand lookup with 10000 historical tickets', async (t) => {
    const f = await fixture();
    await db.execute(sql`insert into wait_tickets(store_id,product_id,source_order_request_item_id,status,original_quantity,remaining_quantity,fulfilled_quantity)
      select w.store_id,w.product_id,w.source_order_request_item_id,'fulfilled',8,0,8
      from wait_tickets w cross join generate_series(1,10000) where w.id=${f.tickets[0]}`);
    await db.execute(sql`analyze wait_tickets`);
    const queries = [];
    const originals = new Map();
    const capture = (client) => {
      if (originals.has(client)) return;
      const original = client.query;
      originals.set(client, original);
      client.query = function (...args) {
        queries.push(typeof args[0] === 'string' ? args[0] : args[0].text);
        return original.apply(this, args);
      };
    };
    pool.on('acquire', capture);
    const counts = [];
    try {
      const repository = new PostgresWarehouseRepository();
      for (const pageSize of [1, 100]) {
        queries.length = 0;
        const result = await repository.listWarehouseInventory(
          { role: 'ADMIN' },
          { page: 1, pageSize, search: f.prefix },
        );
        assert.equal(result.data[0].waitingDemandBags, 8);
        counts.push(queries.filter((query) => /^select /i.test(query)).length);
        assert.equal(queries.filter((query) => query.includes('"wait_tickets"')).length, 1);
      }
      assert.deepEqual(counts, [2, 2], 'count plus page query, independent of number of products');
    } finally {
      pool.off('acquire', capture);
      for (const [client, original] of originals) client.query = original;
    }
    const lookup = sql`select coalesce(sum(remaining_quantity),0) from wait_tickets where product_id=${f.productIds[0]} and status='active' and deleted_at is null and remaining_quantity>0`;
    const plan = await db.execute(sql`explain (analyze,buffers,format json) ${lookup}`);
    // PostgreSQL may choose either existing partial index as table statistics change.
    // Assert indexed access to the two live rows, not one particular planner decision.
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan.rows[0]['QUERY PLAN'][0].Plan);
    const scan = nodes.find((node) => node['Relation Name'] === 'wait_tickets');
    assert.ok(['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(scan?.['Node Type']));
    assert.ok(nodes.some((node) => node['Index Name'] && /product_id/.test(node['Index Cond'])));
    assert.equal(scan['Actual Rows'], 2);
    assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
    const timings = { withoutDemand: [], withDemand: [] };
    for (let iteration = 0; iteration < 12; iteration++) {
      for (const [label, query] of [
        ['withoutDemand', sql`select id from products where id=${f.productIds[0]}`],
        [
          'withDemand',
          sql`select id,(${lookup}) as demand from products where id=${f.productIds[0]}`,
        ],
      ]) {
        const start = performance.now();
        await db.execute(query);
        if (iteration > 1) timings[label].push(Number((performance.now() - start).toFixed(3)));
      }
    }
    t.diagnostic(
      JSON.stringify({
        queryCounts: counts,
        historyRows: 10000,
        plan: plan.rows,
        timingsMs: timings,
      }),
    );
  });
});

async function fixture() {
  const prefix = `DEMAND-${randomUUID().slice(0, 8)}`;
  const [group] = await db.select().from(storeGroups).limit(1);
  return db
    .transaction(async (tx) => {
      const productRows = await tx
        .insert(products)
        .values(
          [1, 2, 3].map((n) => ({
            sku: `${prefix}-${n}`,
            name: 'Same display name',
            slug: `${prefix}-${n}`,
            unit: 'bag',
            displayOrder: n,
          })),
        )
        .returning();
      const storeRows = await tx
        .insert(stores)
        .values(
          ['A', 'B'].map((name) => ({
            code: `${prefix}-${name}`,
            name: `Demand store ${name}`,
            kind: 'retail',
            groupId: group.id,
          })),
        )
        .returning();
      const headers = {};
      const userIds = {};
      for (const role of ['admin', 'htkd', 'store', 'wholesale']) {
        const [user] = await tx
          .insert(users)
          .values({
            email: `${prefix}.${role}@example.test`,
            passwordHash: `integration-hash-${randomUUID()}`,
            displayName: `Demand ${role}`,
            role,
            ...(role === 'store' ? { storeId: storeRows[0].id } : {}),
          })
          .returning();
        userIds[role] = user.id;
        const token = randomBytes(32).toString('base64url');
        await tx.insert(sessions).values({
          userId: user.id,
          tokenHash: hashSessionToken(token),
          userTokenVersion: user.tokenVersion,
          expiresAt: new Date(Date.now() + 600_000),
        });
        headers[role] = { cookie: `idosi_session=${token}` };
      }
      await tx.insert(htkdAssignments).values({
        userId: userIds.htkd,
        storeId: storeRows[0].id,
        assignedByUserId: userIds.admin,
      });
      const [session] = await tx
        .insert(orderSessions)
        .values({
          code: prefix,
          kind: 'manual',
          businessDate: '2000-01-03',
          status: 'completed',
          openedAt: new Date('2000-01-03T00:00:00Z'),
          inventorySnapshotDueAt: new Date('2000-01-03T01:00:00Z'),
          requestDeadlineAt: new Date('2000-01-03T02:00:00Z'),
          policyVersion: 'idosi-round-robin-p0a-p3-v1',
        })
        .returning();
      const tickets = [];
      for (const [store, product, quantity] of [
        [storeRows[0], productRows[0], 3],
        [storeRows[1], productRows[0], 5],
        [storeRows[0], productRows[1], 7],
      ]) {
        const [order] = await tx
          .insert(orderRequests)
          .values({
            orderSessionId: session.id,
            storeId: store.id,
            requestNumber: product.id === productRows[1].id ? 2 : 1,
            status: 'waitlisted',
            submittedAt: new Date('2000-01-03T00:30:00Z'),
            requestedByUserId: userIds.admin,
          })
          .returning();
        const [item] = await tx
          .insert(orderRequestItems)
          .values({ orderRequestId: order.id, productId: product.id, requestedQuantity: quantity })
          .returning();
        const [ticket] = await tx
          .insert(waitTickets)
          .values({
            storeId: store.id,
            productId: product.id,
            sourceOrderRequestItemId: item.id,
            status: 'active',
            originalQuantity: quantity,
            remainingQuantity: quantity,
            fulfilledQuantity: 0,
          })
          .returning();
        tickets.push(ticket.id);
      }
      return {
        prefix,
        productIds: productRows.map((p) => p.id),
        storeIds: storeRows.map((s) => s.id),
        headers,
        userIds,
        tickets,
      };
    })
    .then(async (f) => {
      await syncAllStoreWaitDocuments(db);
      return f;
    });
}

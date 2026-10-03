import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planTestDataReset,
  applyTestDataReset,
  verifyTestDataReset,
  resetCatalog,
  resetHash,
  EXPECTED_RESET_SCHEMA_HASH,
  type ResetContext,
} from '../src/test-data-reset.js';
import { seedReferenceData } from '../src/reference-seed.js';
import { createDatabase, type DatabaseClient } from '../src/client.js';
import { resetSaleBoundary, resetAllowsSettlement } from '../src/reset-sale-boundary.js';
import { recordIdosiStatisticsSuccess } from '../src/idosi-statistics.js';
import {
  createStorePartnerInbound,
  openStoreInventoryBag,
  createStoreSorting,
  setIdosiProductLink,
} from '../src/index.js';
import { resetFixturePayload } from './reset-fixture-payload.js';

const describePg = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
describePg('controlled reset operations on an isolated fully migrated PostgreSQL database', () => {
  let admin: pg.Pool;
  let fixture: DatabaseClient;
  let databaseName: string;
  let context: ResetContext;
  let storeId: string;
  let productId: string;
  beforeEach(async () => {
    if (process.env.NODE_ENV !== 'test')
      throw new Error('Reset integration requires NODE_ENV=test');
    const url = new URL(process.env.DATABASE_URL!);
    if (!/(_ci|_test|_fixture)$/.test(url.pathname))
      throw new Error('Only a named fixture database may host reset tests');
    admin = new pg.Pool({ connectionString: url.href, max: 1 });
    databaseName = `reset_fixture_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = '/' + databaseName;
    fixture = createDatabase({ connectionString: url.href, max: 1 });
    await migrate(drizzle(fixture.pool), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await seedReferenceData(fixture.db);
    storeId = (await fixture.pool.query("SELECT id FROM stores WHERE kind='retail' LIMIT 1"))
      .rows[0].id;
    productId = (await fixture.pool.query('SELECT id FROM products LIMIT 1')).rows[0].id;
    await fixture.pool.query(
      `INSERT INTO users(email,password_hash,display_name,role,status,token_version,store_id)
      VALUES ('fixture-admin','fixture-hash-at-least-20-characters','Admin','admin','active',3,NULL),
      ('fixture-htkd','fixture-hash-at-least-20-characters','HTKD','htkd','locked',7,NULL),
      ('fixture-store','fixture-hash-at-least-20-characters','Store','store','active',2,$1),
      ('fixture-wholesale','fixture-hash-at-least-20-characters','Wholesale','wholesale','disabled',4,NULL)`,
      [storeId],
    );
    await fixture.pool.query(
      `INSERT INTO sessions(user_id,token_hash,user_token_version,expires_at) SELECT id,repeat('x',32),token_version,now()+interval '1 day' FROM users WHERE role='admin'`,
    );
    await fixture.pool.query(
      `INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version,deleted_at) VALUES ('TEST','2026-09-30','2026-09-30T01:00:00Z','2026-09-30T02:00:00Z','test',now())`,
    );
    await fixture.pool.query(
      `INSERT INTO audit_logs(action,entity_type,after) VALUES ('ORDER_REQUEST_SUBMITTED','order_request','{"nested":{"test":true}}'),('ACCOUNT_STATUS_UPDATED','user','{"status":"locked"}')`,
    );
    await fixture.pool
      .query(`INSERT INTO idempotency_keys(scope,key,request_hash,status,response_status,response_body,locked_until,expires_at)
      VALUES('fixture-order','old-key','fixture-hash','completed',200,'{"testPayload":"old-transaction"}',now(),now()+interval '1 day')`);
    const client = await fixture.pool.connect();
    const expectedSchemaHash = resetHash(await resetCatalog(client));
    client.release();
    expect(expectedSchemaHash).toBe(EXPECTED_RESET_SCHEMA_HASH);
    context = {
      host: 'isolated-test-host',
      project: 'reset-fixture',
      release: '1'.repeat(40),
      operationId: randomUUID(),
      cutoff: '2026-09-30T16:59:00.000Z',
      expectedSchemaHash,
      inventoryHash: '2'.repeat(64),
    };
  }, 30000);
  afterEach(async () => {
    if (fixture) await fixture.close();
    if (admin) {
      if (databaseName) await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    }
  });
  it('concurrent callers never commit twice and can resume after draining clients', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    await fixture.pool.query("SET application_name='idosi-test-reset'");
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + databaseName;
    const second = new pg.Pool({
      connectionString: url.href,
      max: 1,
      application_name: 'idosi-test-reset',
    });
    let results: PromiseSettledResult<Record<string, unknown>>[];
    try {
      results = await Promise.allSettled([
        applyTestDataReset(fixture.pool, manifest, manifest.hash),
        applyTestDataReset(second, manifest, manifest.hash),
      ]);
    } finally {
      await second.end();
    }
    const committed = results.filter((r) => r.status === 'fulfilled' && r.value.resumed === false);
    expect(committed.length).toBeLessThanOrEqual(1);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(String(result.reason)).toMatch(/other clients|writer connected/);
    }
    const resumed = await applyTestDataReset(fixture.pool, manifest, manifest.hash);
    expect(resumed.resumed).toBe(committed.length === 1);
    expect(
      (await fixture.pool.query('SELECT count(*)::int n FROM test_data_reset_operations')).rows[0]
        .n,
    ).toBe(1);
    await expect(applyTestDataReset(fixture.pool, manifest, manifest.hash)).resolves.toMatchObject({
      resumed: true,
    });
  });
  it('rejects a future cutoff during plan and apply without changing business data', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    const future = new Date(Date.now() + 86400000).toISOString();
    await expect(planTestDataReset(fixture.pool, { ...context, cutoff: future })).rejects.toThrow(
      /future/,
    );
    const { hash: _hash, ...body } = manifest;
    const changed = { ...body, context: { ...context, cutoff: future } };
    const tampered = { ...changed, hash: resetHash(changed) };
    await expect(applyTestDataReset(fixture.pool, tampered, tampered.hash)).rejects.toThrow(
      /future/,
    );
    expect((await fixture.pool.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n).toBe(
      1,
    );
  });
  it('verification refuses an unmanaged connection and never advances its phase', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    await applyTestDataReset(fixture.pool, manifest, manifest.hash);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + databaseName;
    const other = new pg.Pool({ connectionString: url.href, max: 1 });
    try {
      await other.query('SELECT 1');
      await expect(verifyTestDataReset(fixture.pool, manifest)).rejects.toThrow(/other clients/);
      expect(
        (await fixture.pool.query('SELECT phase FROM test_data_reset_operations')).rows[0].phase,
      ).toBe('DATABASE_COMMITTED');
    } finally {
      await other.end();
    }
    await expect(verifyTestDataReset(fixture.pool, manifest)).resolves.toMatchObject({
      state: 'VERIFIED',
    });
  });
  it('dry-run is read only; reset preserves all protected data and triggers; resume preserves new work', async () => {
    const before = await planTestDataReset(fixture.pool, context);
    expect(before.review).toEqual([]);
    expect(await planTestDataReset(fixture.pool, context)).toEqual(before);
    expect(
      (await fixture.pool.query('SELECT count(*)::int n FROM test_data_reset_operations')).rows[0]
        .n,
    ).toBe(0);
    await expect(applyTestDataReset(fixture.pool, before, 'wrong')).rejects.toThrow(/unconfirmed/);
    await expect(applyTestDataReset(fixture.pool, before, before.hash)).resolves.toMatchObject({
      phase: 'DATABASE_COMMITTED',
    });
    await expect(
      verifyTestDataReset(fixture.pool, {
        ...before,
        tables: before.tables.filter((t) => t.name !== 'users'),
      }),
    ).rejects.toThrow(/Manifest contents changed/);
    expect(
      (await fixture.pool.query('SELECT phase FROM test_data_reset_operations')).rows[0].phase,
    ).toBe('DATABASE_COMMITTED');
    await expect(verifyTestDataReset(fixture.pool, before)).resolves.toMatchObject({
      state: 'VERIFIED',
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT 1 FROM test_data_reset_replay_keys WHERE key_hash=encode(sha256(convert_to('old-key','UTF8')),'hex')",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await fixture.pool.query('SELECT count(*)::int n FROM idempotency_keys')).rows[0].n,
    ).toBe(0);
    expect((await fixture.pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBe(1);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM audit_logs WHERE action='ORDER_REQUEST_SUBMITTED'",
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      fixture.pool.query("DELETE FROM audit_logs WHERE action='ACCOUNT_STATUS_UPDATED'"),
    ).rejects.toThrow(/append-only/i);
    await fixture.pool.query(
      `INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES ('REAL','2026-10-01','2026-10-01T01:00:00Z','2026-10-01T02:00:00Z','real')`,
    );
    await expect(applyTestDataReset(fixture.pool, before, before.hash)).resolves.toMatchObject({
      resumed: true,
    });
    expect((await fixture.pool.query('SELECT code FROM order_sessions')).rows).toEqual([
      { code: 'PDH-000002' },
    ]);
    await seedReferenceData(fixture.db);
    await seedReferenceData(fixture.db);
    expect((await fixture.pool.query('SELECT code FROM order_sessions')).rows).toEqual([
      { code: 'PDH-000002' },
    ]);
  });
  it('refuses stale content, wrong database, unknown table and concurrent writer', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    await fixture.pool.query("UPDATE users SET display_name='changed' WHERE role='admin'");
    await expect(applyTestDataReset(fixture.pool, manifest, manifest.hash)).rejects.toThrow(
      /stale/,
    );
    const current = await planTestDataReset(fixture.pool, context);
    const other = new pg.Client({ connectionString: fixture.pool.options.connectionString });
    await other.connect();
    try {
      await expect(applyTestDataReset(fixture.pool, current, current.hash)).rejects.toThrow(
        /other clients/,
      );
    } finally {
      await other.end();
    }
    const wrong = { ...current, identity: { ...current.identity, database: 'different' } };
    const { hash: _hash, ...body } = wrong;
    wrong.hash = resetHash(body);
    await expect(applyTestDataReset(fixture.pool, wrong, wrong.hash)).rejects.toThrow(
      /Wrong database/,
    );
    await fixture.pool.query('CREATE SCHEMA surprise; CREATE TABLE surprise.payload(id int)');
    expect((await planTestDataReset(fixture.pool, context)).review).toContain(
      'Unreviewed relation surprise.payload',
    );
    expect((await fixture.pool.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n).toBe(
      1,
    );
  });
  it('rolls back TRUNCATE and scoped trigger change when a later insert fails', async () => {
    await fixture.pool.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT injected_failure CHECK(action<>'TEST_DATA_RESET')",
    );
    const client = await fixture.pool.connect();
    context.expectedSchemaHash = resetHash(await resetCatalog(client));
    client.release();
    const manifest = await planTestDataReset(fixture.pool, context);
    await expect(applyTestDataReset(fixture.pool, manifest, manifest.hash)).rejects.toThrow(
      /injected_failure/,
    );
    expect((await fixture.pool.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n).toBe(
      1,
    );
    expect(
      (await fixture.pool.query('SELECT count(*)::int n FROM test_data_reset_operations')).rows[0]
        .n,
    ).toBe(0);
    await expect(fixture.pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/i);
  });
  it('blocks historical months, rebases pending data, preserves baseline on increase/correction and blocks mapping changes', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    await applyTestDataReset(fixture.pool, manifest, manifest.hash);
    const base = {
      storeId,
      productId,
      period: '2026-09',
      type: 'normal',
      observed: 9000n,
      generatedAt: '2026-09-30T17:00:00Z',
      links: new Map([['source-id', productId]]),
    };
    await fixture.db.transaction(async (tx) => {
      expect(await resetAllowsSettlement(tx, storeId, productId, '2026-09', 'normal')).toBe(false);
      expect(await resetSaleBoundary(tx, { ...base, period: '2026-08' })).toEqual({ allow: false });
      expect(await resetSaleBoundary(tx, { ...base, generatedAt: '2026-09-30T16:00:00Z' })).toEqual(
        { allow: false },
      );
      expect(await resetSaleBoundary(tx, base)).toEqual({ allow: true, baseline: 9000n });
      expect(await resetSaleBoundary(tx, { ...base, observed: 12000n })).toEqual({
        allow: true,
        baseline: 9000n,
      });
      expect(await resetSaleBoundary(tx, { ...base, observed: 6000n })).toEqual({
        allow: true,
        baseline: 9000n,
      });
      expect(await resetSaleBoundary(tx, { ...base, period: '2026-10' })).toEqual({
        allow: true,
        baseline: 0n,
      });
      expect(
        await resetSaleBoundary(tx, { ...base, links: new Map([['changed-id', productId]]) }),
      ).toEqual({ allow: false });
      expect(await resetAllowsSettlement(tx, storeId, productId, '2026-09', 'normal')).toBe(false);
    });
  });
  it('a remap freezes settlement immediately, including before the next source sync', async () => {
    const manifest = await planTestDataReset(fixture.pool, context);
    await applyTestDataReset(fixture.pool, manifest, manifest.hash);
    await fixture.pool.query(
      "INSERT INTO idosi_product_links(idosi_product_id,product_id,first_seen_name) VALUES('source-id',$1,'Fixture')",
      [productId],
    );
    await fixture.db.transaction((tx) =>
      resetSaleBoundary(tx, {
        storeId,
        productId,
        period: '2026-09',
        type: 'normal',
        observed: 9000n,
        generatedAt: '2026-09-30T17:00:00Z',
        links: new Map([['source-id', productId]]),
      }),
    );
    expect(
      await fixture.db.transaction((tx) =>
        resetAllowsSettlement(tx, storeId, productId, '2026-09', 'normal'),
      ),
    ).toBe(true);
    const otherProduct = (
      await fixture.pool.query('SELECT id FROM products WHERE id<>$1 LIMIT 1', [productId])
    ).rows[0].id;
    const actor = (await fixture.pool.query("SELECT id FROM users WHERE role='admin'")).rows[0].id;
    await setIdosiProductLink(fixture.db, {
      idosiProductId: 'source-id',
      idosiProductName: 'Fixture',
      productId: otherProduct,
      reason: 'Fixture remap',
      actorUserId: actor,
      requestId: randomUUID(),
      ipAddress: null,
      userAgent: null,
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT status FROM test_data_reset_baselines WHERE store_id=$1 AND product_id=$2 AND revenue_type='normal'",
          [storeId, productId],
        )
      ).rows[0].status,
    ).toBe('mapping_review');
    expect(
      await fixture.db.transaction((tx) =>
        resetAllowsSettlement(tx, storeId, productId, '2026-09', 'normal'),
      ),
    ).toBe(false);
    // A signature mismatch also fails closed if a link was changed outside the normal setter.
    await fixture.pool.query(
      "UPDATE test_data_reset_baselines SET status='ready' WHERE store_id=$1 AND product_id=$2 AND revenue_type='normal'",
      [storeId, productId],
    );
    expect(
      await fixture.db.transaction((tx) =>
        resetAllowsSettlement(tx, storeId, productId, '2026-09', 'normal'),
      ),
    ).toBe(false);
  });
  it.each(['NORMAL', 'SALE_KG', 'SALE_PIECE'] as const)(
    'preserves IDOSI %s snapshots and prevents old sales consuming newly received stock',
    async (type) => {
      const product = (
        await fixture.pool.query('SELECT id,name FROM products WHERE id=$1', [productId])
      ).rows[0];
      const actor = (await fixture.pool.query("SELECT id FROM users WHERE role='store'")).rows[0]
        .id;
      const now = new Date();
      context.cutoff = new Date(now.getTime() - 1000).toISOString();
      const save = async (kg: number, offset: number, complete = true) => {
        const at = new Date(now.getTime() + offset);
        let payload = resetFixturePayload(product, kg, at, type, complete);
        // Incomplete piece-weight data must not block complete kg observations for this product.
        if (type === 'SALE_KG') {
          const incompletePiece = resetFixturePayload(product, 2, at, 'SALE_PIECE', false);
          payload = {
            ...payload,
            products: {
              ...payload.products,
              items: [...payload.products.items, ...incompletePiece.products.items],
            },
          };
        }
        await recordIdosiStatisticsSuccess(fixture.db, {
          target: { storeId, storeCode: 'RESET_FIXTURE', storeName: 'Fixture' },
          scope: {
            storeId,
            period: payload.filters.period,
            date: null,
            shiftId: null,
            paymentMethod: null,
          },
          payload,
          source: 'MANUAL',
          startedAt: at,
          completedAt: at,
          context: {
            actor: { userId: null, role: null, storeId: null },
            requestId: randomUUID(),
            ipAddress: null,
            userAgent: null,
          },
        });
      };
      await save(9, -2000);
      const manifest = await planTestDataReset(fixture.pool, context);
      await applyTestDataReset(fixture.pool, manifest, manifest.hash);
      await verifyTestDataReset(fixture.pool, manifest);
      expect(
        (await fixture.pool.query('SELECT count(*)::int n FROM idosi_statistics_snapshots')).rows[0]
          .n,
      ).toBe(1);
      await save(9, 0, false);
      await save(9, 1000);
      const resetType =
        type === 'NORMAL' ? 'normal' : type === 'SALE_KG' ? 'sale_kg' : 'sale_piece';
      expect(
        (
          await fixture.pool.query(
            "SELECT baseline_grams::text FROM test_data_reset_baselines WHERE store_id=$1 AND product_id=$2 AND revenue_type=$3 AND status='ready'",
            [storeId, productId, resetType],
          )
        ).rows,
      ).toEqual([{ baseline_grams: '9000' }]);
      await createStorePartnerInbound(fixture.db, {
        storeId,
        partnerName: 'Fixture',
        note: null,
        receivedAt: now,
        lines: [{ productId, quantity: 1, bagWeightsKg: ['10.000'] }],
        createdByUserId: actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
      });
      const bag = (await fixture.pool.query('SELECT id,version FROM store_inventory_bags LIMIT 1'))
        .rows[0];
      if (type !== 'NORMAL')
        await createStoreSorting(fixture.db, {
          storeId,
          inventoryBagId: bag.id,
          expectedInventoryVersion: bag.version,
          reason: 'SALE',
          weightKg: '10.000',
          actorUserId: actor,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        });
      else
        await openStoreInventoryBag(fixture.db, {
          storeId,
          bagId: bag.id,
          expectedVersion: bag.version,
          actorUserId: actor,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        });
      const stock = async () =>
        type !== 'NORMAL'
          ? (
              await fixture.pool.query(
                'SELECT sale_weight_kg AS weight FROM store_sorted_stocks LIMIT 1',
              )
            ).rows[0].weight
          : (
              await fixture.pool.query(
                'SELECT current_weight_kg AS weight FROM store_inventory_bags LIMIT 1',
              )
            ).rows[0].weight;
      expect(await stock()).toBe('10.000');
      await save(12, 2000);
      expect(await stock()).toBe('7.000');
      await save(12, 3000);
      expect(await stock()).toBe('7.000');
      await save(6, 4000);
      expect(await stock()).toBe('10.000');
    },
  );

  it('a new reviewed operation after a completed one resets current data and becomes the epoch', async () => {
    const first = await planTestDataReset(fixture.pool, context);
    await applyTestDataReset(fixture.pool, first, first.hash);
    await verifyTestDataReset(fixture.pool, first);
    await fixture.db.transaction((tx) =>
      resetSaleBoundary(tx, {
        storeId,
        productId,
        period: '2026-09',
        type: 'normal',
        observed: 9000n,
        generatedAt: '2026-09-30T17:00:00Z',
        links: new Map([['source-id', productId]]),
      }),
    );
    await fixture.pool.query("UPDATE test_data_reset_operations SET phase='COMPLETE' WHERE id=$1", [
      context.operationId,
    ]);
    // Business data accumulated after the first reset, including a write's idempotency key.
    await fixture.pool.query(
      `INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES ('AFTER','2026-10-01','2026-10-01T01:00:00Z','2026-10-01T02:00:00Z','real')`,
    );
    await fixture.pool
      .query(`INSERT INTO idempotency_keys(scope,key,request_hash,status,response_status,response_body,locked_until,expires_at)
      VALUES('fixture-order','second-key','fixture-hash','completed',200,'{"testPayload":"second"}',now(),now()+interval '1 day')`);

    const secondContext: ResetContext = {
      ...context,
      operationId: randomUUID(),
      cutoff: '2026-10-01T17:00:00.000Z',
      backupRetention: 'retain',
    };
    const second = await planTestDataReset(fixture.pool, secondContext);
    expect(second.review).toEqual([]);
    await expect(applyTestDataReset(fixture.pool, second, second.hash)).resolves.toMatchObject({
      resumed: false,
      phase: 'DATABASE_COMMITTED',
    });
    await expect(verifyTestDataReset(fixture.pool, second)).resolves.toMatchObject({
      state: 'VERIFIED',
    });
    expect((await fixture.pool.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n).toBe(
      0,
    );
    // Both generations of old keys are tombstoned; neither payload is kept.
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM test_data_reset_replay_keys WHERE key_hash IN (encode(sha256(convert_to('old-key','UTF8')),'hex'),encode(sha256(convert_to('second-key','UTF8')),'hex'))",
        )
      ).rows[0].n,
    ).toBe(2);
    // Baselines are rebased on the new cutoff's period; the first operation's are gone.
    expect(
      (
        await fixture.pool.query(
          'SELECT DISTINCT period,status FROM test_data_reset_baselines ORDER BY period',
        )
      ).rows,
    ).toEqual([{ period: '2026-10', status: 'pending' }]);
    // The maintenance log of the first operation is protected data for the second.
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM audit_logs WHERE action='TEST_DATA_RESET'",
        )
      ).rows[0].n,
    ).toBe(2);
    // Same query as the API epoch and the sale boundary: the latest cutoff is in effect.
    expect(
      (
        await fixture.pool.query(
          'SELECT id::text FROM test_data_reset_operations ORDER BY cutoff DESC, committed_at DESC, id DESC LIMIT 1',
        )
      ).rows[0].id,
    ).toBe(secondContext.operationId);
    expect(
      (
        await fixture.pool.query(
          "SELECT evidence->>'backupRetention' AS r FROM test_data_reset_operations WHERE id=$1",
          [secondContext.operationId],
        )
      ).rows[0].r,
    ).toBe('retain');
    await fixture.db.transaction(async (tx) => {
      const base = {
        storeId,
        productId,
        type: 'normal',
        observed: 4000n,
        links: new Map([['source-id', productId]]),
      };
      expect(
        await resetSaleBoundary(tx, {
          ...base,
          period: '2026-09',
          generatedAt: '2026-10-01T18:00:00Z',
        }),
      ).toEqual({ allow: false });
      expect(
        await resetSaleBoundary(tx, {
          ...base,
          period: '2026-10',
          generatedAt: '2026-10-01T16:00:00Z',
        }),
      ).toEqual({ allow: false });
      expect(
        await resetSaleBoundary(tx, {
          ...base,
          period: '2026-10',
          generatedAt: '2026-10-01T18:00:00Z',
        }),
      ).toEqual({ allow: true, baseline: 4000n });
    });

    // Replaying either earlier manifest only resumes; new work after the reset survives.
    await fixture.pool.query(
      `INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES ('NEW','2026-10-02','2026-10-02T01:00:00Z','2026-10-02T02:00:00Z','real')`,
    );
    await expect(applyTestDataReset(fixture.pool, first, first.hash)).resolves.toMatchObject({
      resumed: true,
    });
    await expect(applyTestDataReset(fixture.pool, second, second.hash)).resolves.toMatchObject({
      resumed: true,
    });
    expect((await fixture.pool.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n).toBe(
      1,
    );
  });
  it('refuses a new operation until the previous one is COMPLETE and its cutoff is passed', async () => {
    const first = await planTestDataReset(fixture.pool, context);
    await applyTestDataReset(fixture.pool, first, first.hash);
    const nextContext: ResetContext = {
      ...context,
      operationId: randomUUID(),
      cutoff: '2026-10-01T17:00:00.000Z',
    };
    const blocked = await planTestDataReset(fixture.pool, nextContext);
    expect(blocked.review).toContain(
      `Previous reset operation ${context.operationId} is DATABASE_COMMITTED, not COMPLETE`,
    );
    // A manifest stripped of its review findings is still refused under the maintenance lock.
    const { hash: _hash, ...body } = blocked;
    const forged = { ...body, review: [] };
    const forgedManifest = { ...forged, hash: resetHash(forged) };
    await expect(
      applyTestDataReset(fixture.pool, forgedManifest, forgedManifest.hash),
    ).rejects.toThrow(/not COMPLETE/);

    await fixture.pool.query("UPDATE test_data_reset_operations SET phase='COMPLETE' WHERE id=$1", [
      context.operationId,
    ]);
    expect(
      (await planTestDataReset(fixture.pool, { ...nextContext, cutoff: context.cutoff })).review,
    ).toContain(`Cutoff must be after previous reset operation ${context.operationId}`);
    await expect(
      planTestDataReset(fixture.pool, {
        ...nextContext,
        backupRetention: 'keep-everything' as never,
      }),
    ).rejects.toThrow(/backupRetention/);
    expect((await planTestDataReset(fixture.pool, nextContext)).review).toEqual([]);
    expect(
      (await fixture.pool.query('SELECT count(*)::int n FROM test_data_reset_operations')).rows[0]
        .n,
    ).toBe(1);
  });
});

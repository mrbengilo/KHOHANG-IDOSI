import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../../../packages/database/dist/client.js';
import { seedReferenceData } from '../../../packages/database/dist/reference-seed.js';
import {
  planTestDataReset,
  applyTestDataReset,
  verifyTestDataReset,
  EXPECTED_RESET_SCHEMA_HASH,
} from '../../../packages/database/dist/test-data-reset.js';
import { hashPassword } from '../../api/dist/security.js';

test('isolated reset keeps login/roles, rejects old writes and shows empty inventory at 390/1440', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const base = new URL(process.env.DATABASE_URL!);
  if (!/(_ci|_test|_fixture)$/.test(base.pathname))
    throw new Error('Reset E2E requires a named isolated fixture database');
  const admin = new pg.Pool({ connectionString: base.href, max: 1 });
  const name = `reset_browser_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  base.pathname = '/' + name;
  const fixture = createDatabase({ connectionString: base.href, max: 1 });
  let server: ChildProcess | undefined;
  const password = 'reset-fixture-password-only';
  const operationId = randomUUID();
  try {
    await migrate(drizzle(fixture.pool), {
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/migrations', import.meta.url),
      ),
    });
    await seedReferenceData(fixture.db);
    const hash = await hashPassword(password);
    const store = (await fixture.pool.query("SELECT id FROM stores WHERE kind='retail' LIMIT 1"))
      .rows[0].id;
    for (const [role, status] of [
      ['admin', 'active'],
      ['htkd', 'active'],
      ['store', 'active'],
      ['wholesale', 'active'],
      ['admin', 'locked'],
      ['admin', 'disabled'],
    ] as const) {
      await fixture.pool.query(
        'INSERT INTO users(email,password_hash,display_name,role,status,store_id) VALUES($1,$2,$1,$3,$4,$5)',
        [`reset.${role}.${status}`, hash, role, status, role === 'store' ? store : null],
      );
    }
    await fixture.pool.query(
      "INSERT INTO htkd_assignments(user_id,store_id) SELECT id,$1 FROM users WHERE role='htkd'",
      [store],
    );
    await fixture.pool.query(
      "INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES('TEST','2026-10-01','2026-10-01T01:00Z','2026-10-01T02:00Z','test')",
    );
    const manifest = await planTestDataReset(fixture.pool, {
      host: 'isolated-e2e',
      project: 'reset-fixture',
      release: '1'.repeat(40),
      operationId,
      cutoff: new Date().toISOString(),
      expectedSchemaHash: EXPECTED_RESET_SCHEMA_HASH,
      inventoryHash: '2'.repeat(64),
    });
    expect(manifest.review).toEqual([]);
    await applyTestDataReset(fixture.pool, manifest, manifest.hash);
    await verifyTestDataReset(fixture.pool, manifest);
    await fixture.close();
    server = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../api/dist/server.js', import.meta.url))],
      {
        env: {
          ...process.env,
          DATABASE_URL: base.href,
          API_STORAGE: 'postgres',
          API_HOST: '127.0.0.1',
          API_PORT: '3111',
          NODE_ENV: 'test',
          WEB_ORIGIN: 'http://127.0.0.1:4174',
          LOG_LEVEL: 'silent',
        },
        stdio: 'ignore',
      },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await request.get('http://127.0.0.1:3111/ready')).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
    const old = await request.post('http://127.0.0.1:3111/api/v1/auth/login', {
      data: { username: 'reset.admin.active', password },
      headers: { 'x-idosi-reset-epoch': '0' },
    });
    expect(old.status()).toBe(409);
    for (const role of ['admin', 'htkd', 'store', 'wholesale']) {
      const login = await request.post('http://127.0.0.1:3111/api/v1/auth/login', {
        data: { username: `reset.${role}.active`, password },
        headers: { 'x-idosi-reset-epoch': operationId },
      });
      expect(login.ok()).toBe(true);
      const accounts = await request.get('http://127.0.0.1:3111/api/v1/admin/accounts');
      expect(accounts.status()).toBe(role === 'admin' ? 200 : 403);
    }
    for (const status of ['locked', 'disabled']) {
      const login = await request.post('http://127.0.0.1:3111/api/v1/auth/login', {
        data: { username: `reset.admin.${status}`, password },
        headers: { 'x-idosi-reset-epoch': operationId },
      });
      expect(login.status()).toBe(403);
    }
    await page.route('http://127.0.0.1:3100/api/v1/**', async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(':3100/', ':3111/'),
      });
      await route.fulfill({ response });
    });
    await page.goto('/login');
    await page.getByLabel('Tên đăng nhập').fill('reset.admin.active');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('link', { name: 'Tồn kho / Lịch sử', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tồn kho & lịch sử', level: 1 })).toBeVisible();
    const zero = await request.post('http://127.0.0.1:3111/api/v1/auth/login', {
      data: { username: 'reset.admin.active', password },
      headers: { 'x-idosi-reset-epoch': operationId },
    });
    expect(zero.ok()).toBe(true);
    const balances = await request.get('http://127.0.0.1:3111/api/v1/warehouse-balances');
    expect(balances.ok()).toBe(true);
    for (const row of (await balances.json()).data) {
      expect(row.available.quantity).toBe(0);
      expect(row.reserved.quantity).toBe(0);
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`reset-inventory-${width}.png`),
        animations: 'disabled',
      });
    }
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, 'exit');
      server.kill('SIGTERM');
      await closed;
    }
    await fixture.close().catch(() => {});
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});

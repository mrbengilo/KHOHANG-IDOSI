// Retention-mode CLI rehearsal on an isolated database created on the test server. The pre-reset
// and clean "restores" are template copies, so no dump tooling or production config is needed;
// pg_dump/pg_restore round trips are covered by reset-cli.integration.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { inventoryBackupRoot } from './test-data-backups.mjs';
import { seedReferenceData } from '../../packages/database/dist/reference-seed.js';
import { createDatabase } from '../../packages/database/dist/client.js';
import {
  applyTestDataReset,
  planTestDataReset,
  resetHash,
  EXPECTED_RESET_SCHEMA_HASH,
} from '../../packages/database/dist/test-data-reset.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

function writeDump(directory, name, content) {
  const file = join(directory, name);
  writeFileSync(file, content, { mode: 0o600 });
  const digest = createHash('sha256').update(content).digest('hex');
  writeFileSync(file + '.sha256', `${digest}  ${basename(file)}\n`, { mode: 0o600 });
  return file;
}

test(
  'retention mode verifies a pre-reset backup, resets, and finishes without deleting any backup',
  { timeout: 120000, skip: process.env.RUN_POSTGRES_TESTS !== '1' },
  async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    const serverUrl = new URL(process.env.DATABASE_URL);
    assert.match(serverUrl.pathname, /(_ci|_test|_fixture)$/);
    const admin = new pg.Pool({ connectionString: serverUrl.href, max: 1 });
    const fixtureName = 'idosi_retention_fixture_' + randomUUID().replaceAll('-', '');
    const operationId = randomUUID();
    const cleanDatabase = 'idosi_reset_verify_' + operationId.replaceAll('-', '_');
    const rehearsal = cleanDatabase + '_pre';
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'idosi-retention-')));
    const backups = join(directory, 'backups');
    const state = join(directory, 'state');
    const created = [];
    const env = {
      ...process.env,
      RESET_HOST: 'isolated-retention-host',
      RESET_PROJECT: 'reset-retention-fixture',
      RESET_RELEASE: 'a'.repeat(40),
    };
    const fixtureUrl = new URL(serverUrl.href);
    fixtureUrl.pathname = '/' + fixtureName;
    const cli = (...args) =>
      execFileSync(process.execPath, [join(root, 'infra/scripts/reset-test-data.mjs'), ...args], {
        cwd: root,
        env: { ...env, DATABASE_URL: fixtureUrl.href },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });
    const failure = (...args) => {
      try {
        cli(...args);
      } catch (error) {
        return JSON.parse(String(error.stderr).trim().split('\n').at(-1)).message;
      }
      throw new Error('CLI command unexpectedly succeeded');
    };
    const copyFixture = async (name) => {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${fixtureName}"`);
      created.push(name);
    };
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(backups, { mode: 0o700 });
      mkdirSync(state, { mode: 0o700 });
      await admin.query(`CREATE DATABASE "${fixtureName}"`);
      created.push(fixtureName);
      let fixture = createDatabase({ connectionString: fixtureUrl.href, max: 1 });
      await migrate(drizzle(fixture.pool), {
        migrationsFolder: join(root, 'packages/database/migrations'),
      });
      await seedReferenceData(fixture.db);
      await fixture.pool.query(
        `INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES ('OLD','2026-09-30','2026-09-30T01:00:00Z','2026-09-30T02:00:00Z','test')`,
      );
      await fixture.close();

      const path = (name) => join(state, name);
      const draft = {
        host: env.RESET_HOST,
        project: env.RESET_PROJECT,
        release: env.RESET_RELEASE,
        operationId,
        cutoff: new Date().toISOString(),
        expectedSchemaHash: EXPECTED_RESET_SCHEMA_HASH,
        inventoryHash: '0'.repeat(64),
        backupRetention: 'retain',
      };
      writeFileSync(path('draft-context.json'), JSON.stringify(draft));
      const preDump = writeDump(backups, 'idosi-20261003T000000Z.dump', 'pre-reset dump');
      const preArgs = [
        '--command',
        'verify-pre-backup',
        '--context',
        path('draft-context.json'),
        '--restore-database',
        rehearsal,
        '--clean-root',
        backups,
        '--clean-file',
        preDump,
        '--output',
        path('pre-proof.json'),
      ];

      // A copy that does not match the live data is never accepted as the recovery backup.
      await copyFixture(rehearsal);
      const divergent = new pg.Pool({
        connectionString: fixtureUrl.href.replace(fixtureName, rehearsal),
        max: 1,
      });
      await divergent.query("UPDATE order_sessions SET policy_version='diverged'");
      await divergent.end();
      assert.match(failure(...preArgs), /does not reproduce the live database/);
      await admin.query(`DROP DATABASE "${rehearsal}"`);
      created.splice(created.indexOf(rehearsal), 1);

      await copyFixture(rehearsal);
      cli(...preArgs);
      created.splice(created.indexOf(rehearsal), 1);
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [rehearsal])).rowCount,
        0,
        'only the rehearsal copy created by this operation is dropped',
      );
      const preProof = JSON.parse(readFileSync(path('pre-proof.json'), 'utf8'));
      assert.equal(preProof.state, 'PRE_RESET_BACKUP_VERIFIED');
      assert.equal(preProof.files.length, 2);

      const inventory = await inventoryBackupRoot(backups);
      inventory.files.forEach((file) => (file.action = 'KEEP'));
      writeFileSync(path('backups.json'), JSON.stringify(inventory));
      const context = { ...draft, inventoryHash: resetHash({ backups: inventory, restores: [] }) };
      fixture = createDatabase({ connectionString: fixtureUrl.href, max: 1 });
      const manifest = await planTestDataReset(fixture.pool, context);
      assert.deepEqual(manifest.review, []);
      writeFileSync(path('manifest.json'), JSON.stringify(manifest));
      assert.equal(
        (await applyTestDataReset(fixture.pool, manifest, manifest.hash)).resumed,
        false,
      );
      await fixture.close();
      cli('--command', 'verify', '--manifest', path('manifest.json'));

      const cleanDump = writeDump(backups, 'idosi-20261003T010000Z.dump', 'clean dump');
      await copyFixture(cleanDatabase);
      cli(
        '--command',
        'verify',
        '--restore',
        '--restore-database',
        cleanDatabase,
        '--manifest',
        path('manifest.json'),
        '--clean-root',
        backups,
        '--clean-file',
        cleanDump,
        '--output',
        path('clean-proof.json'),
      );
      cli('--command', 'inventory-restores', '--output', path('restores-final.json'));
      const retainArgs = [
        '--command',
        'backups-retained',
        '--manifest',
        path('manifest.json'),
        '--inventory',
        path('backups.json'),
        '--restore-inventory',
        path('restores-final.json'),
        '--proof',
        path('clean-proof.json'),
        '--pre-proof',
        path('pre-proof.json'),
        '--output',
        path('complete.json'),
      ];
      // A recovery copy that went missing blocks completion; restoring it unchanged unblocks it.
      renameSync(preDump, preDump + '.moved');
      assert.match(failure(...retainArgs), /missing or its identity changed/);
      renameSync(preDump + '.moved', preDump);
      // PURGE is never accepted in retention mode.
      const purging = structuredClone(inventory);
      purging.files[0].action = 'PURGE';
      writeFileSync(path('purging.json'), JSON.stringify(purging));
      assert.match(
        failure(
          ...retainArgs.map((arg) => (arg === path('backups.json') ? path('purging.json') : arg)),
        ),
        /Backup or original restore inventory changed|PURGE is not allowed/,
      );

      assert.match(cli(...retainArgs), /BACKUPS_RETAINED/);
      for (const file of inventory.files) assert.ok(existsSync(file.path), `${file.path} kept`);
      assert.ok(existsSync(cleanDump));
      const complete = JSON.parse(readFileSync(path('complete.json'), 'utf8'));
      assert.equal(complete.phase, 'BACKUPS_RETAINED');
      assert.equal(complete.retainedBackupFiles, 2);
      assert.match(
        cli(
          '--command',
          'can-resume-writers',
          '--manifest',
          path('manifest.json'),
          '--proof',
          path('complete.json'),
        ),
        /safeToResumeWriters/,
      );
      const history = JSON.parse(cli('--command', 'history'));
      assert.deepEqual(
        history.map((row) => [row.id, row.phase]),
        [[operationId, 'BACKUPS_RETAINED']],
      );
    } finally {
      for (const name of created.reverse()) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
      }
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

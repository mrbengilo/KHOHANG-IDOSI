// A complete CLI / pg_dump / pg_restore / purge rehearsal. All destructive targets are created
// here in one disposable Docker cluster, never taken from DATABASE_URL or production config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seedReferenceData } from '../../packages/database/dist/reference-seed.js';
import { createDatabase } from '../../packages/database/dist/client.js';
import {
  resetHash,
  EXPECTED_RESET_SCHEMA_HASH,
} from '../../packages/database/dist/test-data-reset.js';

test(
  'complete isolated CLI rehearsal restores clean backup and purges only inventoried copies',
  { timeout: 180000 },
  async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'idosi-reset-cli-'));
    const backups = join(directory, 'backups');
    const container = 'idosi-reset-rehearsal-' + randomUUID();
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 });
    let fixture;
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(backups);
      docker(
        'run',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5432',
        '--mount',
        `type=bind,source=${backups},target=/backups`,
        '--env',
        'POSTGRES_PASSWORD=reset-rehearsal-only',
        '--env',
        'POSTGRES_DB=idosi_cli_fixture',
        'postgres:17.6-bookworm',
      );
      const port = docker('port', container, '5432/tcp').trim().split(':').at(-1);
      const url = `postgresql://postgres:reset-rehearsal-only@127.0.0.1:${port}/idosi_cli_fixture`;
      for (let attempt = 0; ; attempt++) {
        try {
          // The image first starts a socket-only initialization server, then restarts it.
          // Wait for TCP so migrations cannot race that intentional restart.
          docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres');
          break;
        } catch (error) {
          if (attempt === 30) throw error;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      fixture = createDatabase({ connectionString: url, max: 1 });
      await migrate(drizzle(fixture.pool), {
        migrationsFolder: join(root, 'packages/database/migrations'),
      });
      await seedReferenceData(fixture.db);
      await fixture.pool.query(
        "INSERT INTO users(email,password_hash,display_name,role) VALUES('reset-fixture','fixture-password-hash-long-enough','Fixture','admin')",
      );
      await fixture.pool.query(
        "INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES('test','2026-10-01','2026-10-01T01:00Z','2026-10-01T02:00Z','test')",
      );
      await fixture.close();
      fixture = undefined;
      const dump = (file) =>
        docker(
          'exec',
          container,
          'sh',
          '-ceu',
          `pg_dump -U postgres -Fc idosi_cli_fixture > /backups/${file}; cd /backups; sha256sum ${file} > ${file}.sha256`,
        );
      const restore = (file, name) => {
        docker('exec', container, 'createdb', '-U', 'postgres', name);
        docker(
          'exec',
          container,
          'pg_restore',
          '--exit-on-error',
          '-U',
          'postgres',
          '-d',
          name,
          `/backups/${file}`,
        );
      };
      dump('old.dump');
      restore('old.dump', 'idosi_verify_fixture');
      const env = {
        ...process.env,
        DATABASE_URL: url,
        RESET_HOST: 'fixture-host',
        RESET_PROJECT: 'fixture-project',
        RESET_RELEASE: '1'.repeat(40),
      };
      const cli = (...args) =>
        execFileSync(process.execPath, [join(root, 'infra/scripts/reset-test-data.mjs'), ...args], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 60000,
        });
      const files = (...args) =>
        execFileSync(
          process.execPath,
          [join(root, 'infra/scripts/purge-test-data-backups.mjs'), ...args],
          { cwd: root, env, encoding: 'utf8', timeout: 60000 },
        );
      const path = (name) => join(directory, name);
      files('--root', backups, '--output', path('backups.json'));
      const inventory = JSON.parse(readFileSync(path('backups.json'), 'utf8'));
      inventory.files.forEach((file) => (file.action = 'PURGE'));
      writeFileSync(path('backups.json'), JSON.stringify(inventory));
      cli('--command', 'inventory-restores', '--output', path('restores.json'));
      const restores = JSON.parse(readFileSync(path('restores.json'), 'utf8'));
      const operationId = randomUUID();
      const context = {
        host: env.RESET_HOST,
        project: env.RESET_PROJECT,
        release: env.RESET_RELEASE,
        operationId,
        cutoff: new Date().toISOString(),
        expectedSchemaHash: EXPECTED_RESET_SCHEMA_HASH,
        inventoryHash: resetHash({ backups: inventory, restores }),
      };
      writeFileSync(path('context.json'), JSON.stringify(context));
      cli(
        '--context',
        path('context.json'),
        '--inventory',
        path('backups.json'),
        '--restore-inventory',
        path('restores.json'),
        '--output',
        path('manifest.json'),
      );
      const manifest = JSON.parse(readFileSync(path('manifest.json'), 'utf8'));
      const applyArgs = [
        '--command',
        'apply',
        '--manifest',
        path('manifest.json'),
        '--inventory',
        path('backups.json'),
        '--restore-inventory',
        path('restores.json'),
        '--confirm',
        manifest.hash,
      ];
      cli(...applyArgs);
      cli('--command', 'verify', '--manifest', path('manifest.json'));
      dump('clean.dump');
      const cleanDatabase = 'idosi_reset_verify_' + operationId.replaceAll('-', '_');
      restore('clean.dump', cleanDatabase);
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
        join(backups, 'clean.dump'),
        '--output',
        path('proof.json'),
      );
      cli('--command', 'inventory-restores', '--output', path('final-restores.json'));
      const finalCopies = JSON.parse(readFileSync(path('final-restores.json'), 'utf8'));
      cli(
        '--command',
        'drop-restores',
        '--restore-inventory',
        path('final-restores.json'),
        '--proof',
        path('proof.json'),
        '--confirm',
        resetHash(finalCopies),
      );
      const backupHash = files('--command', 'hash', '--manifest', path('backups.json')).trim();
      files(
        '--command',
        'purge',
        '--manifest',
        path('backups.json'),
        '--proof',
        path('proof.json'),
        '--confirm',
        backupHash,
        '--journal',
        path('purge.jsonl'),
      );
      cli(
        '--command',
        'backups-verified',
        '--manifest',
        path('manifest.json'),
        '--inventory',
        path('backups.json'),
        '--restore-inventory',
        path('final-restores.json'),
        '--proof',
        path('proof.json'),
        '--output',
        path('complete.json'),
      );
      assert.match(
        cli(
          '--command',
          'can-resume-writers',
          '--manifest',
          path('manifest.json'),
          '--proof',
          path('complete.json'),
        ),
        /true/,
      );
      assert.equal(existsSync(join(backups, 'old.dump')), false);
      assert.equal(existsSync(join(backups, 'clean.dump')), true);
      const check = new pg.Pool({ connectionString: url, max: 1 });
      try {
        await check.query(
          "INSERT INTO order_sessions(code,business_date,inventory_snapshot_due_at,request_deadline_at,policy_version) VALUES('real','2026-10-02','2026-10-02T01:00Z','2026-10-02T02:00Z','real')",
        );
        assert.match(cli(...applyArgs), /resumed.*true/);
        assert.equal(
          (await check.query('SELECT count(*)::int n FROM order_sessions')).rows[0].n,
          1,
        );
      } finally {
        await check.end();
      }
    } finally {
      if (fixture) await fixture.close();
      docker('rm', '--force', '--volumes', container);
      assert.equal(dirname(realpathSync(directory)), resolve(tmpdir()));
      assert.ok(directory.includes('idosi-reset-cli-'));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

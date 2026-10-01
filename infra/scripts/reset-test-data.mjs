#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, basename } from 'node:path';
import pg from 'pg';
import { inventoryBackupRoot } from './test-data-backups.mjs';
import {
  planTestDataReset,
  applyTestDataReset,
  resetCatalog,
  resetHash,
  verifyTestDataReset,
  EXPECTED_RESET_SCHEMA_HASH,
  inventoryDatabaseCopy,
} from '../../packages/database/dist/test-data-reset.js';

const { values } = parseArgs({
  options: {
    command: { type: 'string', default: 'plan' },
    context: { type: 'string' },
    manifest: { type: 'string' },
    output: { type: 'string' },
    confirm: { type: 'string' },
    'operation-id': { type: 'string' },
    restore: { type: 'boolean' },
    'clean-root': { type: 'string' },
    'clean-file': { type: 'string' },
    inventory: { type: 'string' },
    proof: { type: 'string' },
    'restore-inventory': { type: 'string' },
    'health-url': { type: 'string' },
    'restore-database': { type: 'string' },
  },
});
const connectionUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
if (values['restore-database']) {
  if (
    !connectionUrl ||
    values.command !== 'verify' ||
    !values.restore ||
    !/^idosi_reset_verify_[a-f0-9_]+$/.test(values['restore-database'])
  )
    throw new Error('Invalid clean restore target');
  connectionUrl.pathname = '/' + values['restore-database'];
}
const pool = new pg.Pool({
  connectionString: connectionUrl?.href,
  max: 1,
  application_name: 'idosi-test-reset',
  connectionTimeoutMillis: 10000,
});
function checkExecutionContext(context) {
  if (context.expectedSchemaHash !== EXPECTED_RESET_SCHEMA_HASH)
    throw new Error('Schema is not the reviewed release schema');
  if (
    context.host !== process.env.RESET_HOST ||
    context.project !== process.env.RESET_PROJECT ||
    context.release !== process.env.RESET_RELEASE
  )
    throw new Error('Execution host/project/release differs from manifest');
}
async function checkBackupInventory(context) {
  if (!values.inventory || !values['restore-inventory'])
    throw new Error('Reviewed backup and restore inventory required');
  const backups = JSON.parse(await readFile(values.inventory, 'utf8'));
  const restores = JSON.parse(await readFile(values['restore-inventory'], 'utf8'));
  if (resetHash({ backups, restores }) !== context.inventoryHash)
    throw new Error('Inventory hash mismatch');
  if (backups.files.some((f) => !['KEEP', 'PURGE'].includes(f.action)))
    throw new Error('Backup classification incomplete');
  const strip = ({ action: _action, ...file }) => file;
  if (
    resetHash(await inventoryBackupRoot(backups.root)) !==
    resetHash({ root: backups.root, files: backups.files.map(strip) })
  )
    throw new Error('Backup inventory changed');
  const actual = await pool.query(
    "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN (current_database(),'postgres') ORDER BY datname",
  );
  if (
    resetHash(actual.rows.map((r) => r.datname).sort()) !==
    resetHash(restores.map((r) => r.identity.database).sort())
  )
    throw new Error('Restore inventory changed');
  for (const copy of restores) {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + copy.identity.database;
    const target = new pg.Pool({ connectionString: url.href, max: 1 });
    try {
      if ((await inventoryDatabaseCopy(target)).hash !== copy.hash)
        throw new Error('Restore database content changed');
    } finally {
      await target.end();
    }
  }
}
async function checkCleanProof(proof) {
  if (proof.state !== 'CLEAN_RESTORE_VERIFIED' || proof.cleanFiles?.length !== 2)
    throw new Error('Clean backup restore proof missing');
  const root = dirname(proof.cleanFiles[0].path);
  const current = await inventoryBackupRoot(root);
  for (const file of proof.cleanFiles)
    if (resetHash(current.files.find((f) => f.path === file.path) ?? null) !== resetHash(file))
      throw new Error('Clean backup changed or missing');
  const operation = await pool.query(
    "SELECT 1 FROM test_data_reset_operations WHERE id=$1 AND manifest_hash=$2 AND phase IN ('VERIFIED','BACKUPS_PURGED','COMPLETE')",
    [proof.operationId, proof.manifestHash],
  );
  if (!operation.rowCount) throw new Error('Clean proof belongs to another operation');
}
try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  if (values.command === 'schema') {
    const client = await pool.connect();
    try {
      console.log(resetHash(await resetCatalog(client)));
    } finally {
      client.release();
    }
  } else if (values.command === 'plan') {
    if (!values.context || !values.output) throw new Error('--context and --output required');
    const context = JSON.parse(await readFile(values.context, 'utf8'));
    checkExecutionContext(context);
    await checkBackupInventory(context);
    const manifest = await planTestDataReset(pool, context);
    await writeFile(values.output, JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        operationId: context.operationId,
        manifestHash: manifest.hash,
        review: manifest.review,
        tables: manifest.tables.map(({ name, action, count, expectedCount }) => ({
          name,
          action,
          count,
          expectedCount,
        })),
      }),
    );
    if (manifest.review.length) process.exitCode = 2;
  } else if (values.command === 'apply') {
    if (!values.manifest || !values.confirm)
      throw new Error('--manifest and --confirm HASH required');
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    checkExecutionContext(manifest.context);
    // Once committed, resume must query the journal rather than validate a pre-reset inventory
    // that may already have been purged. It still cannot execute the database reset twice.
    const committed = await pool.query('SELECT 1 FROM test_data_reset_operations WHERE id=$1', [
      manifest.context.operationId,
    ]);
    if (!committed.rowCount) await checkBackupInventory(manifest.context);
    console.log(JSON.stringify(await applyTestDataReset(pool, manifest, values.confirm)));
  } else if (values.command === 'verify') {
    if (!values.manifest) throw new Error('--manifest required');
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    const result = await verifyTestDataReset(pool, manifest, values.restore);
    if (values.restore) {
      if (!values.output || !values['clean-root'] || !values['clean-file'])
        throw new Error('Restore proof requires --output --clean-root --clean-file');
      const inventory = await inventoryBackupRoot(values['clean-root']);
      const cleanFiles = inventory.files.filter(
        (file) =>
          file.path === values['clean-file'] || file.path === values['clean-file'] + '.sha256',
      );
      if (cleanFiles.length !== 2) throw new Error('Clean dump and checksum sidecar both required');
      const dump = cleanFiles.find((file) => file.path === values['clean-file']);
      if (
        (await readFile(values['clean-file'] + '.sha256', 'utf8')).trim() !==
        `${dump.sha256}  ${basename(dump.path)}`
      )
        throw new Error('Clean backup checksum sidecar does not match dump');
      await writeFile(
        values.output,
        JSON.stringify({
          ...result,
          operationId: manifest.context.operationId,
          manifestHash: manifest.hash,
          cleanFiles,
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    }
    console.log(JSON.stringify(result));
  } else if (values.command === 'inventory-restores') {
    if (!values.output) throw new Error('--output required');
    const databases = await pool.query(
      "SELECT datname FROM pg_database WHERE datname ~ '^idosi_(verify_|policy_verify_|reset_verify_)' ORDER BY datname",
    );
    const copies = [];
    for (const { datname } of databases.rows) {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = '/' + datname;
      const target = new pg.Pool({ connectionString: url.href, max: 1 });
      try {
        copies.push(await inventoryDatabaseCopy(target));
      } finally {
        await target.end();
      }
    }
    await writeFile(values.output, JSON.stringify(copies, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        copies: copies.map((c) => ({ database: c.identity.database, hash: c.hash })),
      }),
    );
  } else if (values.command === 'drop-restores') {
    if (!values['restore-inventory'] || !values.proof || !values.confirm)
      throw new Error('Restore inventory, clean proof, and confirmation required');
    const copies = JSON.parse(await readFile(values['restore-inventory'], 'utf8'));
    if (resetHash(copies) !== values.confirm)
      throw new Error('Restore inventory confirmation mismatch');
    const proof = JSON.parse(await readFile(values.proof, 'utf8'));
    await checkCleanProof(proof);
    const cluster = (
      await pool.query('SELECT system_identifier::text AS id FROM pg_control_system()')
    ).rows[0].id;
    for (const copy of copies) {
      const name = copy.identity.database;
      if (copy.identity.cluster_id !== cluster) throw new Error('Wrong restore cluster');
      if (!/^idosi_(verify_|policy_verify_|reset_verify_)[a-z0-9_]+$/.test(name))
        throw new Error('Unreviewed restore database name');
      if (name === new URL(process.env.DATABASE_URL).pathname.slice(1))
        throw new Error('Cannot drop current database');
      const exists = await pool.query('SELECT oid::text FROM pg_database WHERE datname=$1', [name]);
      if (!exists.rowCount) {
        console.log(JSON.stringify({ database: name, state: 'ABSENT' }));
        continue;
      }
      if (exists.rows[0].oid !== copy.identity.database_oid)
        throw new Error('Restore database identity changed');
      if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [name])).rowCount)
        throw new Error('Restore database has active clients');
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = '/' + name;
      const target = new pg.Pool({ connectionString: url.href, max: 1 });
      try {
        if ((await inventoryDatabaseCopy(target)).hash !== copy.hash)
          throw new Error('Restore copy changed; replan');
      } finally {
        await target.end();
      }
      // PostgreSQL itself rejects DROP if a client appears; do not use FORCE or terminate it.
      await pool.query(`DROP DATABASE "${name}"`);
      console.log(JSON.stringify({ database: name, state: 'PURGED' }));
    }
  } else if (values.command === 'backups-verified') {
    if (
      !values.manifest ||
      !values.inventory ||
      !values.proof ||
      !values['restore-inventory'] ||
      !values.output
    )
      throw new Error('Database/backup/restore manifests, proof and output required');
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    const inventory = JSON.parse(await readFile(values.inventory, 'utf8'));
    const proof = JSON.parse(await readFile(values.proof, 'utf8'));
    const copies = JSON.parse(await readFile(values['restore-inventory'], 'utf8'));
    if (proof.state !== 'CLEAN_RESTORE_VERIFIED' || proof.manifestHash !== manifest.hash)
      throw new Error('Clean restore proof does not match reset');
    await checkCleanProof(proof);
    const after = await inventoryBackupRoot(inventory.root);
    for (const clean of proof.cleanFiles)
      if (resetHash(after.files.find((f) => f.path === clean.path)) !== resetHash(clean))
        throw new Error('Clean backup no longer matches proof');
    const kept = new Set([
      ...proof.cleanFiles.map((f) => f.path),
      ...inventory.files.filter((f) => f.action === 'KEEP').map((f) => f.path),
    ]);
    if (
      after.files.some((f) => !kept.has(f.path)) ||
      inventory.files.some((f) => !['KEEP', 'PURGE'].includes(f.action))
    )
      throw new Error('Backup purge not complete');
    for (const copy of copies)
      if (
        (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [copy.identity.database]))
          .rowCount
      )
        throw new Error('A restore database remains');
    await verifyTestDataReset(pool, manifest);
    const evidence = {
      manifestHash: manifest.hash,
      cleanProofHash: resetHash(proof),
      backupInventoryHash: resetHash(inventory),
      restoreInventoryHash: resetHash(copies),
    };
    const update = await pool.query(
      "UPDATE test_data_reset_operations SET phase='BACKUPS_PURGED',evidence=evidence||$2::jsonb,updated_at=now() WHERE id=$1 AND manifest_hash=$3 AND phase IN ('VERIFIED','BACKUPS_PURGED') RETURNING id",
      [manifest.context.operationId, JSON.stringify(evidence), manifest.hash],
    );
    if (!update.rowCount) throw new Error('Reset verification phase missing');
    await writeFile(
      values.output,
      JSON.stringify({
        ...evidence,
        operationId: manifest.context.operationId,
        phase: 'BACKUPS_PURGED',
      }) + '\n',
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ phase: 'BACKUPS_PURGED' }));
  } else if (values.command === 'can-resume-writers') {
    if (!values.manifest || !values.proof)
      throw new Error('Manifest and completion evidence required');
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    const proof = JSON.parse(await readFile(values.proof, 'utf8'));
    const result = await pool.query(
      "SELECT phase,evidence FROM test_data_reset_operations WHERE id=$1 AND manifest_hash=$2 AND phase IN ('BACKUPS_PURGED','COMPLETE')",
      [manifest.context.operationId, manifest.hash],
    );
    if (
      !result.rowCount ||
      proof.operationId !== manifest.context.operationId ||
      proof.manifestHash !== manifest.hash ||
      proof.backupInventoryHash !== result.rows[0].evidence.backupInventoryHash
    )
      throw new Error('Backup completion is not recorded for this operation');
    console.log(JSON.stringify({ safeToResumeWriters: true }));
  } else if (values.command === 'complete') {
    if (!values['operation-id'] || !values['health-url'])
      throw new Error('Operation and public health URL required');
    for (const url of [
      new URL('/health', values['health-url']),
      new URL('/ready', values['health-url']),
      new URL('http://worker:3001/ready'),
    ]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Service health/readiness verification failed');
    }
    const update = await pool.query(
      "UPDATE test_data_reset_operations SET phase='COMPLETE',updated_at=now() WHERE id=$1 AND phase='BACKUPS_PURGED' RETURNING id",
      [values['operation-id']],
    );
    if (!update.rowCount) throw new Error('Backup phase not complete');
    console.log(JSON.stringify({ phase: 'COMPLETE' }));
  } else if (values.command === 'status') {
    if (!values['operation-id']) throw new Error('--operation-id required');
    const result = await pool.query(
      'SELECT id,manifest_hash,cutoff,phase,committed_at,updated_at FROM test_data_reset_operations WHERE id=$1',
      [values['operation-id']],
    );
    console.log(JSON.stringify(result.rows));
  } else throw new Error('Unsupported command');
} catch (error) {
  // Database errors can embed values and credentials; only our safe diagnostics leave the CLI.
  console.error(
    JSON.stringify({
      event: 'reset_failed',
      message:
        error instanceof Error && !('code' in error)
          ? error.message
          : 'Database operation failed; inspect protected server diagnostics',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

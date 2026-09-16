import { spawn } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const lockWaitMs =
  parseBoundedInteger(
    process.env.MIGRATION_LOCK_TIMEOUT_SECONDS ?? '300',
    'MIGRATION_LOCK_TIMEOUT_SECONDS',
    1,
    3_600,
  ) * 1_000;
const databaseLockTimeoutMs = parseBoundedInteger(
  process.env.MIGRATION_DB_LOCK_TIMEOUT_MS ?? '10000',
  'MIGRATION_DB_LOCK_TIMEOUT_MS',
  1_000,
  300_000,
);
const statementTimeoutMs = parseBoundedInteger(
  process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? '300000',
  'MIGRATION_STATEMENT_TIMEOUT_MS',
  1_000,
  3_600_000,
);

// Stable, application-specific pair of signed 32-bit advisory-lock keys.
const migrationLockKeys = [1_229_210_963, 1_000_001];
const client = new Client({
  application_name: 'idosi-migration-lock',
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
});

let lockAcquired = false;
let migrationProcess;
let receivedSignal;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    receivedSignal = signal;
    migrationProcess?.kill(signal);
  });
}

try {
  await client.connect();
  const deadline = Date.now() + lockWaitMs;

  while (Date.now() < deadline) {
    if (receivedSignal) {
      throw new Error(`Migration lock wait was interrupted by ${receivedSignal}.`);
    }

    const result = await client.query(
      'select pg_try_advisory_lock($1, $2) as acquired',
      migrationLockKeys,
    );

    if (result.rows[0]?.acquired === true) {
      lockAcquired = true;
      break;
    }

    await delay(2_000);
  }

  if (!lockAcquired) {
    throw new Error(`Could not acquire the migration lock within ${lockWaitMs / 1_000} seconds.`);
  }

  console.log(JSON.stringify({ event: 'migration_lock_acquired' }));

  await runMigrationCommand({
    ...process.env,
    NODE_ENV: 'production',
    PGOPTIONS: [
      process.env.PGOPTIONS?.trim(),
      `-c lock_timeout=${databaseLockTimeoutMs}`,
      `-c statement_timeout=${statementTimeoutMs}`,
    ]
      .filter(Boolean)
      .join(' '),
  });

  console.log(JSON.stringify({ event: 'migrations_completed' }));
} catch (error) {
  const message = redactSensitiveValue(
    error instanceof Error ? error.message : 'Unknown migration failure.',
    databaseUrl,
  );
  console.error(JSON.stringify({ event: 'migrations_failed', message }));
  process.exitCode = 1;
} finally {
  if (lockAcquired) {
    try {
      await client.query('select pg_advisory_unlock($1, $2)', migrationLockKeys);
      console.log(JSON.stringify({ event: 'migration_lock_released' }));
    } catch {
      console.error(JSON.stringify({ event: 'migration_lock_release_failed' }));
      process.exitCode = 1;
    }
  }

  try {
    await client.end();
  } catch {
    process.exitCode = 1;
  }
}

if (receivedSignal) {
  process.kill(process.pid, receivedSignal);
}

function runMigrationCommand(environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    migrationProcess = spawn('npm', ['-w', '@idosi/database', 'run', 'migrate'], {
      env: environment,
      shell: false,
      stdio: 'inherit',
    });

    migrationProcess.once('error', rejectPromise);
    migrationProcess.once('exit', (code, signal) => {
      migrationProcess = undefined;
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          signal
            ? `Migration command was terminated by ${signal}.`
            : `Migration command exited with status ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
}

function parseBoundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    console.error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    process.exit(1);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function redactSensitiveValue(message, sensitiveValue) {
  return sensitiveValue ? message.replaceAll(sensitiveValue, '[REDACTED_DATABASE_URL]') : message;
}

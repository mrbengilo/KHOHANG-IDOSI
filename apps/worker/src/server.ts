import { createDatabase } from '@idosi/database';

import { loadConfig } from './config.js';
import { startHealthServer } from './health-server.js';
import {
  IdosiStatisticsSyncWorker,
  PostgresScheduledIdosiSyncRepository,
  startIdosiSyncPolling,
} from './idosi-sync.js';
import { createLogger } from './logger.js';
import { PostgresAllocationJobRepository } from './postgres-repository.js';
import { AllocationWorker, startPolling } from './worker.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const client = createDatabase({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'idosi-allocation-worker',
});
const repository = new PostgresAllocationJobRepository(client);
const worker = new AllocationWorker(repository, {
  catchUpDays: config.catchUpDays,
  timeZone: config.timeZone,
  maxSessionsPerTick: config.maxSessionsPerTick,
  logger,
});
const health = await startHealthServer(worker, {
  host: config.healthHost,
  port: config.healthPort,
});
const polling = startPolling(worker, config.pollMs);
const idosiSyncWorker = config.idosiIntegrationSecret
  ? new IdosiStatisticsSyncWorker(new PostgresScheduledIdosiSyncRepository(client.db), {
      endpoint: config.idosiIntegrationEndpoint,
      secret: config.idosiIntegrationSecret,
      timeZone: config.timeZone,
      maxStoresPerTick: config.maxSessionsPerTick,
      logger,
    })
  : null;
const idosiPolling = idosiSyncWorker ? startIdosiSyncPolling(idosiSyncWorker, config.pollMs) : null;
let shuttingDown: Promise<void> | null = null;

logger.info(
  {
    catchUpDays: config.catchUpDays,
    healthHost: config.healthHost,
    healthPort: health.port,
    pollMs: config.pollMs,
    timeZone: config.timeZone,
    idosiSchedulerEnabled: idosiPolling !== null,
  },
  'allocation worker started',
);
if (!idosiPolling) {
  logger.warn(
    { integration: 'idosi-statistics' },
    'scheduled IDOSI statistics sync disabled because its server secret is not configured',
  );
}

const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    logger.info({ signal }, 'allocation worker stopping');
    const timeout = setTimeout(() => {
      logger.error({ signal }, 'allocation worker graceful shutdown timed out');
      process.exitCode = 1;
    }, config.shutdownTimeoutMs);
    timeout.unref();
    try {
      await health.close();
      await Promise.all([polling.stop(), idosiPolling?.stop()]);
      logger.info({ signal }, 'allocation worker stopped');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), signal },
        'allocation worker shutdown failed',
      );
      process.exitCode = 1;
    } finally {
      await repository.close().catch((error: unknown) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error), signal },
          'allocation worker database close failed',
        );
        process.exitCode = 1;
      });
      clearTimeout(timeout);
    }
  })();
  return shuttingDown;
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error({ error: error.message }, 'uncaught exception');
  process.exitCode = 1;
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    { error: reason instanceof Error ? reason.message : String(reason) },
    'unhandled rejection',
  );
  process.exitCode = 1;
  void shutdown('SIGTERM');
});

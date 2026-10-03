import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(config: PoolConfig = {}): DatabaseClient {
  const clientPool = new Pool(config);
  const clientDb = drizzle(clientPool, { schema });

  return {
    db: clientDb,
    pool: clientPool,
    close: async () => clientPool.end(),
  };
}

/**
 * Server-side bounds for every session of the API pool (the default client). Without them a
 * statement queued behind a lock, or a transaction left open by a stuck request, keeps its pool
 * connection and row/advisory locks indefinitely: the browser deadline only abandons the
 * response. lock_timeout < statement_timeout < the 60 s browser read deadline, so the API ends
 * with a rolled-back, reportable outcome before the client gives up. Maintenance code that
 * needs longer still raises its own limit with `SET LOCAL`.
 */
export const apiSessionTimeouts = {
  lock_timeout: 30_000,
  statement_timeout: 50_000,
  idle_in_transaction_session_timeout: 60_000,
} as const satisfies PoolConfig;

/** The worker allocates and prunes in bulk off the request path, so it may wait longer. */
export const workerSessionTimeouts = {
  lock_timeout: 60_000,
  statement_timeout: 300_000,
  idle_in_transaction_session_timeout: 300_000,
} as const satisfies PoolConfig;

const defaultClient = createDatabase({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...apiSessionTimeouts,
});

export const db = defaultClient.db;
export const pool = defaultClient.pool;

export async function closeDatabase(): Promise<void> {
  await defaultClient.close();
}

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

const defaultClient = createDatabase({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = defaultClient.db;
export const pool = defaultClient.pool;

export async function closeDatabase(): Promise<void> {
  await defaultClient.close();
}

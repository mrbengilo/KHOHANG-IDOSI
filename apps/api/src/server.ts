import { createApi } from './app.js';

const environment = process.env.NODE_ENV ?? 'development';
const storage = process.env.API_STORAGE ?? 'postgres';
const port = parsePort(process.env.API_PORT ?? process.env.PORT ?? '3000');
const host = process.env.API_HOST ?? process.env.HOST ?? '0.0.0.0';
const sessionTtlMs = parseSessionTtl(process.env.SESSION_TTL_HOURS ?? '12');

if (environment === 'production' && storage !== 'postgres') {
  throw new Error('API_STORAGE must be "postgres" in production');
}
if (environment === 'production' && !process.env.WEB_ORIGIN?.trim()) {
  throw new Error('WEB_ORIGIN is required in production');
}

const repository =
  storage === 'memory'
    ? await createMemoryRepository()
    : storage === 'postgres'
      ? await createPostgresRepository()
      : throwUnsupportedStorage(storage);

const app = await createApi({
  repository,
  sessionTtlMs,
  ...(process.env.WEB_ORIGIN ? { corsOrigin: splitOrigins(process.env.WEB_ORIGIN) } : {}),
  secureCookies: environment === 'production',
  logger: { level: process.env.LOG_LEVEL?.trim() || 'info' },
  ...(process.env.IDOSI_INTEGRATION_ENDPOINT?.trim()
    ? { idosiIntegrationEndpoint: process.env.IDOSI_INTEGRATION_ENDPOINT.trim() }
    : {}),
  ...(process.env.IDOSI_INTEGRATION_SECRET?.trim()
    ? { idosiIntegrationSecret: process.env.IDOSI_INTEGRATION_SECRET.trim() }
    : {}),
  // Only honor forwarding headers from loopback or RFC1918/ULA reverse proxies.
  trustProxy: ['loopback', 'uniquelocal'],
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutdown requested');
  await app.close();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host, port });

async function createMemoryRepository() {
  const { MemoryWarehouseRepository } = await import('./memory-repository.js');
  return MemoryWarehouseRepository.create({
    bootstrapPassword: process.env.MEMORY_BOOTSTRAP_PASSWORD ?? 'IDOSI-local-only-2026!',
  });
}

async function createPostgresRepository() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for postgres storage');
  const { PostgresWarehouseRepository } = await import('./postgres-repository.js');
  return new PostgresWarehouseRepository();
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('API_PORT must be an integer from 1 through 65535');
  }
  return parsed;
}

function parseSessionTtl(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error('SESSION_TTL_HOURS must be greater than 0 and at most 168');
  }
  return Math.round(hours * 60 * 60 * 1_000);
}

function splitOrigins(value: string): readonly string[] {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error('WEB_ORIGIN must contain at least one origin');
  return origins;
}

function throwUnsupportedStorage(storage: string): never {
  throw new Error(`Unsupported API_STORAGE value: ${storage}`);
}

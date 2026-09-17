export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly catchUpDays: number;
  readonly pollMs: number;
  readonly maxSessionsPerTick: number;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly timeZone: string;
  readonly logLevel: LogLevel;
  readonly shutdownTimeoutMs: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  const storage = env.WORKER_STORAGE?.trim() || 'postgres';
  if (storage !== 'postgres') {
    throw new Error(`Unsupported WORKER_STORAGE ${storage}; only postgres is durable.`);
  }
  const timeZone = env.TZ?.trim() || 'Asia/Ho_Chi_Minh';
  validateTimeZone(timeZone);

  return {
    databaseUrl,
    catchUpDays: integer(env.WORKER_CATCH_UP_DAYS, 0, 0, 30, 'WORKER_CATCH_UP_DAYS'),
    pollMs: integer(env.WORKER_POLL_MS, 30_000, 250, 3_600_000, 'WORKER_POLL_MS'),
    maxSessionsPerTick: integer(
      env.WORKER_MAX_SESSIONS_PER_TICK,
      50,
      1,
      1_000,
      'WORKER_MAX_SESSIONS_PER_TICK',
    ),
    healthHost: env.WORKER_HEALTH_HOST?.trim() || '0.0.0.0',
    healthPort: integer(env.WORKER_HEALTH_PORT, 3001, 0, 65_535, 'WORKER_HEALTH_PORT'),
    timeZone,
    logLevel: logLevel(env.LOG_LEVEL),
    shutdownTimeoutMs: integer(
      env.WORKER_SHUTDOWN_TIMEOUT_MS,
      55_000,
      1_000,
      300_000,
      'WORKER_SHUTDOWN_TIMEOUT_MS',
    ),
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function logLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase() || 'info';
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  throw new Error(`LOG_LEVEL must be debug, info, warn, or error (received ${value}).`);
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`TZ is not a valid IANA time zone: ${timeZone}.`);
  }
}

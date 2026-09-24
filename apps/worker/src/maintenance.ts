import type { MaintenanceResult } from '@idosi/database';

import type { WorkerLogger } from './types.js';

/** Retention runs a few times a day; each run deletes at most one batch per table. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface MaintenanceLoop {
  stop(): Promise<void>;
}

/**
 * Runs `prune` shortly after start and then every `intervalMs`. Failures are logged and retried
 * at the next run; maintenance must never disturb the allocation loop.
 */
export function startMaintenancePolling(
  prune: (now: Date) => Promise<MaintenanceResult>,
  options: {
    readonly intervalMs?: number;
    readonly firstRunDelayMs?: number;
    readonly logger?: WorkerLogger;
    readonly now?: () => Date;
  } = {},
): MaintenanceLoop {
  const intervalMs = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timeout: NodeJS.Timeout | null = null;
  let active: Promise<void> = Promise.resolve();

  const run = async (): Promise<void> => {
    try {
      const result = await prune(now());
      options.logger?.info({ ...result }, 'maintenance pruned expired operational records');
    } catch (error) {
      options.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'maintenance run failed',
      );
    } finally {
      schedule(intervalMs);
    }
  };
  const schedule = (delay: number): void => {
    if (stopped) return;
    timeout = setTimeout(() => {
      active = run();
    }, delay);
    timeout.unref();
  };
  schedule(options.firstRunDelayMs ?? 60_000);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      await active;
    },
  };
}

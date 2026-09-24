import { describe, expect, it, vi } from 'vitest';

import { startMaintenancePolling } from '../src/maintenance.js';

describe('maintenance polling', () => {
  it('runs after the first delay, repeats, survives failures and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const prune = vi
        .fn()
        .mockRejectedValueOnce(new Error('database busy'))
        .mockResolvedValue({ sessions: 1, idempotencyKeys: 2 });
      const loop = startMaintenancePolling(prune, {
        intervalMs: 1_000,
        firstRunDelayMs: 100,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(prune).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ error: 'database busy' }, 'maintenance run failed');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(prune).toHaveBeenCalledTimes(2);
      await loop.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(prune).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

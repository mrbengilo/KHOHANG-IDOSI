const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_TRACKED_CLIENTS = 10_000;

export interface LoginRateLimitOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

interface FailureWindow {
  readonly startedAt: number;
  failures: number;
}

/** Small per-process guard against password guessing and expensive scrypt abuse. */
export class LoginRateLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, FailureWindow>();

  public constructor(options: LoginRateLimitOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxFailures) || this.maxFailures <= 0) {
      throw new Error('login rate-limit maxFailures must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs <= 0) {
      throw new Error('login rate-limit windowMs must be a positive safe integer');
    }
  }

  public retryAfterMs(clientKey: string): number {
    const current = this.windows.get(clientKey);
    if (!current) return 0;
    const elapsed = this.now() - current.startedAt;
    if (elapsed >= this.windowMs || elapsed < 0) {
      this.windows.delete(clientKey);
      return 0;
    }
    return current.failures >= this.maxFailures ? this.windowMs - elapsed : 0;
  }

  public recordFailure(clientKey: string): void {
    const instant = this.now();
    const current = this.windows.get(clientKey);
    if (!current || instant - current.startedAt >= this.windowMs || instant < current.startedAt) {
      this.ensureCapacity();
      this.windows.set(clientKey, { startedAt: instant, failures: 1 });
      return;
    }
    current.failures += 1;
  }

  public reset(clientKey: string): void {
    this.windows.delete(clientKey);
  }

  private ensureCapacity(): void {
    if (this.windows.size < MAX_TRACKED_CLIENTS) return;
    const oldestKey = this.windows.keys().next().value as string | undefined;
    if (oldestKey !== undefined) this.windows.delete(oldestKey);
  }
}

/**
 * Spaces out an action per key: acquire() returns 0 and starts a new interval when the key is
 * free, otherwise the milliseconds left. Bounded like the login limiter.
 */
export class ManualSyncThrottle {
  private readonly lastStarted = new Map<string, number>();

  public constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('sync throttle interval must be a positive safe integer');
    }
  }

  public acquire(key: string): number {
    const instant = this.now();
    const previous = this.lastStarted.get(key);
    if (previous !== undefined && instant >= previous && instant - previous < this.intervalMs) {
      return this.intervalMs - (instant - previous);
    }
    if (this.lastStarted.size >= MAX_TRACKED_CLIENTS) {
      const oldestKey = this.lastStarted.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.lastStarted.delete(oldestKey);
    }
    this.lastStarted.delete(key);
    this.lastStarted.set(key, instant);
    return 0;
  }
}

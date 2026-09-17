export interface RetryAttempt {
  readonly fingerprint: string;
  readonly key: string;
}

export function retainIdempotencyForExactRetry(
  current: RetryAttempt | null,
  fingerprint: string,
  createKey: () => string = () => crypto.randomUUID(),
): RetryAttempt {
  return current?.fingerprint === fingerprint ? current : { fingerprint, key: createKey() };
}

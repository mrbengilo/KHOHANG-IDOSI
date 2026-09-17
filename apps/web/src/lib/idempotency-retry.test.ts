import { describe, expect, it, vi } from 'vitest';
import { retainIdempotencyForExactRetry } from './idempotency-retry';

describe('idempotency retry selection', () => {
  it('retains the key only while the exact mutation fingerprint is retried', () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce('first-key')
      .mockReturnValueOnce('second-key');

    const first = retainIdempotencyForExactRetry(null, 'offer-1:ACCEPT:3', createKey);
    const exactRetry = retainIdempotencyForExactRetry(first, 'offer-1:ACCEPT:3', createKey);
    const changedRequest = retainIdempotencyForExactRetry(
      exactRetry,
      'offer-1:DECLINE:busy',
      createKey,
    );

    expect(first.key).toBe('first-key');
    expect(exactRetry).toBe(first);
    expect(changedRequest.key).toBe('second-key');
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});

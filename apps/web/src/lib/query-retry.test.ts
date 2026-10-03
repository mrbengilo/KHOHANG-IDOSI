import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './api';
import { shouldRetryQuery } from './query-retry';

const failure = (status: number, code?: string) => new ApiClientError('x', status, code);

describe('shouldRetryQuery', () => {
  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
    [409, 'CONFLICT'],
    [500, 'INTERNAL_ERROR'],
    [503, 'SERVICE_BUSY'],
    [0, 'REQUEST_TIMEOUT'],
    [0, 'INVALID_RESPONSE'],
  ])('does not repeat a deterministic %s %s failure', (status, code) => {
    expect(shouldRetryQuery(0, failure(status, code))).toBe(false);
  });

  it.each([
    [0, 'NETWORK_ERROR'],
    [429, 'RATE_LIMITED'],
    [502, 'HTTP_ERROR'],
    [503, 'HTTP_ERROR'],
    [504, 'HTTP_ERROR'],
  ])('repeats a transient %s %s failure once', (status, code) => {
    expect(shouldRetryQuery(0, failure(status, code))).toBe(true);
    expect(shouldRetryQuery(1, failure(status, code))).toBe(false);
  });

  it('does not repeat schema or programming errors', () => {
    expect(shouldRetryQuery(0, new TypeError('bad payload'))).toBe(false);
  });

  it('a 403 reaches the error state after a single request', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: 0 } },
    });
    const forbidden = vi.fn(async () => {
      throw failure(403, 'FORBIDDEN');
    });
    await expect(
      client.fetchQuery({ queryKey: ['forbidden'], queryFn: forbidden }),
    ).rejects.toThrow();
    expect(forbidden).toHaveBeenCalledTimes(1);

    const flaky = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure(0, 'NETWORK_ERROR'))
      .mockResolvedValueOnce('ok');
    await expect(client.fetchQuery({ queryKey: ['flaky'], queryFn: flaky })).resolves.toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

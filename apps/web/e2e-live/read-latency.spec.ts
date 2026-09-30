import { expect, test } from '@playwright/test';

test('records bounded read latency under single and four-reader concurrency', async ({
  request,
}, testInfo) => {
  const api = 'http://127.0.0.1:3100/api/v1';
  expect(
    (
      await request.post(`${api}/auth/login`, {
        data: {
          username: process.env.LIVE_E2E_ADMIN_USERNAME ?? 'ci.admin',
          password:
            process.env.LIVE_E2E_ADMIN_PASSWORD ?? 'ci-bootstrap-password-not-for-production',
        },
      })
    ).status(),
  ).toBe(200);
  const samples = [];
  for (const path of [
    '/warehouse-inventory',
    '/order-requests?pageSize=50',
    '/store-receipts?pageSize=50',
  ]) {
    const warmup = await request.get(`${api}${path}`);
    expect(warmup.status()).toBe(200);
    const payload = await warmup.json();
    for (const concurrency of [1, 4]) {
      const elapsed: number[] = [];
      const bytes: number[] = [];
      let remaining = 32;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (remaining-- > 0) {
            const start = performance.now();
            const response = await request.get(`${api}${path}`);
            const body = await response.body();
            expect(response.status()).toBe(200);
            elapsed.push(performance.now() - start);
            bytes.push(body.length);
          }
        }),
      );
      elapsed.sort((a, b) => a - b);
      const percentile = (p: number) => elapsed[Math.ceil(elapsed.length * p) - 1];
      samples.push({
        path,
        concurrency,
        requests: elapsed.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxResponseBytes: Math.max(...bytes),
        pagination: payload.pagination ?? null,
        returnedRows: Array.isArray(payload.data) ? payload.data.length : null,
      });
    }
  }
  await testInfo.attach('read-latency', {
    body: JSON.stringify(samples, null, 2),
    contentType: 'application/json',
  });
});

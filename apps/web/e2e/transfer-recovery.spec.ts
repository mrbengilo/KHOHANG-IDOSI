import { expect, test } from '@playwright/test';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-09-29T03:00:00.000Z';
const pagination = { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 };

test('legacy transfer retries a lost response with the same command key and payload', async ({
  page,
}) => {
  const transfer = {
    id: id(10),
    transferNumber: 'TR-RECOVERY-001',
    sourceStoreId: id(1),
    destinationStoreId: id(2),
    sourceInventoryBagId: id(3),
    destinationInventoryBagId: null,
    productId: id(4),
    weightKg: '5.250',
    costVnd: 525000,
    status: 'IN_TRANSIT',
    note: null,
    cancellationReason: null,
    version: 1,
    createdByAccountId: id(5),
    dispatchedByAccountId: id(5),
    receivedByAccountId: null,
    createdAt: time,
    dispatchedAt: time,
    receivedAt: null,
    cancelledAt: null,
    updatedAt: time,
  };
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let received = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (data: unknown) => route.fulfill({ json: data });
    if (path.endsWith('/auth/session'))
      return respond({
        data: {
          id: id(8),
          createdAt: time,
          lastSeenAt: time,
          expiresAt: '2099-09-29T03:00:00.000Z',
          principal: {
            accountId: id(5),
            username: 'recovery.store',
            displayName: 'Recovery store',
            role: 'STORE',
            status: 'ACTIVE',
            storeId: id(2),
            assignedStoreIds: [],
          },
        },
      });
    if (path.endsWith('/stores') || path.endsWith('/store-transfers/destinations'))
      return respond({
        data: [1, 2].map((n) => ({
          id: id(n),
          code: `TEST-${n}`,
          name: `Cửa hàng ${n}`,
          groupId: id(6),
          kind: 'RETAIL',
          status: 'ACTIVE',
          address: null,
          version: 0,
          createdAt: time,
          updatedAt: time,
        })),
        ...(path.endsWith('/stores') ? { pagination: { ...pagination, totalItems: 2 } } : {}),
      });
    if (path.endsWith('/products'))
      return respond({
        data: [
          {
            id: id(4),
            sku: 'RECOVERY',
            name: 'Áo kiểm thử',
            measurement: 'UNIT',
            unitLabel: 'bao',
            status: 'ACTIVE',
            createdAt: time,
            updatedAt: time,
          },
        ],
        pagination,
      });
    if (path.endsWith('/receive')) {
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postData(),
      });
      // Model a commit followed by loss of the response; replay is the only safe retry.
      received = true;
      if (attempts.length === 1) return route.abort('failed');
      if (attempts[0].key !== attempts[1].key)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Command already committed',
              requestId: 'recovery',
            },
          },
        });
      return respond({
        data: {
          ...transfer,
          status: 'RECEIVED',
          version: 2,
          receivedAt: time,
          receivedByAccountId: id(5),
          destinationInventoryBagId: id(9),
        },
      });
    }
    if (path.endsWith('/store-transfers'))
      return respond({
        data: [
          {
            ...transfer,
            ...(received
              ? {
                  status: 'RECEIVED',
                  version: 2,
                  receivedAt: time,
                  receivedByAccountId: id(5),
                  destinationInventoryBagId: id(9),
                }
              : {}),
          },
        ],
        pagination,
      });
    if (path.endsWith('/store-sorted-stocks') || path.endsWith('/sorted-sale-transfers'))
      return respond({ data: [] });
    return respond({ data: [], pagination: { ...pagination, totalItems: 0, totalPages: 0 } });
  });
  await page.goto('/transfers');
  await page.getByText('Xem phiếu TR-RECOVERY-001', { exact: true }).click();
  const receive = page.getByRole('button', { name: 'Xác nhận đã nhận đủ', exact: true });
  await receive.click();
  await expect(page.locator('.operation-notice[role="alert"]')).toContainText('Chưa xác định');
  await receive.click();
  await expect(page.getByRole('status')).toContainText('Đã xác nhận nhận phiếu TR-RECOVERY-001');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
});

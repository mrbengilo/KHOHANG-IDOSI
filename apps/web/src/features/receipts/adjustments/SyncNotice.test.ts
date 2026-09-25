import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../../lib/api';
import { syncNoticeText } from './SyncNotice';

const updatedAt = Date.parse('2026-09-25T03:04:05.000Z');

describe('stale data notice after a failed refresh', () => {
  it('says nothing while data is current or before anything loaded', () => {
    expect(
      syncNoticeText({ data: [], dataUpdatedAt: updatedAt, error: null, isError: false }),
    ).toBeNull();
    // A first-load failure is an error state of its own, not a stale-data notice.
    expect(
      syncNoticeText({ data: undefined, dataUpdatedAt: 0, error: new Error('x'), isError: true }),
    ).toBeNull();
  });

  it('keeps showing the last data and names why it is not newer', () => {
    const offline = syncNoticeText({
      data: [],
      dataUpdatedAt: updatedAt,
      error: new ApiClientError('Không thể kết nối máy chủ.', 0, 'NETWORK_ERROR'),
      isError: true,
    });
    expect(offline).toContain('Mất kết nối máy chủ');
    expect(offline).toContain('10:04:05');
    expect(
      syncNoticeText({
        data: [],
        dataUpdatedAt: updatedAt,
        error: new ApiClientError('Forbidden', 403, 'FORBIDDEN'),
        isError: true,
      }),
    ).toContain('không còn quyền');
  });
});

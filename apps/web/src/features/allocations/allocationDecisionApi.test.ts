import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../../lib/api';
import {
  decisionCode,
  decisionStatusLabel,
  isUncertainOutcome,
  listAllocationDecisions,
  respondAllocationDecision,
  respondErrorMessage,
  shipmentProgressLabel,
} from './allocationDecisionApi';
import { testDecision } from './testDecision';

describe('allocation decision API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pages PENDING decisions on the server and parses the response strictly', async () => {
    const decision = testDecision();
    const { sources: _sources, ...summary } = decision;
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [summary],
          pagination: { page: 1, pageSize: 5, totalItems: 7, totalPages: 2 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const page = await listAllocationDecisions({ status: 'PENDING', pageSize: 5 });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      '/allocation-decisions?page=1&pageSize=5&status=PENDING',
    );
    expect(page.pagination.totalItems).toBe(7);
    expect(page.data[0]?.status).toBe('PENDING');
  });

  it('sends only the action, the seen version and the idempotency key', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: testDecision({ status: 'ACCEPTED', version: 2 }) }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const updated = await respondAllocationDecision(
      testDecision().id,
      { action: 'ACCEPT', expectedVersion: 1 },
      'decision-key-0001',
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'ACCEPT', expectedVersion: 1 });
    expect(new Headers(init.headers).get('idempotency-key')).toBe('decision-key-0001');
    expect(updated.status).toBe('ACCEPTED');
  });

  it('retries with the same key only when the outcome is unknown', () => {
    expect(isUncertainOutcome(new ApiClientError('offline', 0, 'NETWORK_ERROR'))).toBe(true);
    expect(isUncertainOutcome(new DOMException('deadline', 'TimeoutError'))).toBe(true);
    expect(isUncertainOutcome(new ApiClientError('stale', 409, 'VERSION_CONFLICT'))).toBe(false);
    expect(isUncertainOutcome(new ApiClientError('nope', 403, 'FORBIDDEN'))).toBe(false);
    expect(isUncertainOutcome(new ApiClientError('bad', 400, 'VALIDATION_ERROR'))).toBe(false);
    expect(respondErrorMessage(new ApiClientError('offline', 0))).toContain('Chưa rõ');
    expect(respondErrorMessage(new ApiClientError('Đã được chấp nhận', 409))).toBe(
      'Đã được chấp nhận',
    );
  });

  it('labels the rejection exactly and never calls an accepted result received', () => {
    expect(decisionStatusLabel.REJECTED).toBe('đã từ chối nhận');
    expect(decisionCode(testDecision())).toBe('KQ-PDH-000042-A1B2C3D4');
    const accepted = testDecision({
      status: 'ACCEPTED',
      shipment: { ...testDecision().shipment!, status: 'DISPATCHED' },
    });
    expect(shipmentProgressLabel(accepted)).toBe('Đã xuất kho, chờ cửa hàng khai nhận');
    expect(shipmentProgressLabel(testDecision())).toContain('Chờ cửa hàng xác nhận');
    expect(shipmentProgressLabel(testDecision({ status: 'ACCEPTED', shipment: null }))).toContain(
      'giao chung',
    );
    expect(shipmentProgressLabel(testDecision({ status: 'REJECTED' }))).toContain('từ chối');
  });
});

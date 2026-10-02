import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../lib/api';
import { checkAdjustmentDraft, isUnknownWriteOutcome } from './WarehouseAdjustmentDialog';

const row = { onHandBags: 10, reservedBags: 4, availableBags: 6, productActive: true };
const draft = {
  direction: 'INCREASE' as const,
  quantity: '3',
  reasonCode: 'COUNT_CORRECTION' as const,
  reason: 'Kiểm kê dư',
};

describe('warehouse adjustment draft', () => {
  it('previews before → change → after for increases and decreases', () => {
    expect(checkAdjustmentDraft(row, draft)).toEqual({
      ok: true,
      quantity: 3,
      delta: 3,
      after: { onHand: 13, reserved: 4, available: 9 },
    });
    expect(checkAdjustmentDraft(row, { ...draft, direction: 'DECREASE', quantity: '2' })).toEqual({
      ok: true,
      quantity: 2,
      delta: -2,
      after: { onHand: 8, reserved: 4, available: 4 },
    });
  });

  it('refuses decreases into reserved bags and malformed quantities', () => {
    const below = checkAdjustmentDraft(row, { ...draft, direction: 'DECREASE', quantity: '7' });
    expect(below.ok).toBe(false);
    expect(below.ok ? '' : below.message).toContain('tối đa 6 bao');
    for (const quantity of ['', '0', '-1', '1.5', 'abc', '1e3', '100001']) {
      expect(checkAdjustmentDraft(row, { ...draft, quantity }).ok).toBe(false);
    }
  });

  it('requires a reason and keeps an inactive product decrease-only', () => {
    expect(checkAdjustmentDraft(row, { ...draft, reason: '  ab ' }).ok).toBe(false);
    const inactive = { ...row, productActive: false };
    expect(checkAdjustmentDraft(inactive, draft).ok).toBe(false);
    expect(checkAdjustmentDraft(inactive, { ...draft, direction: 'DECREASE' }).ok).toBe(true);
  });

  it('treats lost responses as unknown outcomes but never 4xx refusals', () => {
    expect(isUnknownWriteOutcome(new ApiClientError('net', 0, 'NETWORK_ERROR'))).toBe(true);
    expect(isUnknownWriteOutcome(new ApiClientError('boom', 502, 'HTTP_ERROR'))).toBe(true);
    expect(isUnknownWriteOutcome(new DOMException('late', 'TimeoutError'))).toBe(true);
    for (const [status, code] of [
      [403, 'FORBIDDEN'],
      [400, 'VALIDATION_ERROR'],
      [409, 'VERSION_CONFLICT'],
      [409, 'INSUFFICIENT_STOCK'],
    ] as const) {
      expect(isUnknownWriteOutcome(new ApiClientError('no', status, code))).toBe(false);
    }
  });
});

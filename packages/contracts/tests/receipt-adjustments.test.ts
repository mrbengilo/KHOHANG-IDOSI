import { describe, expect, it } from 'vitest';

import {
  ListReceiptAdjustmentsQuerySchema,
  ReceiptAdjustmentHistoryEventSchema,
  ReceiptAdjustmentHistoryQuerySchema,
  ReceiptAdjustmentListItemSchema,
} from '../src/index.js';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';

describe('receipt adjustment list query', () => {
  it('defaults to the report date and a 20-row server page', () => {
    expect(ListReceiptAdjustmentsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      dateField: 'REPORTED',
    });
  });

  it('accepts search, status, store and an inclusive Vietnam date window', () => {
    const query = ListReceiptAdjustmentsQuerySchema.parse({
      page: '2',
      pageSize: '50',
      storeId: id,
      status: 'PENDING_ADMIN',
      q: '  PSL-0001 ',
      dateField: 'DECIDED',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(query).toMatchObject({
      page: 2,
      pageSize: 50,
      q: 'PSL-0001',
      dateField: 'DECIDED',
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('rejects reversed windows, invalid dates, blank or long search and unknown keys', () => {
    for (const input of [
      { from: '2026-09-30', to: '2026-09-01' },
      { from: '2026-02-30' },
      { q: '   ' },
      { q: 'x'.repeat(41) },
      { dateField: 'APPLIED' },
      { pageSize: '101' },
      { sort: 'code' },
    ]) {
      expect(
        ListReceiptAdjustmentsQuerySchema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
  });
});

describe('receipt adjustment list item projection', () => {
  const item = {
    id,
    code: 'PSL-000001',
    receiptId: other,
    receiptNumber: 'PNH-000001',
    storeId: other,
    storeCode: 'Q1',
    storeName: 'Cửa hàng Quận 1',
    status: 'APPLIED',
    version: 2,
    reason: 'Bao là jeans',
    cause: 'SOURCE_MISCLASSIFICATION',
    lineCount: 1,
    shortageQuantity: 1,
    goodsDeltaVnd: -200_000,
    reportedBy: { accountId: id, displayName: 'Cửa hàng', username: 'store.q1' },
    reportedAt: '2026-09-25T01:00:00.000Z',
    verifiedBy: { accountId: other, displayName: null, username: null },
    verifiedAt: '2026-09-25T02:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    appliedAt: null,
    updatedAt: '2026-09-25T02:00:00.000Z',
  };

  it('carries store and people names, keeping unreadable accounts as ids', () => {
    expect(ReceiptAdjustmentListItemSchema.parse(item)).toEqual(item);
  });

  it('never accepts a floating-point money delta', () => {
    expect(ReceiptAdjustmentListItemSchema.safeParse({ ...item, goodsDeltaVnd: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('receipt adjustment history', () => {
  const event = {
    id,
    occurredAt: '2026-09-25T03:00:00.000Z',
    type: 'APPLIED',
    action: 'RECEIPT_ADJUSTMENT_APPLIED',
    subject: 'ADJUSTMENT',
    returnCode: null,
    actor: { accountId: id, displayName: 'Admin', username: 'admin', role: 'ADMIN' },
    store: { storeId: other, code: 'Q1', name: 'Cửa hàng Quận 1' },
    statusBefore: 'PENDING_ADMIN',
    statusAfter: 'APPLIED',
    note: null,
    changes: {
      reason: null,
      evidenceNote: null,
      cause: null,
      lineCount: 1,
      goodsDeltaVnd: -200_000,
      freightDeltaVnd: 0,
      handlingDeltaVnd: 0,
      vatDeltaVnd: 0,
      totalBeforeVnd: 3_000_000,
      totalAfterVnd: 2_800_000,
      costBeforeVnd: 3_000_000,
      costAfterVnd: 2_800_000,
      appliedSequence: 1,
      releasedBagCount: null,
      returnCount: 0,
      entitlementCount: 1,
    },
  };

  it('accepts an event with an unrecorded actor and unknown action', () => {
    expect(ReceiptAdjustmentHistoryEventSchema.parse(event)).toEqual(event);
    expect(
      ReceiptAdjustmentHistoryEventSchema.parse({
        ...event,
        type: 'OTHER',
        action: 'SOMETHING_NEW',
        actor: { accountId: null, displayName: null, username: null, role: null },
        statusBefore: null,
        statusAfter: null,
      }).type,
    ).toBe('OTHER');
  });

  it('never carries raw audit fields such as request id or IP address', () => {
    expect(
      ReceiptAdjustmentHistoryEventSchema.safeParse({ ...event, ipAddress: '10.0.0.1' }).success,
    ).toBe(false);
    expect(
      ReceiptAdjustmentHistoryEventSchema.safeParse({
        ...event,
        changes: { ...event.changes, requestId: 'x' },
      }).success,
    ).toBe(false);
  });

  it('pages the timeline like every other list', () => {
    expect(ReceiptAdjustmentHistoryQuerySchema.parse({ page: '3' })).toEqual({
      page: 3,
      pageSize: 20,
    });
  });
});

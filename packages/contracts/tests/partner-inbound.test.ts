import { describe, expect, it } from 'vitest';

import {
  CreateStorePartnerInboundRequestSchema,
  formatPartnerInboundNumber,
  StorePartnerInboundSchema,
} from '../src/partner-inbound.js';
import { StoreInventoryBagSchema } from '../src/store-inventory.js';

const STORE = '20000000-0000-4000-8000-000000000001';
const PRODUCT = '20000000-0000-4000-8000-000000000002';
const OTHER_PRODUCT = '20000000-0000-4000-8000-000000000003';
const ACTOR = '20000000-0000-4000-8000-000000000004';
const SLIP = '20000000-0000-4000-8000-000000000005';
const PARTNER_BAG = '20000000-0000-4000-8000-000000000006';
const RECEIPT_BAG = '20000000-0000-4000-8000-000000000007';

const request = (overrides: Record<string, unknown> = {}) => ({
  storeId: STORE,
  partnerName: 'Đối tác Bình Minh',
  note: null,
  receivedAt: '2026-09-22T10:00:00+07:00',
  lines: [{ productId: PRODUCT, quantity: 2, bagWeightsKg: ['45.500', '40.000'] }],
  ...overrides,
});

describe('partner inbound contracts', () => {
  it('accepts one weight for every received unit', () => {
    const parsed = CreateStorePartnerInboundRequestSchema.parse(request());
    expect(parsed.lines[0]?.bagWeightsKg).toEqual(['45.500', '40.000']);
    expect(parsed.note).toBeNull();
  });

  it('rejects a line whose weights do not match its quantity', () => {
    expect(() =>
      CreateStorePartnerInboundRequestSchema.parse(
        request({ lines: [{ productId: PRODUCT, quantity: 3, bagWeightsKg: ['1.000'] }] }),
      ),
    ).toThrow();
  });

  it('rejects a product listed twice in one slip', () => {
    expect(() =>
      CreateStorePartnerInboundRequestSchema.parse(
        request({
          lines: [
            { productId: PRODUCT, quantity: 1, bagWeightsKg: ['1.000'] },
            { productId: PRODUCT, quantity: 1, bagWeightsKg: ['2.000'] },
          ],
        }),
      ),
    ).toThrow();
  });

  it('rejects a zero or negative bag weight', () => {
    for (const weight of ['0.000', '-1.000']) {
      expect(() =>
        CreateStorePartnerInboundRequestSchema.parse(
          request({ lines: [{ productId: PRODUCT, quantity: 1, bagWeightsKg: [weight] }] }),
        ),
      ).toThrow();
    }
  });

  it('keeps the stored totals equal to the lines they summarize', () => {
    const slip = {
      id: SLIP,
      referenceCode: 'PNDT00001-22/09/2026',
      storeId: STORE,
      partnerName: 'Đối tác Bình Minh',
      note: null,
      lines: [
        { productId: PRODUCT, quantity: 2, bagWeightsKg: ['45.500', '40.000'] },
        { productId: OTHER_PRODUCT, quantity: 1, bagWeightsKg: ['10.250'] },
      ],
      totalQuantity: 3,
      totalWeightKg: '95.750',
      createdByAccountId: ACTOR,
      receivedAt: '2026-09-22T10:00:00+07:00',
      createdAt: '2026-09-22T10:00:00+07:00',
      updatedAt: '2026-09-22T10:00:00+07:00',
    };
    expect(StorePartnerInboundSchema.parse(slip).totalWeightKg).toBe('95.750');
    expect(() => StorePartnerInboundSchema.parse({ ...slip, totalQuantity: 2 })).toThrow();
    expect(() => StorePartnerInboundSchema.parse({ ...slip, totalWeightKg: '95.000' })).toThrow();
  });

  it('numbers slips on the Vietnam calendar date regardless of server timezone', () => {
    // 17:30 UTC is already the next day in Ho Chi Minh City.
    expect(formatPartnerInboundNumber('7', new Date('2026-09-21T17:30:00Z'))).toBe(
      'PNDT00007-22/09/2026',
    );
    expect(() => formatPartnerInboundNumber('0', new Date())).toThrow();
  });
});

describe('store inventory provenance', () => {
  const bag = {
    id: '20000000-0000-4000-8000-000000000008',
    storeId: STORE,
    productId: PRODUCT,
    sourceReceiptBagId: null,
    outboundOrderId: null,
    sourceTransferId: null,
    sourceInventoryBagId: null,
    bagCode: 'PIB-0001',
    originalWeightKg: '45.500',
    receivedWeightKg: '45.500',
    remainingWeightKg: '45.500',
    status: 'AVAILABLE' as const,
    version: 0,
    receivedAt: '2026-09-22T10:00:00+07:00',
    updatedAt: '2026-09-22T10:00:00+07:00',
  };

  it('accepts partner stock as its own provenance source', () => {
    const parsed = StoreInventoryBagSchema.parse({
      ...bag,
      sourcePartnerInboundBagId: PARTNER_BAG,
    });
    expect(parsed.sourcePartnerInboundBagId).toBe(PARTNER_BAG);
  });

  it('still refuses a bag with no provenance or with two of them', () => {
    expect(() => StoreInventoryBagSchema.parse(bag)).toThrow();
    expect(() =>
      StoreInventoryBagSchema.parse({
        ...bag,
        sourceReceiptBagId: RECEIPT_BAG,
        sourcePartnerInboundBagId: PARTNER_BAG,
      }),
    ).toThrow();
  });

  it('parses stock written before partner inbound existed', () => {
    const parsed = StoreInventoryBagSchema.parse({ ...bag, sourceReceiptBagId: RECEIPT_BAG });
    expect(parsed.sourcePartnerInboundBagId ?? null).toBeNull();
  });
});

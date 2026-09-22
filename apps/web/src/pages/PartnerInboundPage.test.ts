import { describe, expect, it } from 'vitest';
import { partnerBagWeightsValid, partnerInboundRequest } from './PartnerInboundPage';

const STORE = '50000000-0000-4000-8000-000000000001';
const PRODUCT = '50000000-0000-4000-8000-000000000002';
const RECEIVED_AT = '2026-09-22T10:00:00+07:00';

describe('partner inbound draft validation', () => {
  it('needs a weight for every unit before the slip can be saved', () => {
    expect(partnerBagWeightsValid([])).toBe(false);
    expect(
      partnerBagWeightsValid([{ productId: PRODUCT, quantity: 2, bagWeightsKg: ['45.5', ''] }]),
    ).toBe(false);
    expect(
      partnerBagWeightsValid([{ productId: PRODUCT, quantity: 2, bagWeightsKg: ['45.5', '40'] }]),
    ).toBe(true);
  });

  it('refuses weights that are not positive kilograms with at most three decimals', () => {
    for (const weight of ['0', '-1', '1.2345', 'abc', '1,5']) {
      expect(
        partnerBagWeightsValid([{ productId: PRODUCT, quantity: 1, bagWeightsKg: [weight] }]),
      ).toBe(false);
    }
  });

  it('refuses a quantity that no longer matches the weights typed so far', () => {
    expect(
      partnerBagWeightsValid([{ productId: PRODUCT, quantity: 3, bagWeightsKg: ['1', '2'] }]),
    ).toBe(false);
  });

  it('sends weights in the exact kilogram format the contract stores', () => {
    const parsed = partnerInboundRequest(
      STORE,
      '  Đối tác Bình Minh  ',
      '  ',
      [{ productId: PRODUCT, quantity: 2, bagWeightsKg: ['45.5', '40'] }],
      RECEIVED_AT,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.partnerName).toBe('Đối tác Bình Minh');
    // A blank note is absence, not an empty string the store has to look at later.
    expect(parsed.data.note).toBeNull();
    expect(parsed.data.lines[0]?.bagWeightsKg).toEqual(['45.500', '40.000']);
  });

  it('keeps a typed note and refuses a slip with no partner name', () => {
    const withNote = partnerInboundRequest(
      STORE,
      'Đối tác A',
      ' hàng mẫu ',
      [{ productId: PRODUCT, quantity: 1, bagWeightsKg: ['10'] }],
      RECEIVED_AT,
    );
    expect(withNote.success && withNote.data.note).toBe('hàng mẫu');
    expect(
      partnerInboundRequest(
        STORE,
        '   ',
        '',
        [{ productId: PRODUCT, quantity: 1, bagWeightsKg: ['10'] }],
        RECEIVED_AT,
      ).success,
    ).toBe(false);
  });
});

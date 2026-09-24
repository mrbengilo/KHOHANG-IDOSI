import { describe, expect, it } from 'vitest';

import {
  canUseAdjustments,
  describeEntitlement,
  formatExactVnd,
  formatSignedVnd,
  previewAdjustment,
} from './adjustmentModel';

const before = {
  goodsVnd: 3_000_000,
  freightVnd: 0,
  handlingVnd: 0,
  costVnd: 3_000_000,
  vatVnd: 0,
  totalVnd: 3_000_000,
};

describe('receipt adjustment preview', () => {
  it('matches the server rounding and the 3.000.000 → 2.800.000 example', () => {
    const preview = previewAdjustment(
      before,
      [{ recordedCostVnd: 1_000_000, weightKg: '20.000', pricePerKgVnd: '40000' }],
      { freight: '0', handling: '0', vat: '0' },
    );
    expect(preview.problem).toBeNull();
    expect(preview.lineCosts).toEqual([800_000n]);
    expect(preview.delta?.goods).toBe(-200_000n);
    expect(preview.after?.goods).toBe(2_800_000n);
    expect(preview.after?.total).toBe(2_800_000n);
    // 1.001 kg × 500 đ = 500,5 đ rounds half up like finalization.
    expect(
      previewAdjustment(before, [{ recordedCostVnd: 0, weightKg: '1.001', pricePerKgVnd: '500' }], {
        freight: '0',
        handling: '0',
        vat: '0',
      }).lineCosts,
    ).toEqual([501n]);
  });

  it('keeps legacy unknown VAT unknown and flags negative results', () => {
    const legacy = { ...before, vatVnd: null, totalVnd: null };
    const kept = previewAdjustment(
      legacy,
      [{ recordedCostVnd: 1_000_000, weightKg: '20', pricePerKgVnd: '40000' }],
      { freight: '0', handling: '0', vat: '0' },
    );
    expect(kept.after?.vat).toBeNull();
    expect(kept.after?.total).toBeNull();
    expect(
      previewAdjustment(legacy, [{ recordedCostVnd: 0, weightKg: '1', pricePerKgVnd: '1' }], {
        freight: '0',
        handling: '0',
        vat: '5',
      }).problem,
    ).toContain('chưa ghi nhận VAT');
    expect(
      previewAdjustment(before, [{ recordedCostVnd: 0, weightKg: '1', pricePerKgVnd: '1' }], {
        freight: '-1',
        handling: '0',
        vat: '0',
      }).problem,
    ).toContain('không được âm');
    expect(
      previewAdjustment(before, [{ recordedCostVnd: 0, weightKg: '0', pricePerKgVnd: '1' }], {
        freight: '0',
        handling: '0',
        vat: '0',
      }).delta,
    ).toBeNull();
  });

  it('formats signed and exact VND and describes the P0B right stage', () => {
    expect(formatSignedVnd(-200_000n)).toMatch(/^−200\.000 ₫$/u);
    expect(formatSignedVnd(1n)).toMatch(/^\+1 ₫$/u);
    expect(formatExactVnd(null)).toBe('Chưa ghi nhận');
    const right = {
      waitTicketId: '00000000-0000-4000-8000-000000000001',
      waitTicketCode: 'PC-0000001',
      waitMode: 'CREATED' as const,
      productId: '00000000-0000-4000-8000-000000000002',
      quantity: 1,
      waitStatus: 'ACTIVE' as const,
      waitRemainingQuantity: 1,
      waitFulfilledQuantity: 0,
      hasOpenOffer: false,
      heldQuantity: 0,
      shippingQuantity: 0,
      receivedQuantity: 0,
      grantedAt: '2026-09-24T00:00:00.000Z',
    };
    expect(describeEntitlement(right)).toBe('Chờ cấp (ưu tiên P0B)');
    expect(describeEntitlement({ ...right, shippingQuantity: 1 })).toBe('Đang giao bù');
    expect(describeEntitlement({ ...right, receivedQuantity: 1 })).toBe('Đã nhận bù');
    expect(canUseAdjustments('WHOLESALE')).toBe(false);
    expect(canUseAdjustments('HTKD')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  accountLabel,
  adjustmentAudience,
  adjustmentStatusCopy,
  describeEntitlement,
  formatExactVnd,
  formatSignedVnd,
  listMoneyCopy,
  previewAdjustment,
  storeLabel,
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
  });

  it('puts the wholesale desk on the store side of the workflow, never the reviewer side', () => {
    expect(adjustmentAudience('WHOLESALE')).toBe('STORE');
    expect(adjustmentAudience('STORE')).toBe('STORE');
    expect(adjustmentAudience('HTKD')).toBe('HTKD');
    expect(adjustmentAudience('ADMIN')).toBe('ADMIN');
    expect(adjustmentAudience('UNKNOWN')).toBeNull();
  });

  it('labels every status with the one shared vocabulary; APPLIED reads "Đã xử lý"', () => {
    expect(
      Object.fromEntries(
        Object.entries(adjustmentStatusCopy).map(([status, copy]) => [status, copy.label]),
      ),
    ).toEqual({
      PENDING_HTKD: 'Chờ HTKD xác minh',
      PENDING_ADMIN: 'Chờ Admin duyệt',
      NEEDS_INFO: 'Cần cửa hàng bổ sung',
      APPLIED: 'Đã xử lý',
      REJECTED: 'Bị từ chối',
      CANCELLED: 'Đã hủy',
    });
    // Rejected and cancelled are different final outcomes, never shown as a success.
    expect(adjustmentStatusCopy.APPLIED.tone).toBe('success');
    expect(adjustmentStatusCopy.REJECTED.tone).not.toBe('success');
    expect(adjustmentStatusCopy.CANCELLED.tone).not.toBe('success');
  });

  it('names people and stores, keeping the id when the record is gone', () => {
    const accountId = '00000000-0000-4000-8000-00000000000a';
    expect(accountLabel({ accountId, displayName: 'HTKD Lan', username: 'htkd.lan' })).toBe(
      'HTKD Lan',
    );
    expect(accountLabel({ accountId, displayName: null, username: 'htkd.lan' })).toBe('htkd.lan');
    expect(accountLabel({ accountId, displayName: null, username: null })).toBe(
      'Tài khoản 00000000… · Không còn thông tin',
    );
    expect(accountLabel({ accountId: null, displayName: null, username: null })).toBe(
      'Chưa ghi nhận',
    );
    expect(storeLabel({ storeId: accountId, code: 'Q1', name: 'Quận 1' })).toBe('Q1 · Quận 1');
    expect(storeLabel({ storeId: accountId, code: null, name: null })).toBe(
      'Cửa hàng 00000000… · Không còn thông tin',
    );
  });

  it('tells a draft delta from an effective one in list rows', () => {
    expect(listMoneyCopy({ status: 'PENDING_ADMIN', goodsDeltaVnd: -200_000 })).toEqual({
      label: 'Tạm tính, chưa hiệu lực',
      value: formatSignedVnd(-200_000),
    });
    expect(listMoneyCopy({ status: 'APPLIED', goodsDeltaVnd: -200_000 }).label).toBe(
      'Đã có hiệu lực',
    );
    expect(listMoneyCopy({ status: 'REJECTED', goodsDeltaVnd: 0 }).value).toBeNull();
    expect(listMoneyCopy({ status: 'PENDING_HTKD', goodsDeltaVnd: 0 }).label).toBe(
      'Chờ HTKD xác minh giá',
    );
  });
});

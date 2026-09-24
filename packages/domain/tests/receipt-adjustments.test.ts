import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  allowedReceiptAdjustmentActions,
  applyReceiptMoneyDeltas,
  assertReceiptAdjustmentApplicable,
  assessReceiptAdjustmentBag,
  canHoldReceiptAdjustmentBag,
  DomainError,
  planReceiptAdjustmentLine,
  planReceiptAdjustmentMoney,
  planReceiptAdjustmentTransition,
  receiptMoneyView,
  RECEIPT_ADJUSTMENT_ACTIONS,
  RECEIPT_ADJUSTMENT_STATUSES,
  weightedBagCostVnd,
  type ReceiptAdjustmentBagFacts,
} from '../src/index.js';

const DRESS = 'product-dress';
const JEANS = 'product-jeans';
const COAT = 'product-coat';

const intactBag: ReceiptAdjustmentBagFacts = {
  status: 'quarantined',
  initialGrams: 20_000n,
  currentGrams: 20_000n,
  normalSaleConsumedGrams: 0n,
  approvedOutboundCount: 0,
  pendingOutboundCount: 0,
  completedTransferCount: 0,
  draftTransferCount: 0,
  sortingEventCount: 0,
  heldByThisAdjustment: true,
  matchesRecordedState: true,
};

describe('receipt adjustment state machine', () => {
  it('moves store report → HTKD verification → admin application', () => {
    expect(planReceiptAdjustmentTransition('PENDING_HTKD', 'VERIFY', 'HTKD')).toBe('PENDING_ADMIN');
    expect(planReceiptAdjustmentTransition('PENDING_ADMIN', 'APPLY', 'ADMIN')).toBe('APPLIED');
    expect(planReceiptAdjustmentTransition('PENDING_ADMIN', 'RETURN_TO_VERIFIER', 'ADMIN')).toBe(
      'PENDING_HTKD',
    );
    expect(planReceiptAdjustmentTransition('NEEDS_INFO', 'RESUBMIT', 'STORE')).toBe('PENDING_HTKD');
  });

  it('refuses applying from anything but a verified document and by anyone but an admin', () => {
    expect(() => planReceiptAdjustmentTransition('PENDING_HTKD', 'APPLY', 'ADMIN')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(() => planReceiptAdjustmentTransition('PENDING_ADMIN', 'APPLY', 'HTKD')).toThrow(
      expect.objectContaining({ code: 'ACTION_NOT_PERMITTED' }),
    );
    expect(() => planReceiptAdjustmentTransition('PENDING_HTKD', 'VERIFY', 'STORE')).toThrow(
      expect.objectContaining({ code: 'ACTION_NOT_PERMITTED' }),
    );
  });

  it('never leaves a terminal status and never lets a store verify or apply', () => {
    for (const status of RECEIPT_ADJUSTMENT_STATUSES) {
      const storeActions = allowedReceiptAdjustmentActions(status, 'STORE');
      expect(storeActions).not.toContain('VERIFY');
      expect(storeActions).not.toContain('APPLY');
      if (['APPLIED', 'REJECTED', 'CANCELLED'].includes(status)) {
        for (const role of ['ADMIN', 'HTKD', 'STORE'] as const) {
          expect(allowedReceiptAdjustmentActions(status, role)).toEqual([]);
        }
      }
    }
    for (const action of RECEIPT_ADJUSTMENT_ACTIONS) {
      expect(allowedReceiptAdjustmentActions('APPLIED', 'ADMIN')).not.toContain(action);
    }
  });
});

describe('receipt adjustment line plan', () => {
  it('prices the verified bag with the finalization rounding and owes one approved unit', () => {
    const plan = planReceiptAdjustmentLine({
      approvedProductId: DRESS,
      recordedProductId: DRESS,
      actualProductId: JEANS,
      recordedWeightGrams: 20_000n,
      recordedCostVnd: 1_000_000n,
      verifiedWeightGrams: 20_000n,
      verifiedPricePerKgVnd: 40_000n,
      shortageAlreadyGranted: false,
    });
    expect(plan).toEqual({
      verifiedCostVnd: 800_000n,
      goodsDeltaVnd: -200_000n,
      weightDeltaGrams: 0n,
      shortageQuantity: 1,
    });
    expect(weightedBagCostVnd(1_001n, 1_500n)).toBe(1_502n);
    expect(weightedBagCostVnd(1_001n, 500n)).toBe(501n); // 500.5 rounds half up
  });

  it('grants the shortage once per bag and not for a second reclassification', () => {
    const second = planReceiptAdjustmentLine({
      approvedProductId: DRESS,
      recordedProductId: JEANS,
      actualProductId: COAT,
      recordedWeightGrams: 20_000n,
      recordedCostVnd: 800_000n,
      verifiedWeightGrams: 20_000n,
      verifiedPricePerKgVnd: 45_000n,
      shortageAlreadyGranted: true,
    });
    expect(second.shortageQuantity).toBe(0);
    expect(second.goodsDeltaVnd).toBe(100_000n);

    const excess = planReceiptAdjustmentLine({
      approvedProductId: null,
      recordedProductId: DRESS,
      actualProductId: JEANS,
      recordedWeightGrams: 10_000n,
      recordedCostVnd: 500_000n,
      verifiedWeightGrams: 10_000n,
      verifiedPricePerKgVnd: 40_000n,
      shortageAlreadyGranted: false,
    });
    expect(excess.shortageQuantity).toBe(0);
  });

  it('refuses a no-op reclassification and undoing a granted shortage', () => {
    expect(() =>
      planReceiptAdjustmentLine({
        approvedProductId: DRESS,
        recordedProductId: DRESS,
        actualProductId: DRESS,
        recordedWeightGrams: 1n,
        recordedCostVnd: 0n,
        verifiedWeightGrams: 1n,
        verifiedPricePerKgVnd: 0n,
        shortageAlreadyGranted: false,
      }),
    ).toThrow(DomainError);
    expect(() =>
      planReceiptAdjustmentLine({
        approvedProductId: DRESS,
        recordedProductId: JEANS,
        actualProductId: DRESS,
        recordedWeightGrams: 1n,
        recordedCostVnd: 0n,
        verifiedWeightGrams: 1n,
        verifiedPricePerKgVnd: 0n,
        shortageAlreadyGranted: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
});

describe('receipt adjustment money', () => {
  it('reconciles 3.000.000 → 2.800.000 and keeps the resupply on its own receipt', () => {
    const original = { goodsVnd: 3_000_000n, freightVnd: 0n, handlingVnd: 0n, vatVnd: 0n };
    const plan = planReceiptAdjustmentMoney(original, {
      goodsVnd: -200_000n,
      freightVnd: 0n,
      handlingVnd: 0n,
      vatVnd: 0n,
    });
    expect(plan.before.goodsVnd).toBe(3_000_000n);
    expect(plan.delta.goodsVnd).toBe(-200_000n);
    expect(plan.after.goodsVnd).toBe(2_800_000n);
    const resupplyReceiptGoods = 1_000_000n;
    expect(plan.after.goodsVnd + resupplyReceiptGoods).toBe(3_800_000n);
  });

  it('keeps unknown legacy VAT unknown and refuses to invent it', () => {
    const legacy = { goodsVnd: 1_000n, freightVnd: 10n, handlingVnd: 5n, vatVnd: null };
    const plan = planReceiptAdjustmentMoney(legacy, {
      goodsVnd: -100n,
      freightVnd: 0n,
      handlingVnd: 0n,
      vatVnd: 0n,
    });
    expect(plan.after.vatVnd).toBeNull();
    expect(plan.after.totalVnd).toBeNull();
    expect(plan.after.costVnd).toBe(915n);
    expect(() =>
      planReceiptAdjustmentMoney(legacy, {
        goodsVnd: 0n,
        freightVnd: 0n,
        handlingVnd: 0n,
        vatVnd: 8n,
      }),
    ).toThrow(DomainError);
  });

  it('refuses negative effective amounts', () => {
    expect(() =>
      planReceiptAdjustmentMoney(
        { goodsVnd: 100n, freightVnd: 0n, handlingVnd: 0n, vatVnd: 0n },
        { goodsVnd: -101n, freightVnd: 0n, handlingVnd: 0n, vatVnd: 0n },
      ),
    ).toThrow(DomainError);
  });

  it('effective value always equals the original plus the sum of applied deltas', () => {
    const delta = fc.record({
      goodsVnd: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
      freightVnd: fc.bigInt({ min: -10_000n, max: 10_000n }),
      handlingVnd: fc.bigInt({ min: -10_000n, max: 10_000n }),
      vatVnd: fc.bigInt({ min: -10_000n, max: 10_000n }),
    });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        fc.array(delta, { maxLength: 6 }),
        (goods, deltas) => {
          const original = { goodsVnd: goods, freightVnd: 0n, handlingVnd: 0n, vatVnd: 0n };
          const effective = receiptMoneyView(applyReceiptMoneyDeltas(original, deltas));
          const sum = (pick: (d: (typeof deltas)[number]) => bigint) =>
            deltas.reduce((total, d) => total + pick(d), 0n);
          expect(effective.goodsVnd).toBe(goods + sum((d) => d.goodsVnd));
          expect(effective.totalVnd).toBe(
            goods + sum((d) => d.goodsVnd + d.freightVnd + d.handlingVnd + d.vatVnd),
          );
        },
      ),
    );
  });
});

describe('receipt adjustment bag dependencies', () => {
  it('allows only a whole, held, untouched bag', () => {
    expect(assessReceiptAdjustmentBag(intactBag)).toEqual([]);
    expect(canHoldReceiptAdjustmentBag('opened')).toBe(true);
    expect(canHoldReceiptAdjustmentBag('depleted')).toBe(false);
  });

  it('names every reason a sold, sorted or moved bag cannot be reclassified', () => {
    expect(
      assessReceiptAdjustmentBag({
        ...intactBag,
        status: 'opened',
        currentGrams: 5_000n,
        normalSaleConsumedGrams: 1_000n,
        sortingEventCount: 1,
        completedTransferCount: 1,
        heldByThisAdjustment: false,
      }),
    ).toEqual([
      'BAG_NOT_HELD',
      'BAG_PARTIALLY_CONSUMED',
      'BAG_TRANSFERRED',
      'BAG_SORTED',
      'BAG_SOLD',
    ]);
    expect(
      assessReceiptAdjustmentBag({ ...intactBag, status: 'depleted', currentGrams: 0n }),
    ).toContain('BAG_DEPLETED');
    expect(
      assessReceiptAdjustmentBag({ ...intactBag, pendingOutboundCount: 1, draftTransferCount: 1 }),
    ).toEqual(['BAG_PENDING_OUTBOUND', 'BAG_PENDING_TRANSFER']);
    expect(() =>
      assertReceiptAdjustmentApplicable([{ receiptBagId: 'bag-1', blockers: ['BAG_SOLD'] }]),
    ).toThrow(expect.objectContaining({ details: { 'bag-1': 'BAG_SOLD' } }));
  });
});

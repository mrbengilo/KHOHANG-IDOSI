import { describe, expect, it } from 'vitest';
import { CreateSortedSaleTransferRequestSchema } from '../src/sorted-sale-transfer.js';
const id = (n: number) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const header = { sourceStoreId: id(1), destinationStoreId: id(2), note: null };
describe('multi-line Sale request contract', () => {
  it('accepts two products and exact three-decimal weights and retains the old request', () => {
    expect(
      CreateSortedSaleTransferRequestSchema.parse({
        ...header,
        lines: [
          { productId: id(3), bagWeightsKg: ['30.000', '50.001'] },
          { productId: id(4), bagWeightsKg: ['50.000'] },
        ],
      }),
    ).toMatchObject({ lines: expect.any(Array) });
    expect(
      CreateSortedSaleTransferRequestSchema.safeParse({
        ...header,
        productId: id(3),
        bagWeightsKg: ['1.000'],
      }).success,
    ).toBe(true);
  });
  it.each(
    [
      [],
      [{ productId: id(3), bagWeightsKg: [] }],
      [{ productId: id(3), bagWeightsKg: ['0.000'] }],
      [{ productId: id(3), bagWeightsKg: ['-1.000'] }],
      [{ productId: id(3), bagWeightsKg: ['0.0001'] }],
      [
        { productId: id(3), bagWeightsKg: ['1.000'] },
        { productId: id(3), bagWeightsKg: ['2.000'] },
      ],
    ].map((lines) => ({ lines })),
  )('rejects invalid/duplicate lines %#', ({ lines }) => {
    expect(CreateSortedSaleTransferRequestSchema.safeParse({ ...header, lines }).success).toBe(
      false,
    );
  });
  it('rejects same-store dispatch and mixed old/new request shapes', () => {
    const lines = [{ productId: id(3), bagWeightsKg: ['1.000'] }];
    expect(
      CreateSortedSaleTransferRequestSchema.safeParse({
        ...header,
        destinationStoreId: id(1),
        lines,
      }).success,
    ).toBe(false);
    expect(
      CreateSortedSaleTransferRequestSchema.safeParse({
        ...header,
        lines,
        productId: id(3),
        bagWeightsKg: ['1.000'],
      }).success,
    ).toBe(false);
  });
});

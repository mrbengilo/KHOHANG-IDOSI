import { describe, expect, it } from 'vitest';

import {
  CreateProductConversionRequestSchema,
  ListProductConversionsQuerySchema,
  ProductConversionSchema,
  UpdateProductConversionRequestSchema,
} from '../src/index.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSION_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

describe('product conversion contracts', () => {
  it('represents bedding exactly as one item for three kilograms', () => {
    const result = CreateProductConversionRequestSchema.parse({
      itemQuantity: 1,
      weightKilograms: '3.000',
      effectiveFrom: '2026-09-12',
      effectiveTo: null,
      reason: 'Approved catalog baseline',
    });

    expect(result).toMatchObject({ itemQuantity: 1, weightKilograms: '3.000' });
  });

  it('rejects floating-point and over-precision ratio sources', () => {
    const base = {
      itemQuantity: 3,
      effectiveFrom: '2026-09-12',
      effectiveTo: null,
      reason: 'Approved catalog baseline',
    };

    expect(
      CreateProductConversionRequestSchema.safeParse({ ...base, weightKilograms: 1 }).success,
    ).toBe(false);
    expect(
      CreateProductConversionRequestSchema.safeParse({
        ...base,
        weightKilograms: '0.3333333333333333',
      }).success,
    ).toBe(false);
    expect(
      CreateProductConversionRequestSchema.safeParse({
        ...base,
        itemQuantity: 2_147_483_648,
        weightKilograms: '1.000',
      }).success,
    ).toBe(false);
    expect(
      CreateProductConversionRequestSchema.safeParse({
        ...base,
        weightKilograms: '100000000000.000',
      }).success,
    ).toBe(false);
  });

  it('requires ordered effective periods and optimistic versioning on replacement', () => {
    const replacement = {
      itemQuantity: 4,
      weightKilograms: '1.000',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      reason: 'Approved seasonal recalibration',
      expectedVersion: 1,
    };

    expect(UpdateProductConversionRequestSchema.safeParse(replacement).success).toBe(true);
    expect(
      UpdateProductConversionRequestSchema.safeParse({
        ...replacement,
        effectiveTo: '2026-09-30',
      }).success,
    ).toBe(false);
  });

  it('requires complete retirement audit data and a closed effective period', () => {
    const conversion = {
      id: CONVERSION_ID,
      productId: PRODUCT_ID,
      version: 1,
      itemQuantity: 3,
      weightKilograms: '1.000',
      effectiveFrom: '2026-09-12',
      effectiveTo: '2026-10-01',
      reason: 'Approved catalog baseline',
      createdByAccountId: ACCOUNT_ID,
      createdAt: '2026-09-12T00:00:00Z',
      retiredAt: '2026-09-30T12:00:00Z',
      retiredByAccountId: ACCOUNT_ID,
      retirementReason: 'Replaced by the next approved version',
    };

    expect(ProductConversionSchema.safeParse(conversion).success).toBe(true);
    expect(ProductConversionSchema.safeParse({ ...conversion, effectiveTo: null }).success).toBe(
      false,
    );
    expect(
      ProductConversionSchema.safeParse({ ...conversion, retirementReason: null }).success,
    ).toBe(false);
    expect(
      ProductConversionSchema.safeParse({
        ...conversion,
        effectiveTo: conversion.effectiveFrom,
      }).success,
    ).toBe(true);
    expect(
      ProductConversionSchema.safeParse({
        ...conversion,
        effectiveTo: conversion.effectiveFrom,
        retiredAt: null,
        retiredByAccountId: null,
        retirementReason: null,
      }).success,
    ).toBe(false);
  });

  it('parses an explicit false list query without truthy string coercion', () => {
    expect(
      ListProductConversionsQuerySchema.parse({ includeRetired: 'false' }).includeRetired,
    ).toBe(false);
  });
});

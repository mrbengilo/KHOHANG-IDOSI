import type { DeclareStoreReceiptRequest } from '@idosi/contracts';
import { describe, expect, it, vi } from 'vitest';
import { confirmReceiptDeclaration } from './ReceivePage';

const declaration: DeclareStoreReceiptRequest = {
  discrepancyNote: null,
  lines: [
    {
      approvedUnits: 2,
      productId: '40000000-0000-4000-8000-000000000001',
      receivedUnits: 2,
    },
  ],
  outboundRequestId: '30000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
};

describe('receipt declaration confirmation', () => {
  it('preserves the draft when the API operation fails', async () => {
    const resetDraft = vi.fn();
    const declare = vi.fn(async () => false);

    await expect(confirmReceiptDeclaration(declaration, declare, resetDraft)).resolves.toBe(false);

    expect(declare).toHaveBeenCalledWith(declaration);
    expect(resetDraft).not.toHaveBeenCalled();
  });

  it('clears the draft only after the API confirms creation', async () => {
    const resetDraft = vi.fn();
    const declare = vi.fn(async () => true);

    await expect(confirmReceiptDeclaration(declaration, declare, resetDraft)).resolves.toBe(true);

    expect(resetDraft).toHaveBeenCalledOnce();
  });
});

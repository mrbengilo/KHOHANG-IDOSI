import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../../lib/api';
import { createPartnerReceipt, getPartnerReceipt, listPartnerReceipts } from './partnerReceiptsApi';

vi.mock('../../lib/api', () => ({ request: vi.fn() }));

const storeId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const mockRequest = vi.mocked(request);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('partner receipt API client', () => {
  it('uses the shared API base without a duplicated api/v1 prefix', async () => {
    const payload = {
      data: [],
      pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
    };
    mockRequest.mockResolvedValue(payload);
    await expect(listPartnerReceipts({ storeId, page: 1, pageSize: 50 })).resolves.toEqual(payload);
    expect(mockRequest).toHaveBeenCalledWith(
      `/partner-receipts?page=1&pageSize=50&storeId=${storeId}`,
    );
  });

  it('rejects a malformed server response instead of rendering it as an empty list', async () => {
    mockRequest.mockResolvedValue({ unexpected: true });
    await expect(listPartnerReceipts({ page: 1, pageSize: 50 })).rejects.toThrow();
  });

  it('validates input before sending a create request', async () => {
    await expect(
      createPartnerReceipt({
        storeId,
        partnerName: 'Duplicate product',
        lines: [
          { productId, quantity: 1 },
          { productId, quantity: 2 },
        ],
      }),
    ).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('sends create requests through the existing authenticated JSON transport', async () => {
    const input = { storeId, partnerName: 'Partner name', lines: [{ productId, quantity: 3 }] };
    const serverError = new Error('Server unavailable');
    mockRequest.mockRejectedValue(serverError);
    await expect(createPartnerReceipt(input)).rejects.toBe(serverError);
    expect(mockRequest).toHaveBeenCalledWith('/partner-receipts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  });

  it('uses an ID-scoped detail path and propagates transport failures', async () => {
    const serverError = new Error('Not found');
    mockRequest.mockRejectedValue(serverError);
    await expect(getPartnerReceipt(receiptId)).rejects.toBe(serverError);
    expect(mockRequest).toHaveBeenCalledWith(`/partner-receipts/${receiptId}`);
  });
});

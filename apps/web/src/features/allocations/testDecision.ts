import type { AllocationDecisionDetail } from '@idosi/contracts';

export const TEST_STORE_ID = '20000000-0000-4000-8000-000000000001';
export const TEST_PRODUCT_ID = '40000000-0000-4000-8000-000000000001';
export const TEST_OTHER_PRODUCT_ID = '40000000-0000-4000-8000-000000000002';

/** A published result as the API returns it, for component and API tests. */
export function testDecision(
  overrides: Partial<AllocationDecisionDetail> = {},
): AllocationDecisionDetail {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    allocationRunId: '11000000-0000-4000-8000-100000000001',
    runVersion: 1,
    sessionId: '10000000-0000-4000-8000-000000000001',
    sessionCode: 'PDH-000042',
    businessDate: '2026-10-05',
    storeId: TEST_STORE_ID,
    status: 'PENDING',
    version: 1,
    grantedQuantity: 3,
    origin: 'ALLOCATION_RUN',
    canRespond: true,
    respondedAt: null,
    respondedByAccountId: null,
    respondedByName: null,
    reason: null,
    createdAt: '2026-10-05T02:00:00.000Z',
    updatedAt: '2026-10-05T02:00:00.000Z',
    lines: [
      {
        productId: TEST_PRODUCT_ID,
        requestedQuantity: 5,
        allocatedQuantity: 3,
        waitlistedQuantity: 2,
      },
    ],
    carried: [],
    heldQuantity: 0,
    releasedQuantity: 0,
    shipment: {
      outboundRequestId: '11000000-0000-4000-8000-000000000003',
      requestNumber: 'PX-000123',
      status: 'RESERVED',
      dispatchedAt: null,
      receiptId: null,
      receiptNumber: null,
      receiptStatus: null,
    },
    sources: [],
    ...overrides,
  };
}

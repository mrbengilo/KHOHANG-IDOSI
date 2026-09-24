import { describe, expect, it } from 'vitest';

import { validateStoreReceiptDeclaration } from '../src/store-receipt-workflow.js';
import { StoreOperationValidationError } from '../src/store-operations.js';

const dispatched = [
  { productId: 'product-a', approvedQuantity: 4 },
  { productId: 'product-b', approvedQuantity: 2 },
] as const;

describe('store receipt declaration validation', () => {
  it('accepts a full declaration that exactly matches every dispatched product', () => {
    expect(() =>
      validateStoreReceiptDeclaration(
        [
          { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 4 },
          { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
        ],
        dispatched,
      ),
    ).not.toThrow();
  });

  it('accepts a short declaration only when it includes a meaningful discrepancy note', () => {
    const lines = [
      { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 3 },
      { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
    ] as const;

    expect(() => validateStoreReceiptDeclaration(lines, dispatched, 'Thiếu một bao')).not.toThrow();
    expect(() => validateStoreReceiptDeclaration(lines, dispatched, null)).toThrow(
      StoreOperationValidationError,
    );
    expect(() => validateStoreReceiptDeclaration(lines, dispatched, '  ')).toThrow(
      StoreOperationValidationError,
    );
  });

  it('records a different unexpected product only with a discrepancy note', () => {
    const lines = [
      { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 1 },
      { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
    ];
    const extra = [{ productId: 'product-c', quantity: 3 }];
    expect(() =>
      validateStoreReceiptDeclaration(lines, dispatched, 'Thiếu đầm, dư áo', extra),
    ).not.toThrow();
    expect(() => validateStoreReceiptDeclaration(lines, dispatched, null, extra)).toThrow(
      StoreOperationValidationError,
    );
    expect(() =>
      validateStoreReceiptDeclaration(lines, dispatched, 'Có chênh lệch', [
        { productId: 'product-a', quantity: 3 },
      ]),
    ).toThrow(StoreOperationValidationError);
    expect(() =>
      validateStoreReceiptDeclaration(lines, dispatched, 'Có chênh lệch', [
        { productId: 'product-c', quantity: 0 },
      ]),
    ).toThrow(StoreOperationValidationError);
    // Extra bags on top of a line received in full are accepted as excess goods.
    expect(() =>
      validateStoreReceiptDeclaration(lines, dispatched, 'Dư một bao váy', [
        { productId: 'product-b', quantity: 1 },
      ]),
    ).not.toThrow();
  });

  it('rejects missing, duplicate, wrong, and excess lines', () => {
    const invalidDeclarations = [
      [{ productId: 'product-a', approvedQuantity: 4, receivedQuantity: 4 }],
      [
        { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 4 },
        { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 4 },
      ],
      [
        { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 4 },
        { productId: 'product-c', approvedQuantity: 2, receivedQuantity: 2 },
      ],
      [
        { productId: 'product-a', approvedQuantity: 4, receivedQuantity: 5 },
        { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
      ],
    ] as const;

    for (const lines of invalidDeclarations) {
      expect(() => validateStoreReceiptDeclaration(lines, dispatched, 'Có sai lệch')).toThrow(
        StoreOperationValidationError,
      );
    }
  });

  it('does not trust the client supplied approved quantity', () => {
    expect(() =>
      validateStoreReceiptDeclaration(
        [
          { productId: 'product-a', approvedQuantity: 3, receivedQuantity: 3 },
          { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
        ],
        dispatched,
      ),
    ).toThrow(StoreOperationValidationError);
  });

  it('rejects unsafe quantities and payloads above the contract limit', () => {
    expect(() =>
      validateStoreReceiptDeclaration(
        [
          {
            productId: 'product-a',
            approvedQuantity: 4,
            receivedQuantity: Number.MAX_SAFE_INTEGER + 1,
          },
          { productId: 'product-b', approvedQuantity: 2, receivedQuantity: 2 },
        ],
        dispatched,
      ),
    ).toThrow(StoreOperationValidationError);

    const tooManyLines = Array.from({ length: 501 }, (_, index) => ({
      productId: `product-${index}`,
      approvedQuantity: 1,
      receivedQuantity: 1,
    }));
    expect(() =>
      validateStoreReceiptDeclaration(
        tooManyLines,
        tooManyLines.map(({ productId, approvedQuantity }) => ({
          productId,
          approvedQuantity,
        })),
      ),
    ).toThrow(StoreOperationValidationError);
  });
});

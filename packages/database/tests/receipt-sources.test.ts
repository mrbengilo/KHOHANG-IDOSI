import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  assembleStoreReceiptSources,
  buildStoreReceiptSourcePageQueries,
} from '../src/receipt-sources.js';
import * as schema from '../src/schema.js';

const IDS = {
  firstOutbound: '11111111-1111-4111-8111-111111111111',
  secondOutbound: '22222222-2222-4222-8222-222222222222',
  firstProduct: '33333333-3333-4333-8333-333333333333',
  secondProduct: '44444444-4444-4444-8444-444444444444',
  store: '55555555-5555-4555-8555-555555555555',
};

describe('store receipt source query', () => {
  it('scopes dispatches and excludes deleted requests, incomplete dispatches, and live receipts', () => {
    const database = drizzle.mock({ schema });
    const { headers, total } = buildStoreReceiptSourcePageQueries(database, {
      page: 2,
      pageSize: 25,
      storeId: IDS.store,
    });

    const headerQuery = headers.toSQL();
    const countQuery = total.toSQL();
    for (const query of [headerQuery.sql, countQuery.sql]) {
      expect(query).toContain('"outbound_requests"."status" = $1');
      expect(query).toContain('"outbound_requests"."deleted_at" is null');
      expect(query).toContain('"outbound_requests"."dispatched_at" is not null');
      expect(query).toContain('"outbound_request_lines"."dispatched_quantity" > $2');
      expect(query).toContain(
        '"outbound_request_lines"."approved_quantity" <> "outbound_request_lines"."dispatched_quantity"',
      );
      expect(query).toContain('not exists (select "id" from "store_receipts"');
      expect(query).toContain('"store_receipts"."deleted_at" is null');
      expect(query).toContain('"outbound_requests"."store_id" = $4');
    }
    expect(headerQuery.sql).toContain(
      'order by "outbound_requests"."dispatched_at" desc, "outbound_requests"."id" desc',
    );
    expect(headerQuery.params).toEqual(['dispatched', 0, 0, IDS.store, 25, 25]);
  });

  it('assembles every header in page order and product lines deterministically', () => {
    const firstDispatch = new Date('2026-09-17T01:00:00.000Z');
    const secondDispatch = new Date('2026-09-16T01:00:00.000Z');
    const result = assembleStoreReceiptSources(
      [
        {
          id: IDS.firstOutbound,
          requestNumber: 'OUT-002',
          storeId: IDS.store,
          dispatchedAt: firstDispatch,
        },
        {
          id: IDS.secondOutbound,
          requestNumber: 'OUT-001',
          storeId: IDS.store,
          dispatchedAt: secondDispatch,
        },
      ],
      [
        {
          id: 'line-b',
          outboundRequestId: IDS.firstOutbound,
          productId: IDS.secondProduct,
          approvedUnits: 2,
          dispatchedUnits: 2,
        },
        {
          id: 'line-c',
          outboundRequestId: IDS.secondOutbound,
          productId: IDS.firstProduct,
          approvedUnits: 1,
          dispatchedUnits: 1,
        },
        {
          id: 'line-a',
          outboundRequestId: IDS.firstOutbound,
          productId: IDS.firstProduct,
          approvedUnits: 4,
          dispatchedUnits: 4,
        },
      ],
    );

    expect(result.map((source) => source.id)).toEqual([IDS.firstOutbound, IDS.secondOutbound]);
    expect(result[0]?.lines.map((line) => line.productId)).toEqual([
      IDS.firstProduct,
      IDS.secondProduct,
    ]);
    expect(result[1]?.lines).toEqual([
      { productId: IDS.firstProduct, approvedUnits: 1, dispatchedUnits: 1 },
    ]);
  });

  it('fails closed when a selected source violates dispatch invariants', () => {
    expect(() =>
      assembleStoreReceiptSources(
        [
          {
            id: IDS.firstOutbound,
            requestNumber: 'OUT-002',
            storeId: IDS.store,
            dispatchedAt: null,
          },
        ],
        [],
      ),
    ).toThrow('dispatch timestamp');
    expect(() =>
      assembleStoreReceiptSources(
        [
          {
            id: IDS.firstOutbound,
            requestNumber: 'OUT-002',
            storeId: IDS.store,
            dispatchedAt: new Date('2026-09-17T01:00:00.000Z'),
          },
        ],
        [],
      ),
    ).toThrow('at least one dispatched line');
  });

  it('rejects invalid pagination before a query can run', () => {
    const database = drizzle.mock({ schema });
    expect(() => buildStoreReceiptSourcePageQueries(database, { page: 0, pageSize: 20 })).toThrow(
      RangeError,
    );
    expect(() => buildStoreReceiptSourcePageQueries(database, { page: 1, pageSize: 101 })).toThrow(
      RangeError,
    );
  });
});

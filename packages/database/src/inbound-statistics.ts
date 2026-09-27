import { sql } from 'drizzle-orm';
import type {
  InboundBreakdown,
  InboundMetric,
  InboundProductRow,
  InboundSource,
  InboundStatistics,
  InboundStatisticsQuery,
} from '@idosi/contracts';
import type { Database } from './client.js';

export interface InboundStore {
  id: string;
  code: string;
  name: string;
  kind: 'RETAIL' | 'WHOLESALE';
}
/** Aggregated once per source, store and effective SKU; weights are exact integer grams. */
export interface InboundAggregate {
  source: 'WAREHOUSE' | 'PARTNER';
  storeId: string;
  productId: string;
  sku: string;
  productName: string;
  bagQuantity: string;
  weightGrams: string;
  bagsComplete: boolean;
  weightComplete: boolean;
}

export function inboundPeriod(query: InboundStatisticsQuery) {
  const label = (query.periodType === 'DAY' ? query.date : query.month)!;
  const start = new Date(`${label}${query.periodType === 'MONTH' ? '-01' : ''}T00:00:00+07:00`);
  const end = new Date(start);
  if (query.periodType === 'DAY') end.setUTCDate(end.getUTCDate() + 1);
  else {
    // The UTC day is the previous month's final day: advance in business-calendar space.
    const [year, month] = label.split('-').map(Number);
    end.setTime(Date.UTC(year!, month!, 1) - 7 * 3_600_000);
  }
  return { start: start.toISOString(), endExclusive: end.toISOString(), label };
}

export class InboundScopeError extends Error {}

export async function loadInboundStatistics(
  database: Database,
  query: InboundStatisticsQuery,
): Promise<InboundStatistics> {
  const period = inboundPeriod(query);
  return database.transaction(
    async (tx) => {
      const catalog = await tx.execute<InboundStore & Record<string, unknown>>(sql`
      SELECT id, code, name, upper(kind::text) AS kind FROM stores ORDER BY code, id
    `);
      validateInboundScope(query, catalog.rows);
      const rows = await tx.execute<InboundAggregate & Record<string, unknown>>(sql`
      WITH scoped_stores AS (
        SELECT id FROM stores WHERE
          (${query.storeKind ?? null}::text IS NULL OR upper(kind::text) = ${query.storeKind ?? null})
          AND (${query.storeId ?? null}::uuid IS NULL OR id = ${query.storeId ?? null}::uuid)
      ), warehouse_lines AS (
        SELECT l.*, r.store_id FROM store_receipt_lines l
        JOIN store_receipts r ON r.id = l.store_receipt_id
        JOIN scoped_stores s ON s.id = r.store_id
        WHERE r.status = 'finalized' AND r.deleted_at IS NULL
          AND r.finalized_at >= ${period.start}::timestamptz AND r.finalized_at < ${period.endExclusive}::timestamptz
      ), warehouse_bags AS (
        SELECT b.id, b.store_receipt_line_id, l.store_id,
          coalesce(a.actual_product_id, l.product_id) AS product_id,
          CASE WHEN a.id IS NULL THEN b.weight_kg ELSE a.verified_weight_kg END AS weight_kg
        FROM warehouse_lines l JOIN store_receipt_bags b ON b.store_receipt_line_id = l.id
        LEFT JOIN LATERAL (
          SELECT al.id, al.actual_product_id, al.verified_weight_kg
          FROM store_receipt_adjustment_lines al JOIN store_receipt_adjustments a ON a.id = al.adjustment_id
          WHERE al.store_receipt_bag_id = b.id AND a.status = 'applied'
          ORDER BY a.applied_sequence DESC, a.id DESC LIMIT 1
        ) a ON true
      ), partner_lines AS (
        SELECT l.*, p.store_id FROM store_partner_inbound_lines l
        JOIN store_partner_inbounds p ON p.id = l.store_partner_inbound_id
        JOIN scoped_stores s ON s.id = p.store_id
        WHERE p.received_at >= ${period.start}::timestamptz AND p.received_at < ${period.endExclusive}::timestamptz
      ), entries AS (
        SELECT 'WAREHOUSE' AS source, store_id, product_id, 1::bigint AS bags,
          weight_kg * 1000 AS grams, true AS bags_complete, weight_kg IS NOT NULL AS weight_complete
        FROM warehouse_bags
        UNION ALL
        SELECT 'WAREHOUSE', l.store_id, l.product_id,
          greatest(l.received_quantity::bigint + l.excess_quantity - count(b.id), 0), 0,
          count(b.id) <= l.received_quantity::bigint + l.excess_quantity,
          count(b.id) = l.received_quantity::bigint + l.excess_quantity
        FROM warehouse_lines l LEFT JOIN warehouse_bags b ON b.store_receipt_line_id = l.id
        GROUP BY l.id, l.store_id, l.product_id, l.received_quantity, l.excess_quantity
        HAVING count(b.id) <> l.received_quantity::bigint + l.excess_quantity
        UNION ALL
        SELECT 'PARTNER', l.store_id, l.product_id,
          greatest(l.quantity::bigint, count(b.id)), coalesce(sum(b.weight_kg * 1000), 0),
          count(b.id) <= l.quantity, count(b.id) = l.quantity
        FROM partner_lines l LEFT JOIN store_partner_inbound_bags b ON b.store_partner_inbound_line_id = l.id
        GROUP BY l.id, l.store_id, l.product_id, l.quantity
      ) SELECT e.source, e.store_id AS "storeId", e.product_id AS "productId", p.sku, p.name AS "productName",
        sum(e.bags)::text AS "bagQuantity", trunc(coalesce(sum(e.grams), 0))::text AS "weightGrams",
        bool_and(e.bags_complete) AS "bagsComplete", bool_and(e.weight_complete) AS "weightComplete"
      FROM entries e JOIN products p ON p.id = e.product_id
      GROUP BY e.source, e.store_id, e.product_id, p.sku, p.name
    `);
      return summarizeInboundStatistics(query, rows.rows, catalog.rows);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export function validateInboundScope(
  query: InboundStatisticsQuery,
  stores: readonly InboundStore[],
) {
  if (!query.storeId) return;
  const store = stores.find((item) => item.id === query.storeId);
  if (!store || (query.storeKind && query.storeKind !== store.kind))
    throw new InboundScopeError('Cửa hàng không tồn tại hoặc không thuộc loại đã chọn');
}

const emptyMetric = (): InboundMetric => ({
  bagQuantity: '0',
  weightGrams: '0',
  bagsComplete: true,
  weightComplete: true,
});
const emptyAmounts = (): InboundBreakdown => ({
  warehouse: emptyMetric(),
  partner: emptyMetric(),
  total: emptyMetric(),
});
function add(a: InboundMetric, b: InboundMetric): InboundMetric {
  return {
    bagQuantity: String(BigInt(a.bagQuantity) + BigInt(b.bagQuantity)),
    weightGrams: String(BigInt(a.weightGrams) + BigInt(b.weightGrams)),
    bagsComplete: a.bagsComplete && b.bagsComplete,
    weightComplete: a.weightComplete && b.weightComplete,
  };
}
function amounts(rows: readonly InboundAggregate[]): InboundBreakdown {
  const value = emptyAmounts();
  for (const row of rows) {
    const key = row.source === 'WAREHOUSE' ? 'warehouse' : 'partner';
    value[key] = add(value[key], row);
  }
  value.total = add(value.warehouse, value.partner);
  return value;
}
function selected(value: InboundBreakdown, source: InboundSource) {
  return value[source === 'ALL' ? 'total' : source === 'WAREHOUSE' ? 'warehouse' : 'partner'];
}
function share(value: string, total: string, complete: boolean) {
  return !complete
    ? null
    : BigInt(total) === 0n
      ? 0
      : Number((BigInt(value) * 10_000n) / BigInt(total));
}
function compare(a: string, b: string) {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
function products(rows: readonly InboundAggregate[], source: InboundSource): InboundProductRow[] {
  const groups = new Map<string, InboundAggregate[]>();
  for (const row of rows) {
    const group = groups.get(row.productId);
    if (group) group.push(row);
    else groups.set(row.productId, [row]);
  }
  const total = selected(amounts(rows), source);
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const breakdown = amounts(group),
        metric = selected(breakdown, source);
      return {
        productId: first.productId,
        sku: first.sku,
        productName: first.productName,
        amounts: breakdown,
        selected: metric,
        bagShareBasisPoints: share(metric.bagQuantity, total.bagQuantity, total.bagsComplete),
        weightShareBasisPoints: share(metric.weightGrams, total.weightGrams, total.weightComplete),
      };
    })
    .filter(
      (row) =>
        BigInt(row.selected.bagQuantity) > 0n ||
        BigInt(row.selected.weightGrams) > 0n ||
        !row.selected.bagsComplete ||
        !row.selected.weightComplete,
    );
}
function rank(rows: InboundProductRow[]): InboundStatistics['ranking'] {
  const sorted = rows.filter(
    (row) =>
      row.selected.bagsComplete &&
      row.selected.weightComplete &&
      BigInt(row.selected.bagQuantity) > 0n,
  );
  const order = (direction: number) =>
    [...sorted].sort(
      (a, b) =>
        direction *
          (compare(a.selected.bagQuantity, b.selected.bagQuantity) ||
            compare(a.selected.weightGrams, b.selected.weightGrams)) ||
        a.sku.localeCompare(b.sku) ||
        a.productId.localeCompare(b.productId),
    );
  const most = order(-1)[0] ?? null,
    least = order(1)[0] ?? null;
  return {
    most,
    least,
    mostTied:
      most !== null &&
      sorted.filter((r) => r.selected.bagQuantity === most.selected.bagQuantity).length > 1,
    leastTied:
      least !== null &&
      sorted.filter((r) => r.selected.bagQuantity === least.selected.bagQuantity).length > 1,
    complete: rows.every((row) => row.selected.bagsComplete && row.selected.weightComplete),
  };
}
function chart(
  rows: InboundProductRow[],
  metric: 'bagQuantity' | 'weightGrams',
): InboundProductRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      compare(b.selected[metric], a.selected[metric]) || a.productId.localeCompare(b.productId),
  );
  if (sorted.length <= 10) return sorted;
  const other = sorted.slice(10).reduce(
    (a, b) => ({
      warehouse: add(a.warehouse, b.amounts.warehouse),
      partner: add(a.partner, b.amounts.partner),
      total: add(a.total, b.amounts.total),
    }),
    emptyAmounts(),
  );
  return [
    ...sorted.slice(0, 10),
    {
      productId: '__other__',
      sku: '',
      productName: 'Khác',
      amounts: other,
      selected: sorted.slice(10).reduce((a, b) => add(a, b.selected), emptyMetric()),
      bagShareBasisPoints: null,
      weightShareBasisPoints: null,
    },
  ];
}

export function summarizeInboundStatistics(
  query: InboundStatisticsQuery,
  input: readonly InboundAggregate[],
  stores: readonly InboundStore[],
  now = new Date(),
): InboundStatistics {
  validateInboundScope(query, stores);
  const scope = stores.filter(
    (s) =>
      (!query.storeKind || s.kind === query.storeKind) &&
      (!query.storeId || s.id === query.storeId),
  );
  const ids = new Set(scope.map((s) => s.id));
  const rows = input.filter((r) => ids.has(r.storeId));
  const overview = amounts(rows),
    allProducts = products(rows, query.source);
  const metricKey = query.sortBy === 'bags' ? 'bagQuantity' : 'weightGrams';
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  const search = (value: string, term: string) =>
    value.toLocaleLowerCase('vi').includes(term.toLocaleLowerCase('vi'));
  const productRows = allProducts
    .filter((r) => search(`${r.sku} ${r.productName}`, query.productSearch))
    .sort(
      (a, b) =>
        direction * compare(a.selected[metricKey], b.selected[metricKey]) ||
        a.sku.localeCompare(b.sku) ||
        a.productId.localeCompare(b.productId),
    );
  const storeRows = scope
    .map((s) => {
      const storeRows = rows.filter((r) => r.storeId === s.id);
      return {
        ...s,
        amounts: amounts(storeRows),
        ranking: rank(products(storeRows, query.source)),
      };
    })
    .filter((s) => search(`${s.code} ${s.name}`, query.storeSearch))
    .sort(
      (a, b) =>
        direction *
          compare(
            selected(a.amounts, query.source)[metricKey],
            selected(b.amounts, query.source)[metricKey],
          ) || a.code.localeCompare(b.code),
    );
  const page = <T>(items: T[], number: number) =>
    items.slice((number - 1) * query.pageSize, number * query.pageSize);
  const meta = (totalItems: number, page: number) => ({
    page,
    pageSize: query.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / query.pageSize),
  });
  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Ho_Chi_Minh',
    period: inboundPeriod(query),
    selectedSource: query.source,
    overviewAllSources: overview,
    summaryBySource: overview,
    selectedTotal: selected(overview, query.source),
    ranking: rank(allProducts),
    groupRows: (['RETAIL', 'WHOLESALE', 'ALL'] as const).map((kind) => ({
      kind,
      amounts: amounts(
        rows.filter((r) => kind === 'ALL' || scope.find((s) => s.id === r.storeId)?.kind === kind),
      ),
    })),
    storeOptions: stores.filter((s) => !query.storeKind || s.kind === query.storeKind),
    storeRows: page(storeRows, query.storePage),
    storePagination: meta(storeRows.length, query.storePage),
    productRows: page(productRows, query.productPage),
    productPagination: meta(productRows.length, query.productPage),
    charts: { bags: chart(allProducts, 'bagQuantity'), weight: chart(allProducts, 'weightGrams') },
    dataCompleteness: {
      bagsComplete: overview.total.bagsComplete,
      weightComplete: overview.total.weightComplete,
    },
  };
}

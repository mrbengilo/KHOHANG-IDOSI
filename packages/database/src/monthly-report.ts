import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import {
  allocationLines,
  allocationRuns,
  outboundRequests,
  products,
  receiptItems,
  receipts,
  storeInventoryBags,
  storeOutbounds,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  stores,
  waitTickets,
} from './schema.js';

const KILOGRAMS_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/;

export type MonthlyReportScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'GROUP'; readonly id: string }
  | { readonly kind: 'STORE'; readonly id: string };

export interface MonthlyReportInput {
  readonly year: number;
  readonly month: number;
  readonly scope: MonthlyReportScope;
}

export interface MonthWindow {
  readonly start: Date;
  readonly endExclusive: Date;
  readonly startBusinessDate: string;
  readonly endBusinessDateExclusive: string;
  readonly timeZone: 'Asia/Ho_Chi_Minh';
}

export type ReportMetricSource =
  | 'WAREHOUSE_RECEIPTS'
  | 'STORE_RECEIPTS'
  | 'STORE_OUTBOUNDS'
  | 'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS'
  | 'STORE_RECEIPTS_AND_STORE_OUTBOUNDS'
  | 'NOT_AVAILABLE';

export type ReportUnavailableReason =
  | 'INVOICE_COST_NOT_ALLOCATED'
  | 'MISSING_INBOUND_WEIGHT'
  | 'MISSING_SALE_REVENUE'
  | 'ZERO_INBOUND_WEIGHT'
  | 'VAT_NOT_CAPTURED'
  | 'COGS_NOT_RECORDED_PER_SALE';

export interface ReportMetric<T> {
  readonly value: T | null;
  readonly unavailableReason: ReportUnavailableReason | null;
  readonly source: ReportMetricSource;
}

export interface MonthlyInboundHeaderRow {
  readonly vatAmountVnd?: bigint | null;
  readonly receiptId: string;
  readonly goodsCostVnd: bigint;
  readonly transportationFeeVnd: bigint;
  readonly handlingFeeVnd: bigint;
  readonly otherCostVnd: bigint;
}

export interface MonthlyInboundProductRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  /** Null means the persisted receipt did not record an actual weight. */
  readonly weightKg: string | null;
  readonly goodsCostVnd: bigint | null;
}

export interface MonthlySaleRow {
  readonly outboundId: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly weightKg: string;
  /** Null is materially different from zero: the sale has no recorded revenue. */
  readonly revenueVnd: bigint | null;
}

export interface MonthlyReportRows {
  readonly inboundSource: Extract<ReportMetricSource, 'WAREHOUSE_RECEIPTS' | 'STORE_RECEIPTS'>;
  readonly inboundHeaders: readonly MonthlyInboundHeaderRow[];
  readonly inboundProducts: readonly MonthlyInboundProductRow[];
  readonly sales: readonly MonthlySaleRow[];
  readonly outboundOrderIds: readonly string[];
  readonly allocationRunIds: readonly string[];
  readonly waitTicketIds: readonly string[];
}

export interface MonthlyProductOperationalReport {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly inboundWeightGrams: ReportMetric<bigint>;
  readonly inboundGoodsCostVnd: ReportMetric<bigint>;
  readonly soldWeightGrams: ReportMetric<bigint>;
  readonly revenueVnd: ReportMetric<bigint>;
}

export interface MonthlyOperationalReport {
  readonly period: MonthWindow;
  readonly scope: MonthlyReportScope;
  readonly generatedAt: Date;
  readonly dataOrigin: 'LOCAL_TRANSACTIONAL_DATA';
  readonly counts: {
    readonly inboundReceipts: number;
    readonly outboundOrdersReceived: number;
    readonly allocationBatchesCompleted: number;
    readonly waitTicketsQueued: number;
    readonly approvedDiscountSales: number;
  };
  readonly totals: {
    readonly inboundWeightGrams: ReportMetric<bigint>;
    readonly soldWeightGrams: ReportMetric<bigint>;
    readonly revenueVnd: ReportMetric<bigint>;
    readonly inboundGoodsCostVnd: ReportMetric<bigint>;
    readonly transportationFeeVnd: ReportMetric<bigint>;
    readonly handlingFeeVnd: ReportMetric<bigint>;
    readonly otherInboundCostVnd: ReportMetric<bigint>;
    readonly landedInboundCostVnd: ReportMetric<bigint>;
    readonly vatCostVnd: ReportMetric<bigint>;
  };
  readonly ratios: {
    readonly averageInboundCostPerKgVnd: ReportMetric<bigint>;
    readonly revenuePerInboundKgVnd: ReportMetric<bigint>;
    readonly effectiveCostPerSoldKgVnd: ReportMetric<bigint>;
    readonly grossMarginBasisPoints: ReportMetric<number>;
  };
  readonly products: readonly MonthlyProductOperationalReport[];
}

interface ScopedInboundLineRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly goodsCostVnd: bigint;
}

interface ScopedInboundBagRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly weightKg: string;
}

export function monthWindowInHoChiMinh(year: number, month: number): MonthWindow {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    throw new RangeError('year must be an integer from 2000 through 2100.');
  }
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new RangeError('month must be an integer from 1 through 12.');
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const startBusinessDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endBusinessDateExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  return {
    start: new Date(`${startBusinessDate}T00:00:00.000+07:00`),
    endExclusive: new Date(`${endBusinessDateExclusive}T00:00:00.000+07:00`),
    startBusinessDate,
    endBusinessDateExclusive,
    timeZone: 'Asia/Ho_Chi_Minh',
  };
}

export function kilogramsToGramsForReport(value: string): bigint {
  const match = KILOGRAMS_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Invalid persisted kilogram value: "${value}".`);
  }

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(3, '0');
  return BigInt(whole) * 1_000n + BigInt(fraction || '0');
}

/** Rounds half up to a whole VND per kg without converting bigint money to floating point. */
export function vndPerKilogram(numeratorVnd: bigint, denominatorGrams: bigint): bigint {
  if (numeratorVnd < 0n) throw new RangeError('numeratorVnd cannot be negative.');
  if (denominatorGrams <= 0n) throw new RangeError('denominatorGrams must be positive.');
  return (numeratorVnd * 1_000n + denominatorGrams / 2n) / denominatorGrams;
}

export function mergeScopedInboundRows(
  lines: readonly ScopedInboundLineRow[],
  bags: readonly ScopedInboundBagRow[],
): MonthlyInboundProductRow[] {
  const byProduct = new Map<
    string,
    {
      productId: string;
      sku: string;
      productName: string;
      weightGrams: bigint;
      goodsCostVnd: bigint;
    }
  >();

  for (const line of lines) {
    const current = byProduct.get(line.productId) ?? {
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      weightGrams: 0n,
      goodsCostVnd: 0n,
    };
    current.goodsCostVnd += line.goodsCostVnd;
    byProduct.set(line.productId, current);
  }
  for (const bag of bags) {
    const current = byProduct.get(bag.productId) ?? {
      productId: bag.productId,
      sku: bag.sku,
      productName: bag.productName,
      weightGrams: 0n,
      goodsCostVnd: 0n,
    };
    current.weightGrams += kilogramsToGramsForReport(bag.weightKg);
    byProduct.set(bag.productId, current);
  }

  return [...byProduct.values()].map((row) => ({
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    weightKg: gramsToKilograms(row.weightGrams),
    goodsCostVnd: row.goodsCostVnd,
  }));
}

export function summarizeMonthlyReport(
  input: MonthlyReportInput,
  rows: MonthlyReportRows,
  generatedAt = new Date(),
): MonthlyOperationalReport {
  const period = monthWindowInHoChiMinh(input.year, input.month);
  validateScope(input.scope);

  const inboundWeightComplete = rows.inboundProducts.every((row) => row.weightKg !== null);
  const inboundWeightGrams = inboundWeightComplete
    ? rows.inboundProducts.reduce(
        (total, row) => total + kilogramsToGramsForReport(row.weightKg ?? '0'),
        0n,
      )
    : null;
  const soldWeightGrams = rows.sales.reduce(
    (total, row) => total + kilogramsToGramsForReport(row.weightKg),
    0n,
  );
  const revenueComplete = rows.sales.every((row) => row.revenueVnd !== null);
  const revenueVnd = revenueComplete
    ? rows.sales.reduce((total, row) => total + (row.revenueVnd ?? 0n), 0n)
    : null;
  const inboundGoodsCostVnd = sum(rows.inboundHeaders, (row) => row.goodsCostVnd);
  const transportationFeeVnd = sum(rows.inboundHeaders, (row) => row.transportationFeeVnd);
  const handlingFeeVnd = sum(rows.inboundHeaders, (row) => row.handlingFeeVnd);
  const otherInboundCostVnd = sum(rows.inboundHeaders, (row) => row.otherCostVnd);
  const vatCostVnd = sum(rows.inboundHeaders, (row) => row.vatAmountVnd ?? 0n);
  const vatComplete =
    rows.inboundSource === 'WAREHOUSE_RECEIPTS' &&
    rows.inboundHeaders.every((row) => row.vatAmountVnd != null);
  const landedCostComplete = rows.inboundSource === 'STORE_RECEIPTS' || vatComplete;
  const landedInboundCostVnd =
    inboundGoodsCostVnd + transportationFeeVnd + handlingFeeVnd + otherInboundCostVnd + vatCostVnd;

  const inboundWeightMetric =
    inboundWeightGrams === null
      ? unavailable<bigint>('MISSING_INBOUND_WEIGHT', rows.inboundSource)
      : available(inboundWeightGrams, rows.inboundSource);
  const revenueMetric =
    revenueVnd === null
      ? unavailable<bigint>('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS')
      : available(revenueVnd, 'STORE_OUTBOUNDS');

  const productsById = new Map<
    string,
    {
      productId: string;
      sku: string;
      productName: string;
      inboundWeightGrams: bigint;
      inboundWeightComplete: boolean;
      inboundGoodsCostVnd: bigint;
      inboundCostComplete: boolean;
      soldWeightGrams: bigint;
      revenueVnd: bigint;
      revenueComplete: boolean;
    }
  >();

  for (const row of rows.inboundProducts) {
    const product = productAccumulator(productsById, row);
    if (row.goodsCostVnd === null) product.inboundCostComplete = false;
    else product.inboundGoodsCostVnd += row.goodsCostVnd;
    if (row.weightKg === null) product.inboundWeightComplete = false;
    else product.inboundWeightGrams += kilogramsToGramsForReport(row.weightKg);
  }
  for (const row of rows.sales) {
    const product = productAccumulator(productsById, row);
    product.soldWeightGrams += kilogramsToGramsForReport(row.weightKg);
    if (row.revenueVnd === null) product.revenueComplete = false;
    else product.revenueVnd += row.revenueVnd;
  }

  return {
    period,
    scope: input.scope,
    generatedAt,
    dataOrigin: 'LOCAL_TRANSACTIONAL_DATA',
    counts: {
      inboundReceipts: uniqueCount(rows.inboundHeaders.map((row) => row.receiptId)),
      outboundOrdersReceived: uniqueCount(rows.outboundOrderIds),
      allocationBatchesCompleted: uniqueCount(rows.allocationRunIds),
      waitTicketsQueued: uniqueCount(rows.waitTicketIds),
      approvedDiscountSales: uniqueCount(rows.sales.map((row) => row.outboundId)),
    },
    totals: {
      inboundWeightGrams: inboundWeightMetric,
      soldWeightGrams: available(soldWeightGrams, 'STORE_OUTBOUNDS'),
      revenueVnd: revenueMetric,
      inboundGoodsCostVnd: available(inboundGoodsCostVnd, rows.inboundSource),
      transportationFeeVnd: available(transportationFeeVnd, rows.inboundSource),
      handlingFeeVnd: available(handlingFeeVnd, rows.inboundSource),
      otherInboundCostVnd: available(otherInboundCostVnd, rows.inboundSource),
      landedInboundCostVnd: landedCostComplete
        ? available(landedInboundCostVnd, rows.inboundSource)
        : unavailable('VAT_NOT_CAPTURED', 'NOT_AVAILABLE'),
      vatCostVnd: vatComplete
        ? available(vatCostVnd, rows.inboundSource)
        : unavailable('VAT_NOT_CAPTURED', 'NOT_AVAILABLE'),
    },
    ratios: {
      averageInboundCostPerKgVnd:
        !landedCostComplete && inboundWeightGrams !== null && inboundWeightGrams > 0n
          ? unavailable('VAT_NOT_CAPTURED', 'NOT_AVAILABLE')
          : costPerInboundKilogram(landedInboundCostVnd, inboundWeightGrams, rows.inboundSource),
      revenuePerInboundKgVnd:
        revenueVnd === null
          ? unavailable('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS')
          : costPerInboundKilogram(
              revenueVnd,
              inboundWeightGrams,
              rows.inboundSource === 'WAREHOUSE_RECEIPTS'
                ? 'WAREHOUSE_RECEIPTS_AND_STORE_OUTBOUNDS'
                : 'STORE_RECEIPTS_AND_STORE_OUTBOUNDS',
            ),
      // store_outbounds has no immutable landed-COGS amount. Prorating a bag's goods-only
      // acquisition cost would silently omit freight/handling and would make margin look better.
      effectiveCostPerSoldKgVnd: unavailable('COGS_NOT_RECORDED_PER_SALE', 'NOT_AVAILABLE'),
      grossMarginBasisPoints: unavailable('COGS_NOT_RECORDED_PER_SALE', 'NOT_AVAILABLE'),
    },
    products: [...productsById.values()]
      .sort((left, right) => left.sku.localeCompare(right.sku))
      .map((product) => ({
        productId: product.productId,
        sku: product.sku,
        productName: product.productName,
        inboundWeightGrams: product.inboundWeightComplete
          ? available(product.inboundWeightGrams, rows.inboundSource)
          : unavailable('MISSING_INBOUND_WEIGHT', rows.inboundSource),
        inboundGoodsCostVnd: product.inboundCostComplete
          ? available(product.inboundGoodsCostVnd, rows.inboundSource)
          : unavailable<bigint>('INVOICE_COST_NOT_ALLOCATED', rows.inboundSource),
        soldWeightGrams: available(product.soldWeightGrams, 'STORE_OUTBOUNDS'),
        revenueVnd: product.revenueComplete
          ? available(product.revenueVnd, 'STORE_OUTBOUNDS')
          : unavailable('MISSING_SALE_REVENUE', 'STORE_OUTBOUNDS'),
      })),
  };
}

/**
 * Loads only rows inside the requested Vietnam-calendar month. Store and group scopes are
 * applied in SQL on every store-owned source; supplier receipts are used only for ALL scope.
 */
export async function loadMonthlyOperationalReport(
  database: Database,
  input: MonthlyReportInput,
  generatedAt = new Date(),
): Promise<MonthlyOperationalReport> {
  validateScope(input.scope);
  const period = monthWindowInHoChiMinh(input.year, input.month);
  const scopeFilter = storeScopeFilter(input.scope);

  const inbound =
    input.scope.kind === 'ALL'
      ? await loadWarehouseInbound(database, period)
      : await loadStoreInbound(database, period, scopeFilter);

  const [sales, receivedOrders, completedAllocationRows, queuedWaitRows] = await Promise.all([
    database
      .select({
        outboundId: storeOutbounds.id,
        productId: products.id,
        sku: products.sku,
        productName: products.name,
        weightKg: storeOutbounds.weightKg,
        revenueVnd: storeOutbounds.revenueVnd,
      })
      .from(storeOutbounds)
      .innerJoin(storeInventoryBags, eq(storeOutbounds.storeInventoryBagId, storeInventoryBags.id))
      .innerJoin(products, eq(storeInventoryBags.productId, products.id))
      .innerJoin(stores, eq(storeOutbounds.storeId, stores.id))
      .where(
        and(
          eq(storeOutbounds.status, 'approved'),
          eq(storeOutbounds.reason, 'discount_sale'),
          gte(storeOutbounds.reviewedAt, period.start),
          lt(storeOutbounds.reviewedAt, period.endExclusive),
          isNull(storeOutbounds.deletedAt),
          scopeFilter,
        ),
      ),
    database
      .select({ id: outboundRequests.id })
      .from(outboundRequests)
      .innerJoin(stores, eq(outboundRequests.storeId, stores.id))
      .where(
        and(
          inArray(outboundRequests.status, ['partially_received', 'received', 'completed']),
          gte(outboundRequests.receivedAt, period.start),
          lt(outboundRequests.receivedAt, period.endExclusive),
          isNull(outboundRequests.deletedAt),
          scopeFilter,
        ),
      ),
    input.scope.kind === 'ALL'
      ? database
          .select({ id: allocationRuns.id })
          .from(allocationRuns)
          .where(
            and(
              eq(allocationRuns.status, 'completed'),
              gte(allocationRuns.finishedAt, period.start),
              lt(allocationRuns.finishedAt, period.endExclusive),
              isNull(allocationRuns.deletedAt),
            ),
          )
      : database
          .select({ id: allocationRuns.id })
          .from(allocationRuns)
          .innerJoin(allocationLines, eq(allocationLines.allocationRunId, allocationRuns.id))
          .innerJoin(stores, eq(allocationLines.storeId, stores.id))
          .where(
            and(
              eq(allocationRuns.status, 'completed'),
              gte(allocationRuns.finishedAt, period.start),
              lt(allocationRuns.finishedAt, period.endExclusive),
              isNull(allocationRuns.deletedAt),
              scopeFilter,
            ),
          ),
    database
      .select({ id: waitTickets.id })
      .from(waitTickets)
      .innerJoin(stores, eq(waitTickets.storeId, stores.id))
      .where(
        and(
          gte(waitTickets.queuedAt, period.start),
          lt(waitTickets.queuedAt, period.endExclusive),
          isNull(waitTickets.deletedAt),
          scopeFilter,
        ),
      ),
  ]);

  return summarizeMonthlyReport(
    input,
    {
      inboundSource: inbound.source,
      inboundHeaders: inbound.headers,
      inboundProducts: inbound.products,
      sales,
      outboundOrderIds: receivedOrders.map((row) => row.id),
      allocationRunIds: completedAllocationRows.map((row) => row.id),
      waitTicketIds: queuedWaitRows.map((row) => row.id),
    },
    generatedAt,
  );
}

async function loadWarehouseInbound(database: Database, period: MonthWindow) {
  const [headers, productRows] = await Promise.all([
    database
      .select({
        receiptId: receipts.id,
        goodsCostVnd: receipts.totalGoodsCostVnd,
        transportationFeeVnd: receipts.totalShippingCostVnd,
        handlingFeeVnd: receipts.totalHandlingCostVnd,
        otherCostVnd: receipts.totalOtherCostVnd,
        vatAmountVnd: receipts.vatAmountVnd,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.status, 'confirmed'),
          gte(receipts.receivedAt, period.start),
          lt(receipts.receivedAt, period.endExclusive),
          isNull(receipts.deletedAt),
        ),
      ),
    database
      .select({
        productId: products.id,
        sku: products.sku,
        productName: products.name,
        weightKg: receiptItems.totalNetWeightKg,
        goodsCostVnd: sql<
          bigint | null
        >`CASE WHEN ${receiptItems.pricePerKgVnd} IS NULL THEN NULL ELSE ${receiptItems.goodsCostVnd} END`.mapWith(
          (value) => (value === null ? null : BigInt(value)),
        ),
      })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .innerJoin(products, eq(receiptItems.productId, products.id))
      .where(
        and(
          eq(receipts.status, 'confirmed'),
          gte(receipts.receivedAt, period.start),
          lt(receipts.receivedAt, period.endExclusive),
          isNull(receipts.deletedAt),
        ),
      ),
  ]);

  return { source: 'WAREHOUSE_RECEIPTS' as const, headers, products: productRows };
}

async function loadStoreInbound(
  database: Database,
  period: MonthWindow,
  scopeFilter: SQL | undefined,
) {
  const [headers, lines, bags] = await Promise.all([
    database
      .select({
        receiptId: storeReceipts.id,
        goodsCostVnd: storeReceipts.goodsCostVnd,
        transportationFeeVnd: storeReceipts.freightVnd,
        handlingFeeVnd: storeReceipts.handlingVnd,
      })
      .from(storeReceipts)
      .innerJoin(stores, eq(storeReceipts.storeId, stores.id))
      .where(
        and(
          eq(storeReceipts.status, 'finalized'),
          gte(storeReceipts.finalizedAt, period.start),
          lt(storeReceipts.finalizedAt, period.endExclusive),
          isNull(storeReceipts.deletedAt),
          scopeFilter,
        ),
      ),
    database
      .select({
        productId: products.id,
        sku: products.sku,
        productName: products.name,
        goodsCostVnd: storeReceiptLines.goodsCostVnd,
      })
      .from(storeReceiptLines)
      .innerJoin(storeReceipts, eq(storeReceiptLines.storeReceiptId, storeReceipts.id))
      .innerJoin(stores, eq(storeReceipts.storeId, stores.id))
      .innerJoin(products, eq(storeReceiptLines.productId, products.id))
      .where(
        and(
          eq(storeReceipts.status, 'finalized'),
          gte(storeReceipts.finalizedAt, period.start),
          lt(storeReceipts.finalizedAt, period.endExclusive),
          isNull(storeReceipts.deletedAt),
          scopeFilter,
        ),
      ),
    database
      .select({
        productId: products.id,
        sku: products.sku,
        productName: products.name,
        weightKg: storeReceiptBags.weightKg,
      })
      .from(storeReceiptBags)
      .innerJoin(storeReceiptLines, eq(storeReceiptBags.storeReceiptLineId, storeReceiptLines.id))
      .innerJoin(storeReceipts, eq(storeReceiptLines.storeReceiptId, storeReceipts.id))
      .innerJoin(stores, eq(storeReceipts.storeId, stores.id))
      .innerJoin(products, eq(storeReceiptLines.productId, products.id))
      .where(
        and(
          eq(storeReceipts.status, 'finalized'),
          gte(storeReceipts.finalizedAt, period.start),
          lt(storeReceipts.finalizedAt, period.endExclusive),
          isNull(storeReceipts.deletedAt),
          scopeFilter,
        ),
      ),
  ]);

  return {
    source: 'STORE_RECEIPTS' as const,
    // Store receipts currently persist goods, freight and handling only. Do not infer VAT or
    // another charge from totalCostVnd; that would double count a known component.
    headers: headers.map((row) => ({
      ...row,
      otherCostVnd: 0n,
    })),
    products: mergeScopedInboundRows(lines, bags),
  };
}

function storeScopeFilter(scope: MonthlyReportScope): SQL | undefined {
  if (scope.kind === 'ALL') return undefined;
  return scope.kind === 'STORE' ? eq(stores.id, scope.id) : eq(stores.groupId, scope.id);
}

function validateScope(scope: MonthlyReportScope): void {
  if (scope.kind !== 'ALL' && scope.id.trim().length === 0) {
    throw new RangeError('A store or group report requires a scope ID.');
  }
}

function costPerInboundKilogram(
  numeratorVnd: bigint,
  inboundWeightGrams: bigint | null,
  source: ReportMetricSource,
): ReportMetric<bigint> {
  if (inboundWeightGrams === null) return unavailable('MISSING_INBOUND_WEIGHT', source);
  if (inboundWeightGrams === 0n) return unavailable('ZERO_INBOUND_WEIGHT', source);
  return available(vndPerKilogram(numeratorVnd, inboundWeightGrams), source);
}

function productAccumulator(
  productsById: Map<
    string,
    {
      productId: string;
      sku: string;
      productName: string;
      inboundWeightGrams: bigint;
      inboundWeightComplete: boolean;
      inboundGoodsCostVnd: bigint;
      inboundCostComplete: boolean;
      soldWeightGrams: bigint;
      revenueVnd: bigint;
      revenueComplete: boolean;
    }
  >,
  row: { readonly productId: string; readonly sku: string; readonly productName: string },
) {
  const existing = productsById.get(row.productId);
  if (existing) return existing;
  const created = {
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    inboundWeightGrams: 0n,
    inboundWeightComplete: true,
    inboundGoodsCostVnd: 0n,
    inboundCostComplete: true,
    soldWeightGrams: 0n,
    revenueVnd: 0n,
    revenueComplete: true,
  };
  productsById.set(row.productId, created);
  return created;
}

function available<T>(value: T, source: ReportMetricSource): ReportMetric<T> {
  return { value, unavailableReason: null, source };
}

function unavailable<T>(
  unavailableReason: ReportUnavailableReason,
  source: ReportMetricSource,
): ReportMetric<T> {
  return { value: null, unavailableReason, source };
}

function uniqueCount(ids: readonly string[]): number {
  return new Set(ids).size;
}

function sum<T>(rows: readonly T[], select: (row: T) => bigint): bigint {
  return rows.reduce((total, row) => total + select(row), 0n);
}

function gramsToKilograms(grams: bigint): string {
  const whole = grams / 1_000n;
  const fraction = (grams % 1_000n).toString().padStart(3, '0');
  return `${whole}.${fraction}`;
}

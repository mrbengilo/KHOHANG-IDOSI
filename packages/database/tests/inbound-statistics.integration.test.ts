import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundStatisticsQuerySchema } from '@idosi/contracts';
import {
  closeDatabase,
  db,
  loadInboundStatistics,
  products,
  storeInventoryBags,
  storePartnerInbounds,
  storePartnerInboundLines,
  storeReceipts,
  storeReceiptLines,
  stores,
} from '../src/index.js';
import { createInboundStatisticsFixture } from './fixtures/inbound-statistics.js';

const suite = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
suite('PostgreSQL inbound statistics source documents', () => {
  let fx: Awaited<ReturnType<typeof createInboundStatisticsFixture>>;
  beforeAll(async () => {
    fx = await createInboundStatisticsFixture(db);
  });
  afterAll(closeDatabase);
  const query = (patch = {}) => InboundStatisticsQuerySchema.parse({ month: '2026-09', ...patch });
  it('reconciles all fixture dimensions, search, source, pages and exact per-bag grams', async () => {
    const reports = await Promise.all(
      fx.stores.map((s) => loadInboundStatistics(db, query({ storeId: s.id }))),
    );
    expect(
      reports.map((r) => [
        r.overviewAllSources.total.bagQuantity,
        r.overviewAllSources.total.weightGrams,
      ]),
    ).toEqual([
      ['58', '700000'],
      ['17', '290000'],
      ['30', '500000'],
    ]);
    const all = await loadInboundStatistics(
      db,
      query({ storeSearch: fx.stores[0]!.code.slice(7) }),
    );
    const own = all.storeRows.filter((s) => fx.stores.some((f) => f.id === s.id));
    expect(own.reduce((sum, s) => sum + BigInt(s.amounts.total.bagQuantity), 0n)).toBe(105n);
    expect(own.reduce((sum, s) => sum + BigInt(s.amounts.total.weightGrams), 0n)).toBe(1490000n);
    const partner = await loadInboundStatistics(
      db,
      query({ storeId: fx.stores[0]!.id, source: 'PARTNER', pageSize: 1, productSearch: 'Đồ nữ' }),
    );
    expect(partner.overviewAllSources.total.bagQuantity).toBe('58');
    expect(partner.productRows[0]?.selected.bagQuantity).toBe('3');
    expect(partner.selectedTotal.bagQuantity).toBe('8');
    expect(partner.charts.bags.reduce((s, p) => s + BigInt(p.selected.bagQuantity), 0n)).toBe(8n);
    await expect(
      loadInboundStatistics(db, query({ storeId: fx.stores[2]!.id, storeKind: 'RETAIL' })),
    ).rejects.toThrow();
  });
  it('does not read mutable inventory, product weights or active flags; partner retry is counted once', async () => {
    const key = randomUUID();
    await fx.partner(1, [[1, 2, 12]], fx.at, key);
    const replay = await fx.partner(1, [[1, 2, 12]], fx.at, key);
    expect(replay.replayed).toBe(true);
    await db
      .update(storeInventoryBags)
      .set({ status: 'returned', currentWeightKg: '0.000' })
      .where(eq(storeInventoryBags.storeId, fx.stores[1]!.id));
    await db.update(stores).set({ isActive: false }).where(eq(stores.id, fx.stores[1]!.id));
    await db
      .update(products)
      .set({ isActive: false, standardBagWeightKg: '999.000' })
      .where(eq(products.id, fx.products[2]!.id));
    const result = await loadInboundStatistics(db, query({ storeId: fx.stores[1]!.id }));
    expect(result.overviewAllSources.total).toMatchObject({
      bagQuantity: '19',
      weightGrams: '302000',
    });
  });
  it('uses finalizedAt and partner receivedAt with exclusive end; drafts and deleted receipts are excluded', async () => {
    const start = new Date('2026-08-31T17:00:00Z'),
      end = new Date('2026-09-30T17:00:00Z');
    await fx.warehouse(2, [[2, 1, 1]], start);
    await fx.warehouse(2, [[2, 1, 2]], end);
    await fx.warehouse(2, [[2, 1, 4]], new Date('2026-08-31T16:59:59.999Z'));
    await fx.warehouse(2, [[2, 1, 8]], fx.at, 'draft');
    const deleted = await fx.warehouse(2, [[2, 1, 16]], fx.at, 'draft');
    await db
      .update(storeReceipts)
      .set({ deletedAt: new Date() })
      .where(eq(storeReceipts.id, deleted.id));
    expect(
      (await loadInboundStatistics(db, query({ storeId: fx.stores[2]!.id }))).overviewAllSources
        .total,
    ).toMatchObject({ bagQuantity: '31', weightGrams: '501000' });
    await fx.partner(0, [[2, 1, 2]], start);
    await fx.partner(0, [[2, 1, 4]], end);
    const day = await loadInboundStatistics(
      db,
      query({ periodType: 'DAY', month: undefined, date: '2026-09-01', storeId: fx.stores[0]!.id }),
    );
    expect(day.selectedTotal).toMatchObject({ bagQuantity: '1', weightGrams: '2000' });
  });
  it('counts accepted excess and unexpected bags exactly once', async () => {
    await fx.warehouse(0, [
      [0, 4, 8, 1],
      [2, 2, 3.125, 2],
    ]);
    const result = await loadInboundStatistics(db, query({ storeId: fx.stores[0]!.id }));
    expect(result.overviewAllSources.warehouse).toMatchObject({
      bagQuantity: '56',
      weightGrams: '611125',
      bagsComplete: true,
      weightComplete: true,
    });
  });
  it('rejects undeclared unexpected lines and inconsistent excess finalization without changing stock', async () => {
    const draft = await fx.warehouse(0, [[0, 2, 4, 1]], fx.at, 'draft');
    await expect(
      db.insert(storeReceiptLines).values({
        storeReceiptId: draft.id,
        outboundRequestLineId: null,
        productId: fx.products[2]!.id,
        approvedQuantity: 0,
        receivedQuantity: 0,
        excessQuantity: 1,
        pricePerKgVnd: 0n,
      }),
    ).rejects.toThrow();
    await db
      .update(storeReceipts)
      .set({
        unexpectedItems: [{ productId: fx.products[0]!.id, quantity: 2 }],
        finalizedAt: fx.at,
      })
      .where(eq(storeReceipts.id, draft.id));
    await expect(
      db.update(storeReceipts).set({ status: 'finalized' }).where(eq(storeReceipts.id, draft.id)),
    ).rejects.toThrow();
    const line = fx.lines.find((l) => l.storeReceiptId === draft.id)!;
    await db
      .update(storeReceiptLines)
      .set({ excessQuantity: 2 })
      .where(eq(storeReceiptLines.id, line.id));
    await expect(
      db.update(storeReceipts).set({ status: 'finalized' }).where(eq(storeReceipts.id, draft.id)),
    ).rejects.toThrow();
    const [unchanged] = await db.select().from(storeReceipts).where(eq(storeReceipts.id, draft.id));
    expect(unchanged!.status).toBe('draft');
  });
  it('preserves known quantities and flags incomplete legacy partner detail', async () => {
    // Imported historical document with quantity but missing physical detail; no ledger is fabricated.
    const [header] = await db
      .insert(storePartnerInbounds)
      .values({
        referenceCode: `LEGACY-${randomUUID()}`,
        storeId: fx.stores[0]!.id,
        partnerName: 'Legacy import',
        totalQuantity: 2,
        totalWeightKg: '6.000',
        receivedAt: fx.at,
        createdByUserId: fx.admin.id,
      })
      .returning();
    await db
      .insert(storePartnerInboundLines)
      .values({ storePartnerInboundId: header!.id, productId: fx.products[2]!.id, quantity: 2 });
    const result = await loadInboundStatistics(db, query({ storeId: fx.stores[0]!.id }));
    expect(result.overviewAllSources.partner.weightComplete).toBe(false);
    expect(result.overviewAllSources.partner.bagsComplete).toBe(true);
    expect(result.productRows.every((r) => r.weightShareBasisPoints === null)).toBe(true);
  });
  it('uses a single snapshot under concurrent partner receipts and performs no inventory writes', async () => {
    const [before] = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.id, fx.inventory[0]!.id));
    const [report] = await Promise.all([
      loadInboundStatistics(db, query({ storeId: fx.stores[0]!.id })),
      fx.partner(0, [[0, 1, 1]]),
    ]);
    expect(BigInt(report.overviewAllSources.total.bagQuantity)).toBe(
      BigInt(report.overviewAllSources.warehouse.bagQuantity) +
        BigInt(report.overviewAllSources.partner.bagQuantity),
    );
    expect(report.charts.bags.reduce((s, p) => s + BigInt(p.selected.bagQuantity), 0n)).toBe(
      BigInt(report.selectedTotal.bagQuantity),
    );
    const [after] = await db
      .select()
      .from(storeInventoryBags)
      .where(eq(storeInventoryBags.id, fx.inventory[0]!.id));
    expect(after).toEqual(before);
  });
});

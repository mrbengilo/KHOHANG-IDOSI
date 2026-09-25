import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  db,
  createStorePartnerInbound,
  createStoreSorting,
  createSortedSaleTransfer,
  receiveSortedSaleTransfer,
  cancelSortedSaleTransfer,
  listSortedSaleTransfers,
  storeGroups,
  stores,
  users,
  products,
  storeInventoryBags,
  storeSortedStocks,
  sortedSaleTransfers,
  storeSortingEvents,
} from '../src/index.js';
const pg = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
const command = (actorUserId: string) => ({
  actorUserId,
  idempotencyKey: randomUUID(),
  requestHash: randomUUID(),
});
async function fixture() {
  const token = randomUUID().slice(0, 12);
  const [group] = await db
    .insert(storeGroups)
    .values({ code: token, name: 'Transfer test' })
    .returning();
  const [source, destination] = await db
    .insert(stores)
    .values(
      ['source', 'destination'].map((name) => ({ groupId: group!.id, code: token + name, name })),
    )
    .returning();
  const [sender, receiver] = await db
    .insert(users)
    .values(
      [source!, destination!].map((store) => ({
        email: store.id + '@example.invalid',
        displayName: store.name,
        role: 'store' as const,
        status: 'active' as const,
        storeId: store.id,
        passwordHash: 'test-hash-placeholder-long-enough',
      })),
    )
    .returning();
  const [first, second] = await db
    .insert(products)
    .values(
      ['a', 'b'].map((sku) => ({
        sku: token + sku,
        slug: token + sku,
        name: 'Same name',
        unit: 'bag' as const,
      })),
    )
    .returning();
  await createStorePartnerInbound(db, {
    storeId: source!.id,
    requestId: randomUUID(),
    partnerName: 'Test supplier',
    note: null,
    receivedAt: new Date(),
    lines: [first!, second!].map((product) => ({
      productId: product.id,
      quantity: 1,
      bagWeightsKg: ['200.000'],
    })),
    createdByUserId: sender!.id,
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
  });
  const bags = await db
    .select()
    .from(storeInventoryBags)
    .where(eq(storeInventoryBags.storeId, source!.id));
  for (const bag of bags)
    await createStoreSorting(db, {
      storeId: source!.id,
      inventoryBagId: bag.id,
      expectedInventoryVersion: bag.version,
      reason: 'SALE',
      weightKg: '200.000',
      ...command(sender!.id),
    });
  return {
    source: source!,
    destination: destination!,
    sender: sender!,
    receiver: receiver!,
    first: first!,
    second: second!,
  };
}
pg('atomic multi-product Sale documents', () => {
  afterAll(() => closeDatabase());
  it('creates one header, exact weights, source provenance, replay and whole receipt', async () => {
    const f = await fixture();
    const input = {
      sourceStoreId: f.source.id,
      destinationStoreId: f.destination.id,
      note: null,
      lines: [
        { productId: f.first.id, bagWeightsKg: ['30.000', '50.000'] },
        { productId: f.second.id, bagWeightsKg: ['50.001'] },
      ],
      ...command(f.sender.id),
    };
    const created = await createSortedSaleTransfer(db, input);
    expect(created.replayed).toBe(false);
    const replay = await createSortedSaleTransfer(db, input);
    expect(replay.replayed).toBe(true);
    const [document] = await listSortedSaleTransfers(db, [f.source.id]);
    expect(document!.lines).toHaveLength(2);
    expect(document!.createdByDisplayName).toBe('source');
    expect(document!.lines!.reduce((sum, line) => sum + line.bagQuantity, 0)).toBe(3);
    expect(document!.lines!.every((line) => line.sourceLots?.length === 1)).toBe(true);
    const receive = { transferId: document!.id, expectedVersion: 0, ...command(f.receiver.id) };
    const receiveInputs = [receive, { ...receive, ...command(f.receiver.id) }];
    const attempts = await Promise.allSettled(
      receiveInputs.map((input) => receiveSortedSaleTransfer(db, input)),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await receiveSortedSaleTransfer(
          db,
          receiveInputs[attempts.findIndex((result) => result.status === 'fulfilled')]!,
        )
      ).replayed,
    ).toBe(true);
    const credits = await db
      .select()
      .from(storeSortedStocks)
      .where(eq(storeSortedStocks.sourceTransferId, document!.id));
    expect(credits.map((row) => row.saleCreditedWeightKg).sort()).toEqual(['50.001', '80.000']);
    const events = await db
      .select()
      .from(storeSortingEvents)
      .where(
        and(
          eq(storeSortingEvents.storeId, f.destination.id),
          eq(storeSortingEvents.action, 'sale_transfer_in'),
        ),
      );
    expect(events).toHaveLength(2);
  });
  it('paginates whole headers and cancels all products exactly once', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++)
      await createSortedSaleTransfer(db, {
        sourceStoreId: f.source.id,
        destinationStoreId: f.destination.id,
        note: null,
        lines: [
          { productId: f.first.id, bagWeightsKg: ['10.001'] },
          { productId: f.second.id, bagWeightsKg: ['20.000'] },
        ],
        ...command(f.sender.id),
      });
    const firstPage = await listSortedSaleTransfers(db, [f.source.id], 500, {
      page: 1,
      pageSize: 2,
    });
    expect(firstPage).toHaveLength(3); // One lookahead header for hasMore.
    expect(firstPage.every((row) => row.lines?.length === 2)).toBe(true);
    const secondPage = await listSortedSaleTransfers(db, [f.source.id], 500, {
      page: 2,
      pageSize: 2,
    });
    expect(secondPage.map((row) => row.id)).toEqual([firstPage[2]!.id]);
    const input = {
      transferId: firstPage[0]!.id,
      expectedVersion: 0,
      reason: 'Return complete document',
      ...command(f.sender.id),
    };
    expect((await cancelSortedSaleTransfer(db, input)).replayed).toBe(false);
    expect((await cancelSortedSaleTransfer(db, input)).replayed).toBe(true);
    await expect(
      receiveSortedSaleTransfer(db, {
        transferId: input.transferId,
        expectedVersion: 0,
        ...command(f.receiver.id),
      }),
    ).rejects.toThrow();
    const credits = await db
      .select()
      .from(storeSortedStocks)
      .where(eq(storeSortedStocks.sourceTransferId, input.transferId));
    expect(credits).toHaveLength(2);
    expect(credits.every((row) => row.storeId === f.source.id)).toBe(true);
    expect(credits.map((row) => row.saleCreditedWeightKg).sort()).toEqual(['10.001', '20.000']);
  });
  it('rolls back every line and ledger when a later product is short', async () => {
    const f = await fixture();
    const sorted = [f.first, f.second].sort((a, b) => a.id.localeCompare(b.id));
    await expect(
      createSortedSaleTransfer(db, {
        sourceStoreId: f.source.id,
        destinationStoreId: f.destination.id,
        note: null,
        lines: [
          { productId: sorted[0]!.id, bagWeightsKg: ['10.000'] },
          { productId: sorted[1]!.id, bagWeightsKg: ['201.000'] },
        ],
        ...command(f.sender.id),
      }),
    ).rejects.toThrow();
    expect(await listSortedSaleTransfers(db, [f.source.id])).toHaveLength(0);
    const stocks = await db
      .select()
      .from(storeSortedStocks)
      .where(eq(storeSortedStocks.storeId, f.source.id));
    expect(stocks.map((row) => row.saleWeightKg)).toEqual(['200.000', '200.000']);
    const events = await db
      .select()
      .from(storeSortingEvents)
      .where(
        and(
          eq(storeSortingEvents.storeId, f.source.id),
          eq(storeSortingEvents.action, 'sale_transfer_out'),
        ),
      );
    expect(events).toHaveLength(0);
  });
  it('serializes competing dispatches and receive versus cancel', async () => {
    const f = await fixture();
    const input = {
      sourceStoreId: f.source.id,
      destinationStoreId: f.destination.id,
      note: null,
      lines: [
        { productId: f.first.id, bagWeightsKg: ['150.000'] },
        { productId: f.second.id, bagWeightsKg: ['150.000'] },
      ],
    };
    const results = await Promise.allSettled([
      createSortedSaleTransfer(db, { ...input, ...command(f.sender.id) }),
      createSortedSaleTransfer(db, { ...input, ...command(f.sender.id) }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [document] = await listSortedSaleTransfers(db, [f.source.id]);
    const settled = await Promise.allSettled([
      receiveSortedSaleTransfer(db, {
        transferId: document!.id,
        expectedVersion: 0,
        ...command(f.receiver.id),
      }),
      cancelSortedSaleTransfer(db, {
        transferId: document!.id,
        expectedVersion: 0,
        reason: 'Test cancellation',
        ...command(f.sender.id),
      }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const credits = await db
      .select()
      .from(storeSortedStocks)
      .where(eq(storeSortedStocks.sourceTransferId, document!.id));
    expect(credits).toHaveLength(2);
    expect(new Set(credits.map((row) => row.storeId)).size).toBe(1);
    const [header] = await db
      .select()
      .from(sortedSaleTransfers)
      .where(eq(sortedSaleTransfers.id, document!.id));
    expect(header!.version).toBe(1);
  });
  it('blocks an older writer from crediting only one line and retains legacy identity', async () => {
    const f = await fixture();
    await createSortedSaleTransfer(db, {
      sourceStoreId: f.source.id,
      destinationStoreId: f.destination.id,
      note: null,
      lines: [
        { productId: f.first.id, bagWeightsKg: ['30.000'] },
        { productId: f.second.id, bagWeightsKg: ['50.000'] },
      ],
      ...command(f.sender.id),
    });
    const [document] = await listSortedSaleTransfers(db, [f.source.id]);
    await expect(
      db.transaction(async (tx) => {
        const [stock] = await tx
          .insert(storeSortedStocks)
          .values({
            storeId: f.destination.id,
            productId: document!.productId,
            sourceTransferId: document!.id,
            saleCreditedWeightKg: document!.weightKg,
            saleWeightKg: document!.weightKg,
          })
          .returning();
        await tx
          .update(sortedSaleTransfers)
          .set({
            status: 'received',
            destinationStockId: stock!.id,
            receivedByUserId: f.receiver.id,
            receivedAt: new Date(),
            version: 1,
          })
          .where(eq(sortedSaleTransfers.id, document!.id));
      }),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(storeSortedStocks)
        .where(eq(storeSortedStocks.sourceTransferId, document!.id)),
    ).toHaveLength(0);
    await db
      .update(users)
      .set({ displayName: 'Renamed inactive sender', status: 'disabled' })
      .where(eq(users.id, f.sender.id));
    const [projected] = await listSortedSaleTransfers(db, [f.source.id], 500, {
      page: 1,
      pageSize: 1,
    });
    expect(projected!.createdByDisplayName).toBe('Renamed inactive sender');
    expect(projected!.id).toBe(document!.id);
    // A pre-migration document has no lines. Its scalar evidence remains authoritative.
    await db
      .update(sortedSaleTransfers)
      .set({ lines: null, bagWeightsKg: null, enteredWeightKg: null })
      .where(eq(sortedSaleTransfers.id, document!.id));
    const [legacy] = await listSortedSaleTransfers(db, [f.source.id]);
    expect(legacy!.transferNumber).toBe(document!.transferNumber);
    expect(legacy!.bagWeightsKg).toBeNull();
  });
});
